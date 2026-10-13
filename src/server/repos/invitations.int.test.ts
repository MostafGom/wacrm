// Invitations repository + peek/redeem RPCs (migration 019) against real Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashInviteToken } from "@/lib/auth/invitations";
import { asAnon, asUser } from "@/server/db";
import { pgCode } from "@/server/db/errors";
import {
  createInvitation,
  deleteInvitation,
  listPendingInvitations,
  peekInvitation,
  redeemInvitation,
} from "@/server/repos/invitations";
import {
  seedUser,
  teardownIntegrationDb,
  useIntegrationDb,
  withSuperuser,
  type SeededUser,
} from "@/test/integration/helpers";

let owner: SeededUser;
let joiner: SeededUser;
let outsider: SeededUser;

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  joiner = await seedUser("Joiner");
  outsider = await seedUser("Outsider");
});

afterAll(teardownIntegrationDb);

describe("invitations repo", () => {
  it("creates and lists pending invites (expired / accepted ones hidden)", async () => {
    const created = await asUser(owner.id, (db) =>
      createInvitation(db, {
        account_id: owner.accountId,
        token_hash: hashInviteToken("tok-pending"),
        role: "agent",
        created_by_user_id: owner.id,
        label: "Sales",
        expires_at: inDays(7),
      }),
    );
    expect(created).toMatchObject({ role: "agent", label: "Sales" });
    expect(Object.keys(created).sort()).toEqual(["created_at", "expires_at", "id", "label", "role"]);

    await withSuperuser((c) =>
      c.query(
        `INSERT INTO public.account_invitations (account_id, token_hash, role, expires_at)
         VALUES ($1, $2, 'viewer', now() - interval '1 day')`,
        [owner.accountId, hashInviteToken("tok-expired")],
      ),
    );

    const rows = await asUser(owner.id, (db) => listPendingInvitations(db, owner.accountId));
    expect(rows.map((r) => r.id)).toEqual([created.id]);
    expect(rows[0]).not.toHaveProperty("token_hash");
  });

  it("peek works anonymously and never needs a session", async () => {
    const ok = (await asAnon((db) => peekInvitation(db, hashInviteToken("tok-pending")))) as Record<string, unknown>;
    expect(ok).toMatchObject({ ok: true, role: "agent" });
    expect(await asAnon((db) => peekInvitation(db, hashInviteToken("tok-expired")))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await asAnon((db) => peekInvitation(db, hashInviteToken("nope")))).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("redeem moves the caller in; refusals carry the SQLSTATE the route maps", async () => {
    const accountId = await asUser(joiner.id, (db) => redeemInvitation(db, hashInviteToken("tok-pending")));
    expect(accountId).toBe(owner.accountId);

    const used = await asUser(outsider.id, (db) => redeemInvitation(db, hashInviteToken("tok-pending"))).catch(
      (e: unknown) => e,
    );
    expect(pgCode(used)).toBe("22023");
    const missing = await asUser(outsider.id, (db) => redeemInvitation(db, hashInviteToken("nope"))).catch(
      (e: unknown) => e,
    );
    expect(pgCode(missing)).toBe("22023");
  });

  it("delete is scoped to the caller's account", async () => {
    const inv = await asUser(owner.id, (db) =>
      createInvitation(db, {
        account_id: owner.accountId,
        token_hash: hashInviteToken("tok-delete"),
        role: "viewer",
        created_by_user_id: owner.id,
        label: null,
        expires_at: inDays(1),
      }),
    );
    expect(await asUser(outsider.id, (db) => deleteInvitation(db, outsider.accountId, inv.id))).toBe(false);
    expect(await asUser(owner.id, (db) => deleteInvitation(db, owner.accountId, inv.id))).toBe(true);
    expect(await asUser(owner.id, (db) => deleteInvitation(db, owner.accountId, inv.id))).toBe(false);
  });
});
