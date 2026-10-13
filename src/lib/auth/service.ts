// ============================================================
// Authentication service — the logic behind /api/auth/*, the auth
// callback and the CLI. Replaces Supabase Auth (GoTrue).
//
// Errors are returned as `AuthFailure` with GoTrue-compatible codes
// (`invalid_credentials`, `email_not_confirmed`, ...) so existing UI
// handling keeps working; messages are localised.
//
// Server-only.
// ============================================================

import { withRole } from "@/lib/db/tx";
import type { User } from "@/lib/db/types";
import { hashInviteToken } from "@/lib/auth/invitations";
import { getT } from "@/lib/i18n/translate";
import { publicBaseUrl } from "@/lib/storage/public-url";
import { isMailEnabled, sendAuthEmail } from "./mailer";
import { dummyVerify, hashPassword, validatePasswordStrength, verifyPassword } from "./password";
import { createSession, invalidateUserCache, revokeAllSessions } from "./session";
import { consumeToken, issueToken, type OneTimeTokenType } from "./tokens";
import { isBlocked, normalizeEmail, toUser, USER_COLUMNS, type AuthUserRow } from "./users";

const t = getT("Auth.errors");

export class AuthFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthFailure";
  }
}

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

async function findUserByEmail(email: string): Promise<AuthUserRow | null> {
  return withRole("service_role", null, async (c) => {
    const r = await c.query<AuthUserRow>(`SELECT ${USER_COLUMNS} FROM auth.users u WHERE lower(u.email) = $1`, [email]);
    return r.rows[0] ?? null;
  });
}

export async function findUserById(id: string): Promise<AuthUserRow | null> {
  return withRole("service_role", null, async (c) => {
    const r = await c.query<AuthUserRow>(`SELECT ${USER_COLUMNS} FROM auth.users u WHERE u.id = $1`, [id]);
    return r.rows[0] ?? null;
  });
}

/** Absolute link to the auth callback, which consumes `token` and forwards to `next`. */
export function callbackLink(type: OneTimeTokenType, token: string, next: string, base = publicBaseUrl()): string {
  const u = new URL("/auth/callback", base);
  u.searchParams.set("type", type);
  u.searchParams.set("token", token);
  u.searchParams.set("next", next);
  return u.toString();
}

