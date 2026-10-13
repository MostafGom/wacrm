// WhatsApp message templates (local copies of Meta templates) and the
// WhatsApp config bits the template / broadcast routes need to reach Meta.

import { sql, type Db } from "@/server/db";
import type { Json } from "@/server/db/schema.gen";

/**
 * A jsonb parameter. node-postgres would send a JS array as a Postgres
 * array literal, so serialize explicitly. null / undefined become SQL
 * NULL (not the JSON `null` scalar), the way PostgREST stored them.
 */
export function jsonb(value: unknown) {
  return sql<Json>`${value === undefined || value === null ? null : JSON.stringify(value)}::jsonb`;
}

/** All local rows of a template name (one per language) — feed to pickTemplateRow. */
export function listTemplatesByName(db: Db, accountId: string, name: string) {
  return db
    .selectFrom("message_templates")
    .selectAll()
    .where("account_id", "=", accountId)
    .where("name", "=", name)
    .execute();
}

export interface TemplateListQuery {
  /** Only rows in this Meta status (e.g. APPROVED for the broadcast picker). */
  status?: string;
  /** Only rows authored by this user (the settings manager's historical scope). */
  userId?: string;
}

/** Templates of the account, newest first. */
export function listTemplates(db: Db, accountId: string, q: TemplateListQuery = {}) {
  let query = db.selectFrom("message_templates").selectAll().where("account_id", "=", accountId);
  if (q.status) query = query.where("status", "=", q.status);
  if (q.userId) query = query.where("user_id", "=", q.userId);
  return query.orderBy("created_at", "desc").execute();
}

/** The lifecycle fields the edit / delete routes check before calling Meta. */
export function getTemplateMeta(db: Db, accountId: string, id: string) {
  return db
    .selectFrom("message_templates")
    .select(["id", "name", "status", "meta_template_id", "language"])
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}

export interface TemplateContent {
  category?: string;
  header_type?: string | null;
  header_content?: string | null;
  header_media_url?: string | null;
  header_handle?: string | null;
  body_text?: string;
  footer_text?: string | null;
  buttons?: unknown;
  sample_values?: unknown;
  status?: string;
  meta_template_id?: string | null;
  quality_score?: string | null;
  submission_error?: string | null;
  rejection_reason?: string | null;
  last_submitted_at?: string | null;
  updated_at?: string;
}

/** `buttons` / `sample_values` are jsonb — wrap them; everything else passes through. */
function toRow(patch: TemplateContent) {
  const { buttons, sample_values, ...rest } = patch;
  return {
    ...rest,
    ...(buttons !== undefined ? { buttons: jsonb(buttons) } : {}),
    ...(sample_values !== undefined ? { sample_values: jsonb(sample_values) } : {}),
  };
}

export function updateTemplate(db: Db, accountId: string, id: string, patch: TemplateContent) {
  return db
    .updateTable("message_templates")
    .set(toRow(patch))
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .returningAll()
    .executeTakeFirst();
}

export async function deleteTemplate(db: Db, accountId: string, id: string): Promise<boolean> {
  const r = await db
    .deleteFrom("message_templates")
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

export type TemplateInsert = TemplateContent & {
  account_id: string;
  user_id: string;
  name: string;
  language: string;
  body_text: string;
};

/**
 * Insert or overwrite by (user_id, name, language) — the unique index
 * migration 014 created. Every supplied column is overwritten on
 * conflict, the way the old PostgREST upsert behaved.
 */
export function upsertTemplateByUserNameLanguage(db: Db, row: TemplateInsert) {
  const values = toRow(row) as TemplateInsert;
  const cols = Object.keys(values).filter((k) => k !== "user_id" && k !== "name" && k !== "language");
  return db
    .insertInto("message_templates")
    .values(values as never)
    .onConflict((oc) =>
      oc.columns(["user_id", "name", "language"]).doUpdateSet((eb) =>
        Object.fromEntries(cols.map((c) => [c, eb.ref(`excluded.${c}` as never)])) as never,
      ),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Local row id for a (name, language) pair in the account, if any (Meta sync). */
export async function findTemplateId(db: Db, accountId: string, name: string, language: string) {
  const row = await db
    .selectFrom("message_templates")
    .select("id")
    .where("account_id", "=", accountId)
    .where("name", "=", name)
    .where("language", "=", language)
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function insertTemplate(db: Db, row: TemplateInsert): Promise<void> {
  await db
    .insertInto("message_templates")
    .values(toRow(row) as never)
    .execute();
}

/**
 * The account's WhatsApp sending credentials. `access_token` is still
 * encrypted — decrypt it server-side, never return it to a browser.
 */
export function getWhatsappConfig(db: Db, accountId: string) {
  return db
    .selectFrom("whatsapp_config")
    .select(["phone_number_id", "access_token", "waba_id"])
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}
