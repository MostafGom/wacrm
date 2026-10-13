// Account rename + own-profile update against real Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser } from "@/server/db";
import { renameAccount, updateOwnProfile } from "@/server/repos/account";
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

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  agent = await seedUser("Agent");
  await joinAccount(agent.id, owner.accountId, "agent");
});

afterAll(teardownIntegrationDb);

describe("account repo", () => {
  it("renames the account (admin+ under RLS)", async () => {
    expect(await asUser(owner.id, (db) => renameAccount(db, owner.accountId, "Acme"))).toEqual({
      id: owner.accountId,
      name: "Acme",
    });
    // An agent's update matches no row under the accounts_update policy.
    expect(await asUser(agent.id, (db) => renameAccount(db, owner.accountId, "Hijack"))).toBeUndefined();
  });

  it("updates only the caller's own profile", async () => {
    expect(
      await asUser(agent.id, (db) =>
        updateOwnProfile(db, agent.id, { full_name: "Agent Smith", avatar_url: "https://x.test/a.png" }),
      ),
    ).toBe(true);
    // Trying to edit someone else's row matches nothing.
    expect(
      await asUser(agent.id, (db) => updateOwnProfile(db, owner.id, { full_name: "Nope", avatar_url: null })),
    ).toBe(false);
    const rows = await withSuperuser(async (c) =>
      (await c.query("SELECT user_id, full_name, avatar_url FROM public.profiles WHERE user_id = ANY($1)", [
        [owner.id, agent.id],
      ])).rows,
    );
    expect(rows.find((r) => r.user_id === agent.id)).toMatchObject({
      full_name: "Agent Smith",
      avatar_url: "https://x.test/a.png",
    });
    expect(rows.find((r) => r.user_id === owner.id)?.full_name).toBe("Owner");
  });
});