/** `next` path from an absolute or relative redirect URL (same-origin paths only). */
export function nextFromRedirect(redirectTo: string | undefined, fallback: string): string {
  if (!redirectTo) return fallback;
  try {
    const u = new URL(redirectTo, "http://placeholder");
    // Our pages pass `/auth/callback?next=/x` — unwrap it.
    if (u.pathname === "/auth/callback") return u.searchParams.get("next") ?? fallback;
    return `${u.pathname}${u.search}`;
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------
// Sign up
// ------------------------------------------------------------

async function signupsAllowed(inviteToken?: string | null): Promise<boolean> {
  if ((process.env.ALLOW_SIGNUPS ?? "true").toLowerCase() !== "false") return true;
  return withRole("service_role", null, async (c) => {
    // The very first user can always sign up (fresh install).
    const any = await c.query("SELECT 1 FROM auth.users LIMIT 1");
    if (any.rowCount === 0) return true;
    if (!inviteToken) return false;
    const inv = await c.query(
      `SELECT 1 FROM public.account_invitations
        WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [hashInviteToken(inviteToken)],
    );
    return (inv.rowCount ?? 0) > 0;
  });
}

export interface SignUpInput {
  email: unknown;
  password: unknown;
  fullName?: unknown;
  /** Where the confirmation link should land (when SMTP is on). */
  redirectTo?: string;
  inviteToken?: string | null;
}

export async function signUp(
  input: SignUpInput,
  meta: SessionMeta,
): Promise<{ user: User; session: IssuedSession | null }> {
  const email = normalizeEmail(input.email);
  if (!email) throw new AuthFailure("validation_failed", 400, t("invalidEmail"));
  const weak = validatePasswordStrength(input.password);
  if (weak) throw new AuthFailure("weak_password", 422, t("weakPassword"));
  if (!(await signupsAllowed(input.inviteToken))) {
    throw new AuthFailure("signup_disabled", 403, t("signupDisabled"));
  }

  const fullName = typeof input.fullName === "string" ? input.fullName.trim().slice(0, 200) : "";
  const passwordHash = await hashPassword(input.password as string);
  const confirmNow = !isMailEnabled();

  const row = await withRole("service_role", null, async (c) => {
    const exists = await c.query("SELECT 1 FROM auth.users WHERE lower(email) = $1", [email]);
    if (exists.rowCount) throw new AuthFailure("user_already_exists", 422, t("userExists"));
    const r = await c.query<AuthUserRow>(
      `INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, created_at, last_sign_in_at`,
      [email, passwordHash, JSON.stringify({ full_name: fullName }), confirmNow ? new Date() : null],
    );
    // handle_new_user (migration 017) swallows its own errors; make
    // sure it actually produced the account + owner profile.
    const p = await c.query("SELECT 1 FROM public.profiles WHERE user_id = $1 AND account_id IS NOT NULL", [r.rows[0].id]);
    if (!p.rowCount) throw new AuthFailure("unexpected_failure", 500, t("signupFailed"));
    return r.rows[0];
  });

  const user = toUser(row);
  if (confirmNow) {
    return { user, session: await createSession(user.id, meta) };
  }
  const token = await issueToken(user.id, "signup_confirm");
  await sendAuthEmail("signupConfirm", email, callbackLink("signup_confirm", token, nextFromRedirect(input.redirectTo, "/dashboard")));
  return { user, session: null };
}

// ------------------------------------------------------------
// Sign in
// ------------------------------------------------------------

export async function signInWithPassword(
  emailInput: unknown,
  password: unknown,
  meta: SessionMeta,
): Promise<{ user: User; session: IssuedSession }> {
  const email = normalizeEmail(emailInput);
  if (!email || typeof password !== "string" || password.length > 1024) {
    await dummyVerify(typeof password === "string" ? password.slice(0, 64) : "");
    throw new AuthFailure("invalid_credentials", 400, t("invalidCredentials"));
  }
  const row = await findUserByEmail(email);
  if (!row || isBlocked(row)) {
    await dummyVerify(password);
    throw new AuthFailure("invalid_credentials", 400, t("invalidCredentials"));
  }
  const result = await verifyPassword(password, row.encrypted_password);
  if (!result.ok) throw new AuthFailure("invalid_credentials", 400, t("invalidCredentials"));
  if (!row.email_confirmed_at) throw new AuthFailure("email_not_confirmed", 400, t("emailNotConfirmed"));

  if (result.needsRehash) {
    const upgraded = await hashPassword(password);
    await withRole("service_role", null, (c) =>
      c.query("UPDATE auth.users SET encrypted_password = $2, updated_at = now() WHERE id = $1", [row.id, upgraded]),
    );
  }
  return { user: toUser(row), session: await createSession(row.id, meta) };
}

// ------------------------------------------------------------
// Password reset
// ------------------------------------------------------------

/** Always resolves (no account enumeration). Sends mail only when SMTP is on. */
export async function requestPasswordReset(emailInput: unknown, redirectTo?: string): Promise<{ mailed: boolean }> {
  const email = normalizeEmail(emailInput);
  if (!email || !isMailEnabled()) return { mailed: false };
  const row = await findUserByEmail(email);
  if (!row || isBlocked(row)) return { mailed: true };
  const token = await issueToken(row.id, "recovery");
  await sendAuthEmail("recovery", email, callbackLink("recovery", token, nextFromRedirect(redirectTo, "/reset-password")));
  return { mailed: true };
}

/** Admin / CLI path when SMTP is off: a single-use reset link. */
export async function generateRecoveryLink(userId: string, base?: string): Promise<string> {
  const token = await issueToken(userId, "recovery");
  return callbackLink("recovery", token, "/reset-password", base);
}

// ------------------------------------------------------------
// Callback (emailed / generated links)
// ------------------------------------------------------------

export async function consumeLink(
  type: OneTimeTokenType,
  token: string,
  meta: SessionMeta,
): Promise<IssuedSession> {
  const consumed = await consumeToken(token, type);
  if (!consumed) throw new AuthFailure("otp_expired", 400, t("linkInvalid"));

  if (type === "signup_confirm") {
    await withRole("service_role", null, (c) =>
      c.query("UPDATE auth.users SET email_confirmed_at = COALESCE(email_confirmed_at, now()) WHERE id = $1", [
        consumed.userId,
      ]),
    );
  } else if (type === "email_change" && consumed.newEmail) {
    await withRole("service_role", null, (c) =>
      c.query("UPDATE auth.users SET email = $2, email_confirmed_at = now(), updated_at = now() WHERE id = $1", [
        consumed.userId,
        consumed.newEmail,
      ]),
    );
    invalidateUserCache(consumed.userId);
  } else if (type === "recovery") {
    // Clicking a reset link proves control of the inbox.
    await withRole("service_role", null, (c) =>
      c.query("UPDATE auth.users SET email_confirmed_at = COALESCE(email_confirmed_at, now()) WHERE id = $1", [
        consumed.userId,
      ]),
    );
  }
  return createSession(consumed.userId, meta);
}

// ------------------------------------------------------------
// Update the signed-in user
// ------------------------------------------------------------

export interface UpdateUserInput {
  email?: unknown;
  password?: unknown;
  data?: unknown;
}

export async function updateUser(
  userId: string,
  sessionId: string,
  input: UpdateUserInput,
): Promise<{ user: User; emailChangePending: boolean }> {
  let emailChangePending = false;

  if (input.password !== undefined) {
    const weak = validatePasswordStrength(input.password);
    if (weak) throw new AuthFailure("weak_password", 422, t("weakPassword"));
    const current = await findUserById(userId);
    if (current?.encrypted_password && (await verifyPassword(input.password as string, current.encrypted_password)).ok) {
      throw new AuthFailure("same_password", 422, t("samePassword"));
    }
    const hash = await hashPassword(input.password as string);
    await withRole("service_role", null, (c) =>
      c.query("UPDATE auth.users SET encrypted_password = $2, updated_at = now() WHERE id = $1", [userId, hash]),
    );
    // A password change signs out every other device.
    await revokeAllSessions(userId, sessionId);
  }

  if (input.data !== undefined) {
    if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) {
      throw new AuthFailure("validation_failed", 400, t("invalidData"));
    }
    await withRole("service_role", null, (c) =>
      c.query(
        "UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data || $2::jsonb, updated_at = now() WHERE id = $1",
        [userId, JSON.stringify(input.data)],
      ),
    );
  }

  if (input.email !== undefined) {
    const email = normalizeEmail(input.email);
    if (!email) throw new AuthFailure("validation_failed", 400, t("invalidEmail"));
    const current = await findUserById(userId);
    if (current && current.email?.toLowerCase() !== email) {
      const taken = await findUserByEmail(email);
      if (taken && taken.id !== userId) throw new AuthFailure("email_exists", 422, t("userExists"));
      if (isMailEnabled()) {
        const token = await issueToken(userId, "email_change", email);
        await sendAuthEmail("emailChange", email, callbackLink("email_change", token, "/settings"));
        emailChangePending = true;
      } else {
        await withRole("service_role", null, (c) =>
          c.query("UPDATE auth.users SET email = $2, updated_at = now() WHERE id = $1", [userId, email]),
        );
      }
    }
  }

  invalidateUserCache(userId);
  const row = await findUserById(userId);
  if (!row) throw new AuthFailure("user_not_found", 404, t("sessionMissing"));
  return { user: toUser(row), emailChangePending };
}
