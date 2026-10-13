// Contacts repository + import service against real Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, userRunner } from "@/server/db";
import {
  getContactWithTags,
  insertContact,
  listContactsKeyset,
  listContactsPage,
  tagIdsForContacts,
} from "@/server/repos/contacts";
import { importContacts } from "@/server/services/contacts-import";
import { seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let owner: SeededUser;
let other: SeededUser;
let vipTag: string;

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  other = await seedUser("Other");
  vipTag = await asUser(owner.id, async (db) => {
    const tag = await db
      .insertInto("tags")
      .values({ account_id: owner.accountId, user_id: owner.id, name: "VIP" })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (const [name, phone] of [
      ["Alice", "+15550001"],
      ["Bob", "+15550002"],
      ["Carol", "+15550003"],
    ]) {
      const c = await insertContact(db, { account_id: owner.accountId, user_id: owner.id, phone, name });
      if (name !== "Bob") await db.insertInto("contact_tags").values({ contact_id: c!.id, tag_id: tag.id }).execute();
    }
    return tag.id;
  });
});

afterAll(teardownIntegrationDb);

describe("contacts repo", () => {
  it("pages with total, search and tag filter (via filter_contacts_by_tags)", async () => {
    await asUser(owner.id, async (db) => {
      const all = await listContactsPage(db, owner.accountId, { offset: 0, limit: 2 });
      expect(all.total).toBe(3);
      expect(all.contacts).toHaveLength(2);

      const search = await listContactsPage(db, owner.accountId, { offset: 0, limit: 25, search: "bo" });
      expect(search.contacts.map((c) => c.name)).toEqual(["Bob"]);

      const tagged = await listContactsPage(db, owner.accountId, { offset: 0, limit: 25, tagIds: [vipTag] });
      expect(tagged.total).toBe(2);
      expect(tagged.contacts.map((c) => c.name).sort()).toEqual(["Alice", "Carol"]);

      const tags = await tagIdsForContacts(db, tagged.contacts.map((c) => c.id as string));
      expect(Object.values(tags).every((ids) => ids.includes(vipTag))).toBe(true);
    });
  });

  it("does not leak another account's contacts", async () => {
    const page = await asUser(other.id, (db) => listContactsPage(db, owner.accountId, { offset: 0, limit: 25 }));
    expect(page.contacts).toEqual([]);
  });

  it("insertContact returns undefined on a duplicate phone instead of failing the tx", async () => {
    const result = await asUser(owner.id, async (db) => {
      const dup = await insertContact(db, { account_id: owner.accountId, user_id: owner.id, phone: "+1 555 0001" });
      const still = await db.selectFrom("contacts").select("id").where("account_id", "=", owner.accountId).execute();
      return { dup, n: still.length };
    });
    expect(result).toEqual({ dup: undefined, n: 3 });
  });

  it("keyset list embeds contact_tags(tags) and walks pages", async () => {
    await asUser(owner.id, async (db) => {
      const first = await listContactsKeyset(db, owner.accountId, { limit: 2, cursor: null });
      expect(first).toHaveLength(2);
      const last = first[first.length - 1];
      const next = await listContactsKeyset(db, owner.accountId, {
        limit: 2,
        cursor: { createdAt: last.created_at as string, id: last.id },
      });
      expect(next).toHaveLength(1);
      const alice = await getContactWithTags(db, owner.accountId, first.concat(next).find((c) => c.name === "Alice")!.id);
      expect(alice?.contact_tags.map((j) => j.tags?.name)).toEqual(["VIP"]);
    });
  });
});

describe("importContacts", () => {
  it("dedupes, skips existing numbers, creates tags and reports counts", async () => {
    const result = await importContacts(userRunner(owner.id), {
      accountId: owner.accountId,
      userId: owner.id,
      canCreateTags: true,
      rows: [
        { phone: "+15550001", name: "Alice again", tagNames: [] }, // exists
        { phone: "+15550100", name: "Dan", tagNames: ["Lead", "vip"] },
        { phone: "+15550100", name: "Dan dup", tagNames: [] }, // in-file duplicate
        { phone: "5550101", name: "No country code", tagNames: [] }, // invalid
        { phone: "+15550102", name: "Eve", tagNames: ["lead"] },
      ],
    });
    expect(result).toMatchObject({ imported: 2, skipped: 2, invalidPhone: 1, failed: 0, tagsAssigned: 3 });

    const tags = await asUser(owner.id, (db) =>
      db.selectFrom("tags").select("name").where("account_id", "=", owner.accountId).orderBy("name").execute(),
    );
    expect(tags.map((t) => t.name)).toEqual(["Lead", "VIP"]);
  });
});
