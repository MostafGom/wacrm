// Members repository + the membership RPCs (migration 018) against
// real Postgres, including the SQLSTATE → HTTP mapping.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser } from "@/server/db";
import {
  isMemberOfAccount,
  listMembers,
  membershipRpcError,
  removeAccountMember,
  setMemberRole,
  transferAccountOwnership,
} from "@/server/repos/members";
import {
  joinAccount,
  seedUser,
  teardownIntegrationDb,
  useIntegrationDb,
  withSuperuser,
  type SeededUser,
} from "@/test/integration/helpers";

let owner: SeededUser;
let agent: SeededUser;
let viewer: SeededUser;
let outsider: SeededUser;

async function roleOf(userId: string): Promise<{ account_id: string; account_role: string }> {
  return withSuperuser(async (c) => {
    const r = await c.query("SELECT account_id, account_role FROM public.profiles WHERE user_id = $1", [userId]);
    return r.rows[0];
  });
}

async function rpcFailure(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).not.toBeNull();
  return membershipRpcError(err);
}

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  agent = await seedUser("Agent");
  viewer = await seedUser("Viewer");
  outsider = await seedUser("Outsider");
  await joinAccount(agent.id, owner.accountId, "agent");
  await joinAccount(viewer.id, owner.accountId, "viewer");
  // Like redeem_invitation, drop the joiners' now-empty personal
  // accounts (one account per owner is a unique index; the RPCs
  // create a fresh one for a removed member / promoted owner).
  await withSuperuser((c) => c.query("DELETE FROM public.accounts WHERE id = ANY($1)", [[agent.accountId, viewer.accountId]]));
});

afterAll(teardownIntegrationDb);

describe("members repo", () => {
  it("lists the account's members oldest first, scoped to the account", async () => {
    const rows = await asUser(agent.id, (db) => listMembers(db, owner.accountId));
    expect(rows.map((r) => r.user_id)).toEqual([owner.id, agent.id, viewer.id]);
    expect(rows[0].account_role).toBe("owner");
    // The outsider can't read another account's roster (RLS).
    expect(await asUser(outsider.id, (db) => listMembers(db, owner.accountId))).toEqual([]);
  });

  it("isMemberOfAccount checks the account explicitly", async () => {
    expect(await asUser(owner.id, (db) => isMemberOfAccount(db, owner.accountId, agent.id))).toBe(true);
    expect(await asUser(owner.id, (db) => isMemberOfAccount(db, owner.accountId, outsider.id))).toBe(false);
  });

  it("set_member_role: admin+ changes a role; refusals map to 403 / 400", async () => {
    await asUser(owner.id, (db) => setMemberRole(db, viewer.id, "agent"));
    expect((await roleOf(viewer.id)).account_role).toBe("agent");

    // Agent below admin → 42501 → 403.
    expect(await rpcFailure(asUser(agent.id, (db) => setMemberRole(db, viewer.id, "viewer")))).toEqual({
      status: 403,
      message: "This action requires the admin role or higher",
    });
    // Own role → 22023 → 400.
    expect(await rpcFailure(asUser(owner.id, (db) => setMemberRole(db, owner.id, "admin")))).toEqual({
      status: 400,
      message: "Cannot change your own role",
    });
    // Someone in another account → 403.
    expect((await rpcFailure(asUser(owner.id, (db) => setMemberRole(db, outsider.id, "agent"))))?.status).toBe(403);
  });

  it("transfer_account_ownership: owner hands the account over", async () => {
    expect((await rpcFailure(asUser(agent.id, (db) => transferAccountOwnership(db, agent.id))))?.status).toBe(403);
    await asUser(owner.id, (db) => transferAccountOwnership(db, agent.id));
    expect((await roleOf(agent.id)).account_role).toBe("owner");
    expect((await roleOf(owner.id)).account_role).toBe("admin");
  });

  it("remove_account_member: moves the member into a fresh personal account", async () => {
    const newAccountId = await asUser(owner.id, (db) => removeAccountMember(db, viewer.id));
    expect(newAccountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await roleOf(viewer.id)).toEqual({ account_id: newAccountId, account_role: "owner" });
    // Removing the (new) owner is refused with 22023 → 400.
    expect((await rpcFailure(asUser(owner.id, (db) => removeAccountMember(db, agent.id))))?.status).toBe(400);
  });

  it("returns null for errors that aren't membership refusals", () => {
    expect(membershipRpcError(new Error("boom"))).toBeNull();
  });
});
