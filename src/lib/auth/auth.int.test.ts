// Auth service against a real database: signup bootstraps an account,
// login / sessions / revocation, imported bcrypt hashes, reset links.

import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AuthFailure,
  consumeLink,
  generateRecoveryLink,
  signInWithPassword,
  signUp,
  updateUser,
} from "@/lib/auth/service";
import { revokeAllSessions, validateSession } from "@/lib/auth/session";
import { teardownIntegrationDb, useIntegrationDb, withSuperuser } from "@/test/integration/helpers";

const meta = { userAgent: "vitest", ip: "127.0.0.1" };

beforeAll(() => {
  useIntegrationDb();
  delete process.env.SMTP_URL;
  delete process.env.ALLOW_SIGNUPS;
});
afterAll(teardownIntegrationDb);

describe("signUp", () => {
  it("creates the user, an owned account and a session (no SMTP)", async () => {
    const { user, session } = await signUp({ email: "New@Example.test", password: "secret123", fullName: "Nia" }, meta);
    expect(user.email).toBe("new@example.test");
    expect(user.user_metadata.full_name).toBe("Nia");
    expect(session).not.toBeNull();

    const valid = await validateSession(session!.token);
    expect(valid?.user.id).toBe(user.id);

    const profile = await withSuperuser(async (c) =>
      (await c.query("SELECT account_role, account_id FROM public.profiles WHERE user_id = $1", [user.id])).rows[0],
    );
    expect(profile.account_role).toBe("owner");
    expect(profile.account_id).toBeTruthy();
  });

  it("rejects duplicates (case-insensitive), weak passwords and bad emails", async () => {
    await expect(signUp({ email: "new@example.test", password: "secret123" }, meta)).rejects.toMatchObject({
      code: "user_already_exists",
    });
    await expect(signUp({ email: "x@example.test", password: "123" }, meta)).rejects.toMatchObject({
      code: "weak_password",
    });
    await expect(signUp({ email: "nope", password: "secret123" }, meta)).rejects.toBeInstanceOf(AuthFailure);
  });

  it("honours ALLOW_SIGNUPS=false once a user exists", async () => {
    process.env.ALLOW_SIGNUPS = "false";
    try {
      await expect(signUp({ email: "late@example.test", password: "secret123" }, meta)).rejects.toMatchObject({
        code: "signup_disabled",
      });
    } finally {
      delete process.env.ALLOW_SIGNUPS;
    }
  });
});

describe("signInWithPassword", () => {
  it("logs in and rejects a wrong password with a generic error", async () => {
    const ok = await signInWithPassword("new@example.test", "secret123", meta);
    expect(ok.user.email).toBe("new@example.test");
    await expect(signInWithPassword("new@example.test", "wrong-pass", meta)).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    await expect(signInWithPassword("ghost@example.test", "secret123", meta)).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });

  it("accepts an imported Supabase bcrypt hash and upgrades it to scrypt", async () => {
    const hash = await bcrypt.hash("legacy-pass", 10);
    await withSuperuser((c) =>
      c.query(
        "INSERT INTO auth.users (email, encrypted_password, email_confirmed_at, raw_user_meta_data) VALUES ($1, $2, now(), '{}')",
        ["legacy@example.test", hash],
      ),
    );
    await signInWithPassword("legacy@example.test", "legacy-pass", meta);
    const stored = await withSuperuser(async (c) =>
      (await c.query("SELECT encrypted_password FROM auth.users WHERE email = $1", ["legacy@example.test"])).rows[0]
        .encrypted_password as string,
    );
    expect(stored.startsWith("scrypt$")).toBe(true);
    // Still works after the upgrade.
    await signInWithPassword("legacy@example.test", "legacy-pass", meta);
  });

  it("refuses unconfirmed and banned users", async () => {
    await withSuperuser((c) =>
      c.query(
        `INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data, banned_until)
         VALUES ('unconf@example.test', $1, '{}', NULL), ('banned@example.test', $1, '{}', now() + interval '1 day')`,
        ["$2a$10$abcdefghijklmnopqrstuuSmjK5i0Fp5x2J8G8rmYSZz1mH0cUVRe"],
      ),
    );
    const h = await bcrypt.hash("pw-123456", 4);
    await withSuperuser((c) =>
      c.query("UPDATE auth.users SET encrypted_password = $1 WHERE email IN ('unconf@example.test','banned@example.test')", [h]),
    );
    await expect(signInWithPassword("unconf@example.test", "pw-123456", meta)).rejects.toMatchObject({
      code: "email_not_confirmed",
    });
    await expect(signInWithPassword("banned@example.test", "pw-123456", meta)).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });
});

describe("sessions and recovery", () => {
  it("global sign-out revokes every session", async () => {
    const a = await signInWithPassword("new@example.test", "secret123", meta);
    const b = await signInWithPassword("new@example.test", "secret123", meta);
    await revokeAllSessions(a.user.id);
    expect(await validateSession(a.session.token)).toBeNull();
    expect(await validateSession(b.session.token)).toBeNull();
  });

  it("a recovery link is single-use and yields a session that can set a new password", async () => {
    const { user } = await signInWithPassword("new@example.test", "secret123", meta);
    const link = new URL(await generateRecoveryLink(user.id, "https://crm.example.test"));
    expect(link.pathname).toBe("/auth/callback");
    const token = link.searchParams.get("token")!;

    const session = await consumeLink("recovery", token, meta);
    await expect(consumeLink("recovery", token, meta)).rejects.toMatchObject({ code: "otp_expired" });

    const valid = await validateSession(session.token);
    await updateUser(user.id, valid!.sessionId, { password: "brand-new-1" });
    await signInWithPassword("new@example.test", "brand-new-1", meta);
    await expect(signInWithPassword("new@example.test", "secret123", meta)).rejects.toBeInstanceOf(AuthFailure);
  });

  it("changing the email (no SMTP) applies immediately and syncs profiles.email", async () => {
    const { user, session } = await signInWithPassword("new@example.test", "brand-new-1", meta);
    const valid = await validateSession(session.token);
    const res = await updateUser(user.id, valid!.sessionId, { email: "renamed@example.test" });
    expect(res.user.email).toBe("renamed@example.test");
    const email = await withSuperuser(async (c) =>
      (await c.query("SELECT email FROM public.profiles WHERE user_id = $1", [user.id])).rows[0].email,
    );
    expect(email).toBe("renamed@example.test");
  });
});
