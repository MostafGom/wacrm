// Contacts, their tags, notes and custom field values.

import type { ExpressionBuilder } from "kysely";
import { jsonArrayFrom, jsonObjectFrom } from "kysely/helpers/postgres";

import { sql, type DB, type Db } from "@/server/db";

// ------------------------------------------------------------
// Embeds (keep the shapes the UI / public API already consume)
// ------------------------------------------------------------

/**
 * `contact_tags: [{ tags: Tag }]` for the contact row aliased `contacts`
 * — the shape PostgREST's `contact_tags(tags(*))` produced, which
 * serializeContact / normalizeConversation flatten.
 */
export function contactTagsEmbed(eb: ExpressionBuilder<DB, "contacts">) {
  return jsonArrayFrom(
    eb
      .selectFrom("contact_tags as ct")
      .select((eb2) => [
        jsonObjectFrom(eb2.selectFrom("tags").selectAll("tags").whereRef("tags.id", "=", "ct.tag_id")).as("tags"),
      ])
      .whereRef("ct.contact_id", "=", "contacts.id"),
  ).as("contact_tags");
}

// ------------------------------------------------------------
// Reads
// ------------------------------------------------------------

export interface ContactListQuery {
  offset: number;
  limit: number;
  search?: string;
  /** Contacts having ANY of these tags. */
  tagIds?: string[];
}

/**
 * One page of contacts (newest first) with a total count. A tag filter
 * goes through filter_contacts_by_tags (migration 025: join + distinct +
 * windowed count in SQL), the plain list through a direct query.
 */
export async function listContactsPage(db: Db, accountId: string, q: ContactListQuery) {
  const term = q.search?.trim() || null;

  if (q.tagIds && q.tagIds.length > 0) {
    const r = await sql<{ contact: Record<string, unknown>; total_count: number }>`
      SELECT to_jsonb(f.contact) AS contact, f.total_count
        FROM public.filter_contacts_by_tags(${q.tagIds}::uuid[], ${term}, ${q.limit}, ${q.offset}) f`.execute(db);
    return {
      contacts: r.rows.map((row) => row.contact).filter((c) => c.account_id === accountId),
      total: r.rows.length > 0 ? Number(r.rows[0].total_count) : 0,
    };
  }

  let base = db.selectFrom("contacts").where("account_id", "=", accountId);
  if (term) {
    const like = `%${term}%`;
    base = base.where((eb) =>
      eb.or([eb("name", "ilike", like), eb("phone", "ilike", like), eb("email", "ilike", like)]),
    );
  }
  const [contacts, count] = await Promise.all([
    base.selectAll().orderBy("created_at", "desc").limit(q.limit).offset(q.offset).execute(),
    base.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow(),
  ]);
  return { contacts, total: Number(count.n) };
}

/** tag ids per contact, for a set of contacts. */
export async function tagIdsForContacts(db: Db, contactIds: string[]): Promise<Record<string, string[]>> {
  if (contactIds.length === 0) return {};
  const rows = await db
    .selectFrom("contact_tags")
    .select(["contact_id", "tag_id"])
    .where("contact_id", "in", contactIds)
    .execute();
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.contact_id] ??= []).push(r.tag_id);
  return out;
}

