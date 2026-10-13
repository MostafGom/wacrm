// Broadcast audience resolution against real Postgres: no row caps,
// excludes, custom-field operators, CSV upserts and account scoping.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser, sql } from "@/server/db";
import { countAudience, customValueIndex, resolveAudienceContacts } from "@/server/repos/broadcast-audience";
import { seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let owner: SeededUser;
let other: SeededUser;
let bigTag: string;
let smallTag: string;
let optOutTag: string;
let field: string;
let firstIds: string[];

const TOTAL = 1200;

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  other = await seedUser("Other");

  await asService(async (db) => {
    // 1 200 contacts — past the old 1 000-row PostgREST cap.
    await sql`
      INSERT INTO contacts (account_id, user_id, phone, name)
      SELECT ${owner.accountId}::uuid, ${owner.id}::uuid, '+1555' || lpad(g::text, 7, '0'), 'C' || g
        FROM generate_series(1, ${TOTAL}::int) g`.execute(db);
    // A foreign account's contact that must never leak in.
    await db
      .insertInto("contacts")
      .values({ account_id: other.accountId, user_id: other.id, phone: "+15550000001", name: "Foreign" })
      .execute();

    const tags = await db
      .insertInto("tags")
      .values([
        { account_id: owner.accountId, user_id: owner.id, name: "big" },
        { account_id: owner.accountId, user_id: owner.id, name: "small" },
        { account_id: owner.accountId, user_id: owner.id, name: "opt-out" },
      ])
      .returning(["id", "name"])
      .execute();
    bigTag = tags.find((t) => t.name === "big")!.id;
    smallTag = tags.find((t) => t.name === "small")!.id;
    optOutTag = tags.find((t) => t.name === "opt-out")!.id;

    const ids = (
      await db
        .selectFrom("contacts")
        .select("id")
        .where("account_id", "=", owner.accountId)
        .orderBy("phone")
        .execute()
    ).map((r) => r.id);
    firstIds = ids;

    // big: first 1 100; small: first 50 (overlap with big); opt-out: last 150.
    await db
      .insertInto("contact_tags")
      .values([
        ...ids.slice(0, 1100).map((contact_id) => ({ contact_id, tag_id: bigTag })),
        ...ids.slice(0, 50).map((contact_id) => ({ contact_id, tag_id: smallTag })),
        ...ids.slice(-150).map((contact_id) => ({ contact_id, tag_id: optOutTag })),
      ])
      .execute();

    field = (
      await db
        .insertInto("custom_fields")
        .values({ account_id: owner.accountId, user_id: owner.id, field_name: "tier" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto("contact_custom_values")
      .values([
        ...ids.slice(0, 10).map((contact_id) => ({ contact_id, custom_field_id: field, value: "gold" })),
        ...ids.slice(10, 15).map((contact_id) => ({ contact_id, custom_field_id: field, value: "silver-plus" })),
      ])
      .execute();
  });
});

afterAll(teardownIntegrationDb);

const resolve = (audience: Parameters<typeof resolveAudienceContacts>[3]) =>
  asUser(owner.id, (db) => resolveAudienceContacts(db, owner.accountId, owner.id, audience));
const count = (audience: Parameters<typeof countAudience>[2]) =>
  asUser(owner.id, (db) => countAudience(db, owner.accountId, audience));

describe("resolveAudienceContacts", () => {
  it('returns every contact for "all" beyond the old 1000-row cap, own account only', async () => {
    const rows = await resolve({ type: "all" });
    expect(rows).toHaveLength(TOTAL);
    expect(new Set(rows.map((c) => c.id)).size).toBe(TOTAL);
    expect(rows.every((c) => c.account_id === owner.accountId)).toBe(true);
  });

  it("de-duplicates contacts carrying several selected tags", async () => {
    const rows = await resolve({ type: "tags", tagIds: [bigTag, smallTag] });
    expect(rows).toHaveLength(1100);
  });

  it("subtracts an exclude list from a tag audience and from all", async () => {
    // big = first 1 100, opt-out = last 150 → overlap 50.
    const rows = await resolve({ type: "tags", tagIds: [bigTag], excludeTagIds: [optOutTag] });
    expect(rows).toHaveLength(1050);
    expect(await resolve({ type: "all", excludeTagIds: [optOutTag] })).toHaveLength(TOTAL - 150);
  });

  it("resolves custom-field audiences per operator", async () => {
    expect(await resolve({ type: "custom_field", customField: { fieldId: field, operator: "is", value: "gold" } })).toHaveLength(10);
    // is_not matches contacts that HAVE a value differing from it.
    expect(
      await resolve({ type: "custom_field", customField: { fieldId: field, operator: "is_not", value: "gold" } }),
    ).toHaveLength(5);
    expect(
      await resolve({ type: "custom_field", customField: { fieldId: field, operator: "contains", value: "SILVER" } }),
    ).toHaveLength(5);
  });

  it("returns nothing for an empty tag selection", async () => {
    expect(await resolve({ type: "tags", tagIds: [] })).toEqual([]);
  });

  it("upserts CSV numbers: matches existing on the normalized phone, creates the rest, applies excludes", async () => {
    const rows = await resolve({
      type: "csv",
      csvContacts: [
        { phone: "+1 555-000-0001", name: "dup spelling of C1" },
        { phone: "+15550000001" }, // same number again
        { phone: "+15559990001", name: "New One" },
        { phone: "+1555" + String(TOTAL).padStart(7, "0") }, // last contact: opted out
      ],
      excludeTagIds: [optOutTag],
    });
    expect(rows.map((c) => c.name)).toEqual(["C1", "New One"]);
    expect(rows[1].user_id).toBe(owner.id);

    // Re-running reuses the created contact rather than colliding.
    const again = await resolve({ type: "csv", csvContacts: [{ phone: "+15559990001" }] });
    expect(again.map((c) => c.id)).toEqual([rows[1].id]);
  });
});

describe("countAudience", () => {
  it('counts "all" minus excludes', async () => {
    const all = await count({ type: "all" });
    expect(await count({ type: "all", excludeTagIds: [optOutTag] })).toBe((all ?? 0) - 150);
  });

  it("counts a tag audience beyond the cap, minus excludes", async () => {
    expect(await count({ type: "tags", tagIds: [bigTag] })).toBe(1100);
    expect(await count({ type: "tags", tagIds: [bigTag], excludeTagIds: [optOutTag] })).toBe(1050);
  });

  it("counts a custom-field audience", async () => {
    expect(await count({ type: "custom_field", customField: { fieldId: field, operator: "is", value: "gold" } })).toBe(10);
  });

  it("counts CSV rows without a query and returns null for partial audiences", async () => {
    expect(await count({ type: "csv", csvContacts: [{ phone: "1" }, { phone: "2" }] })).toBe(2);
    expect(await count({ type: "csv" })).toBeNull();
    expect(await count({ type: "tags", tagIds: [] })).toBeNull();
    expect(await count({ type: "custom_field", customField: { fieldId: field, operator: "is", value: "" } })).toBeNull();
  });

  it("never counts another account's contacts", async () => {
    const n = await asUser(other.id, (db) => countAudience(db, other.accountId, { type: "all" }));
    expect(n).toBe(1);
  });
});

describe("customValueIndex", () => {
  it("indexes values by contact then field, scoped to the account", async () => {
    const index = await asUser(owner.id, (db) => customValueIndex(db, owner.accountId, firstIds.slice(0, 12)));
    expect(index.size).toBe(12);
    expect(index.get(firstIds[0])?.get(field)).toBe("gold");
    expect(index.get(firstIds[11])?.get(field)).toBe("silver-plus");

    const foreign = await asUser(other.id, (db) => customValueIndex(db, other.accountId, firstIds.slice(0, 12)));
    expect(foreign.size).toBe(0);
  });
});
