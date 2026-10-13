// Broadcast audience resolution — which contacts a wizard send targets.
//
// Everything is one SQL query per audience (EXISTS filters), so there
// is no row cap or oversized IN list to page around: the old
// PostgREST version had to chunk tag/contact id lists and page past
// the 1000-row response cap by hand.

import type { ExpressionBuilder } from "kysely";

import { sql, type DB, type Db } from "@/server/db";
import { normalizeKey } from "@/lib/contacts/dedupe";
import type { AudienceConfig, CsvAudienceRow, CustomFieldFilter } from "@/lib/broadcast-audience";

type ContactsEb = ExpressionBuilder<DB, "contacts">;

/** contacts carrying any of `tagIds`. */
function hasAnyTag(eb: ContactsEb, tagIds: string[]) {
  return eb.exists(
    eb
      .selectFrom("contact_tags as ct")
      .select(sql`1`.as("one"))
      .whereRef("ct.contact_id", "=", "contacts.id")
      .where(sql<boolean>`ct.tag_id = ANY(${tagIds}::uuid[])`),
  );
}

/** contacts whose custom value for the field matches the filter. */
function matchesCustomField(eb: ContactsEb, filter: CustomFieldFilter) {
  let sub = eb
    .selectFrom("contact_custom_values as ccv")
    .select(sql`1`.as("one"))
    .whereRef("ccv.contact_id", "=", "contacts.id")
    .where("ccv.custom_field_id", "=", filter.fieldId);
  if (filter.operator === "is") sub = sub.where("ccv.value", "=", filter.value);
  else if (filter.operator === "is_not") sub = sub.where("ccv.value", "<>", filter.value);
  else sub = sub.where("ccv.value", "ilike", `%${filter.value}%`);
  return eb.exists(sub);
}

function hasCustomFieldFilter(
  audience: AudienceConfig,
): audience is AudienceConfig & { customField: CustomFieldFilter } {
  return Boolean(audience.customField?.fieldId);
}

/**
 * The contacts query for a non-CSV audience (minus excludes), or null
 * when the audience is not configured enough to target anyone.
 */
function audienceQuery(db: Db, accountId: string, audience: AudienceConfig) {
  let q = db.selectFrom("contacts").where("contacts.account_id", "=", accountId);
  if (audience.type === "tags") {
    if (!audience.tagIds || audience.tagIds.length === 0) return null;
    const tagIds = audience.tagIds;
    q = q.where((eb) => hasAnyTag(eb, tagIds));
  } else if (audience.type === "custom_field") {
    if (!hasCustomFieldFilter(audience)) return null;
    const filter = audience.customField;
    q = q.where((eb) => matchesCustomField(eb, filter));
  } else if (audience.type !== "all") {
    return null;
  }
  const exclude = audience.excludeTagIds ?? [];
  if (exclude.length > 0) q = q.where((eb) => eb.not(hasAnyTag(eb, exclude)));
  return q;
}

/** Contacts of the account that carry any of `tagIds`. */
async function taggedContactIds(db: Db, accountId: string, tagIds: string[]): Promise<Set<string>> {
  if (tagIds.length === 0) return new Set();
  const rows = await db
    .selectFrom("contacts")
    .select("contacts.id")
    .where("contacts.account_id", "=", accountId)
    .where((eb) => hasAnyTag(eb, tagIds))
    .execute();
  return new Set(rows.map((r) => r.id));
}

/**
 * CSV rows arrive as raw phone/name pairs. Recipient rows need real
 * contact ids, so: de-duplicate on the NORMALIZED number (the key of the
 * account-wide unique index, migration 022), insert the numbers the
 * account doesn't have yet, and return the resolved contacts in CSV
 * order. ON CONFLICT DO NOTHING keeps a concurrent insert of the same
 * number from aborting the transaction.
 */
export async function upsertCsvContacts(
  db: Db,
  accountId: string,
  userId: string,
  csvRows: CsvAudienceRow[],
) {
  if (csvRows.length === 0) return [];

  const uniqueByKey = new Map<string, CsvAudienceRow>();
  for (const row of csvRows) {
    const key = normalizeKey(row.phone);
    if (key && !uniqueByKey.has(key)) uniqueByKey.set(key, row);
  }
  const keys = [...uniqueByKey.keys()];
  if (keys.length === 0) return [];

  const findExisting = () =>
    db
      .selectFrom("contacts")
      .selectAll()
      .where("account_id", "=", accountId)
      .where(sql<boolean>`phone_normalized = ANY(${keys}::text[])`)
      .execute();

  const existing = await findExisting();
  const have = new Set(existing.map((c) => c.phone_normalized));
  const missing = keys.filter((k) => !have.has(k)).map((k) => uniqueByKey.get(k)!);

  const CHUNK = 1000;
  for (let i = 0; i < missing.length; i += CHUNK) {
    await db
      .insertInto("contacts")
      .values(
        missing.slice(i, i + CHUNK).map((row) => ({
          account_id: accountId,
          user_id: userId,
          phone: row.phone,
          name: row.name ?? null,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  const all = missing.length > 0 ? await findExisting() : existing;
  const byKey = new Map(all.map((c) => [c.phone_normalized ?? "", c]));
  return keys.map((k) => byKey.get(k)).filter((c): c is NonNullable<typeof c> => Boolean(c));
}

/** Resolve the audience to contact rows (excludes applied), ordered by id. */
export async function resolveAudienceContacts(
  db: Db,
  accountId: string,
  userId: string,
  audience: AudienceConfig,
) {
  if (audience.type === "csv") {
    if (!audience.csvContacts) return [];
    const contacts = await upsertCsvContacts(db, accountId, userId, audience.csvContacts);
    const excluded = await taggedContactIds(db, accountId, audience.excludeTagIds ?? []);
    return contacts.filter((c) => !excluded.has(c.id));
  }
  const q = audienceQuery(db, accountId, audience);
  if (!q) return [];
  return q.selectAll("contacts").orderBy("contacts.id").execute();
}

/**
 * Audience size for the wizard's estimate, or null when the audience is
 * only partially configured. CSV audiences are counted from the rows.
 */
export async function countAudience(db: Db, accountId: string, audience: AudienceConfig): Promise<number | null> {
  if (audience.type === "csv") {
    return audience.csvContacts && audience.csvContacts.length > 0 ? audience.csvContacts.length : null;
  }
  if (audience.type === "custom_field" && !audience.customField?.value) return null;
  const q = audienceQuery(db, accountId, audience);
  if (!q) return null;
  const r = await q.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
  return Number(r.n);
}

/** contactId → (customFieldId → value), for resolving custom-field placeholders. */
export async function customValueIndex(
  db: Db,
  accountId: string,
  contactIds: string[],
): Promise<Map<string, Map<string, string>>> {
  const index = new Map<string, Map<string, string>>();
  if (contactIds.length === 0) return index;
  const rows = await db
    .selectFrom("contact_custom_values as ccv")
    .innerJoin("contacts as c", "c.id", "ccv.contact_id")
    .select(["ccv.contact_id", "ccv.custom_field_id", "ccv.value"])
    .where("c.account_id", "=", accountId)
    .where(sql<boolean>`ccv.contact_id = ANY(${contactIds}::uuid[])`)
    .execute();
  for (const row of rows) {
    const bucket = index.get(row.contact_id) ?? new Map<string, string>();
    bucket.set(row.custom_field_id, row.value ?? "");
    index.set(row.contact_id, bucket);
  }
  return index;
}