export function getContact(db: Db, accountId: string, contactId: string) {
  return db
    .selectFrom("contacts")
    .selectAll()
    .where("id", "=", contactId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}

/** A contact with its `contact_tags(tags(*))` embed (public API shape). */
export function getContactWithTags(db: Db, accountId: string, contactId: string) {
  return db
    .selectFrom("contacts")
    .selectAll("contacts")
    .select((eb) => contactTagsEmbed(eb))
    .where("contacts.id", "=", contactId)
    .where("contacts.account_id", "=", accountId)
    .executeTakeFirst();
}

/** Normalized phones already present in the account (CSV import de-dup). */
export async function existingPhoneKeys(db: Db, accountId: string): Promise<Set<string>> {
  const rows = await db
    .selectFrom("contacts")
    .select("phone_normalized")
    .where("account_id", "=", accountId)
    .execute();
  return new Set(rows.map((r) => r.phone_normalized).filter((p): p is string => Boolean(p)));
}

// ------------------------------------------------------------
// Writes
// ------------------------------------------------------------

export interface ContactFields {
  name?: string | null;
  phone?: string;
  email?: string | null;
  company?: string | null;
}

/**
 * Insert a contact. Returns undefined when a unique index (same phone
 * in the account) already holds it — ON CONFLICT DO NOTHING, so the
 * surrounding transaction stays usable.
 */
export function insertContact(
  db: Db,
  values: { account_id: string; user_id: string; phone: string } & ContactFields,
) {
  return db
    .insertInto("contacts")
    .values(values)
    .onConflict((oc) => oc.doNothing())
    .returningAll()
    .executeTakeFirst();
}

export function updateContact(db: Db, accountId: string, contactId: string, patch: ContactFields) {
  return db
    .updateTable("contacts")
    .set({ ...patch, updated_at: sql<string>`now()` })
    .where("id", "=", contactId)
    .where("account_id", "=", accountId)
    .returningAll()
    .executeTakeFirst();
}

export async function deleteContacts(db: Db, accountId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await db
    .deleteFrom("contacts")
    .where("account_id", "=", accountId)
    .where("id", "in", ids)
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}

/** Replace the contact's tags with exactly `tagIds` (no automation dispatch). */
export async function replaceContactTags(db: Db, contactId: string, tagIds: string[]): Promise<void> {
  let del = db.deleteFrom("contact_tags").where("contact_id", "=", contactId);
  if (tagIds.length > 0) del = del.where("tag_id", "not in", tagIds);
  await del.execute();
  if (tagIds.length > 0) {
    await db
      .insertInto("contact_tags")
      .values(tagIds.map((tag_id) => ({ contact_id: contactId, tag_id })))
      .onConflict((oc) => oc.columns(["contact_id", "tag_id"]).doNothing())
      .execute();
  }
}

// ------------------------------------------------------------
// Notes
// ------------------------------------------------------------

export function listNotes(db: Db, accountId: string, contactId: string) {
  return db
    .selectFrom("contact_notes")
    .selectAll()
    .where("contact_id", "=", contactId)
    .where("account_id", "=", accountId)
    .orderBy("created_at", "desc")
    .execute();
}

export function insertNote(db: Db, values: { account_id: string; user_id: string; contact_id: string; note_text: string }) {
  return db.insertInto("contact_notes").values(values).returningAll().executeTakeFirstOrThrow();
}

export async function deleteNote(db: Db, accountId: string, contactId: string, noteId: string): Promise<boolean> {
  const r = await db
    .deleteFrom("contact_notes")
    .where("id", "=", noteId)
    .where("contact_id", "=", contactId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

// ------------------------------------------------------------
// Custom field values
// ------------------------------------------------------------

export function listCustomValues(db: Db, contactId: string) {
  return db.selectFrom("contact_custom_values").selectAll().where("contact_id", "=", contactId).execute();
}

/** Replace all custom values of a contact. */
export async function replaceCustomValues(
  db: Db,
  contactId: string,
  values: { custom_field_id: string; value: string }[],
): Promise<void> {
  await db.deleteFrom("contact_custom_values").where("contact_id", "=", contactId).execute();
  if (values.length > 0) {
    await db
      .insertInto("contact_custom_values")
      .values(values.map((v) => ({ contact_id: contactId, custom_field_id: v.custom_field_id, value: v.value })))
      .execute();
  }
}

/** Deals linked to a contact, with their stage (contact detail view). */
export function listDealsForContact(db: Db, accountId: string, contactId: string) {
  return db
    .selectFrom("deals")
    .selectAll("deals")
    .select((eb) =>
      jsonObjectFrom(
        eb.selectFrom("pipeline_stages").selectAll("pipeline_stages").whereRef("pipeline_stages.id", "=", "deals.stage_id"),
      ).as("stage"),
    )
    .where("deals.contact_id", "=", contactId)
    .where("deals.account_id", "=", accountId)
    .orderBy("deals.created_at", "desc")
    .execute();
}

// ------------------------------------------------------------
// Public API (v1) list: keyset-paginated on (created_at desc, id desc)
// ------------------------------------------------------------

export interface KeysetCursor {
  createdAt: string;
  id: string;
}

export function listContactsKeyset(
  db: Db,
  accountId: string,
  q: { limit: number; cursor: KeysetCursor | null; search?: string; tagId?: string | null },
) {
  let query = db
    .selectFrom("contacts")
    .selectAll("contacts")
    .select((eb) => contactTagsEmbed(eb))
    .where("contacts.account_id", "=", accountId);

  if (q.search) {
    const like = `%${q.search}%`;
    query = query.where((eb) => eb.or([eb("contacts.name", "ilike", like), eb("contacts.phone", "ilike", like)]));
  }
  if (q.tagId) {
    const tagId = q.tagId;
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom("contact_tags as tf")
          .select("tf.id")
          .whereRef("tf.contact_id", "=", "contacts.id")
          .where("tf.tag_id", "=", tagId),
      ),
    );
  }
  if (q.cursor) {
    const c = q.cursor;
    query = query.where((eb) =>
      eb.or([
        eb("contacts.created_at", "<", c.createdAt),
        eb.and([eb("contacts.created_at", "=", c.createdAt), eb("contacts.id", "<", c.id)]),
      ]),
    );
  }
  return query.orderBy("contacts.created_at", "desc").orderBy("contacts.id", "desc").limit(q.limit).execute();
}
