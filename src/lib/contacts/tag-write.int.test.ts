// addContactTagIfAbsent / removeContactTag against real Postgres:
// idempotent inserts (ON CONFLICT, no aborted transaction), account
// scoping, and RLS for a viewer.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addContactTagIfAbsent, removeContactTag } from "@/lib/contacts/tag-write";
import { asService, asUser } from "@/server/db";
import {
  joinAccount,
  seedUser,
  teardownIntegrationDb,
  useIntegrationDb,
  type SeededUser,
} from "@/test/integration/helpers";

let owner: SeededUser;
let other: SeededUser;
let viewer: SeededUser;
let contactId: string;
let tagId: string;
let foreignTagId: string;

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  other = await seedUser("Other");
  viewer = await seedUser("Viewer");
  await joinAccount(viewer.id, owner.accountId, "viewer");
  ({ contactId, tagId, foreignTagId } = await asService(async (db) => {
    const c = await db
      .insertInto("contacts")
      .values({ account_id: owner.accountId, user_id: owner.id, phone: "+15550100" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const t = await db
      .insertInto("tags")
      .values({ account_id: owner.accountId, user_id: owner.id, name: "VIP" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const f = await db
      .insertInto("tags")
      .values({ account_id: other.accountId, user_id: other.id, name: "Theirs" })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { contactId: c.id, tagId: t.id, foreignTagId: f.id };
  }));
});

afterAll(teardownIntegrationDb);

const input = () => ({ accountId: owner.accountId, contactId, tagId });

describe("addContactTagIfAbsent", () => {
  it("inserts once, then reports duplicates without failing the transaction", async () => {
    const result = await asUser(owner.id, async (db) => {
      const first = await addContactTagIfAbsent(db, input());
      const second = await addContactTagIfAbsent(db, input());
      // Still usable after the duplicate — nothing aborted the tx.
      const count = await db
        .selectFrom("contact_tags")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("contact_id", "=", contactId)
        .executeTakeFirstOrThrow();
      return { first, second, n: Number(count.n) };
    });
    expect(result).toEqual({ first: true, second: false, n: 1 });
  });

  it("refuses contacts and tags outside the account with 404", async () => {
    await expect(
      asUser(owner.id, (db) => addContactTagIfAbsent(db, { ...input(), tagId: foreignTagId })),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      asService((db) => addContactTagIfAbsent(db, { ...input(), accountId: other.accountId })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("is denied by RLS for a viewer", async () => {
    await asUser(owner.id, (db) => removeContactTag(db, input()));
    await expect(asUser(viewer.id, (db) => addContactTagIfAbsent(db, input()))).rejects.toMatchObject({
      code: "42501",
    });
  });
});
