// Template-lifecycle webhook writes (src/lib/whatsapp/template-webhook.ts).
// Service role — Meta's template events carry no session.
//
// Scoping: a template event identifies its row by `meta_template_id`,
// Meta's own id, which is unique per WABA and therefore already names
// exactly one tenant's template. The update is keyed on it (as before
// the Kysely move) rather than on an account id the event doesn't
// carry. The stub insert is scoped by the account resolved from
// `whatsapp_config.waba_id`.

import type { Updateable } from "kysely";

import type { DB, Db } from "@/server/db";

export type TemplateEventPatch = Pick<
  Updateable<DB["message_templates"]>,
  "status" | "rejection_reason" | "submission_error" | "quality_score"
>;

/** Apply an event's columns to every row with this Meta id; returns the ids touched. */
export async function updateTemplatesByMetaId(
  db: Db,
  metaTemplateId: string,
  patch: TemplateEventPatch,
): Promise<string[]> {
  const rows = await db
    .updateTable("message_templates")
    .set(patch)
    .where("meta_template_id", "=", metaTemplateId)
    .returning("id")
    .execute();
  return rows.map((r) => r.id);
}

/** whatsapp_config rows (tenant + config owner) registered for a WABA id. */
export function listConfigOwnersByWabaId(db: Db, wabaId: string): Promise<{ account_id: string; user_id: string }[]> {
  return db
    .selectFrom("whatsapp_config")
    .select(["account_id", "user_id"])
    .where("waba_id", "=", wabaId)
    .execute();
}

export type TemplateStub = TemplateEventPatch & {
  account_id: string;
  user_id: string;
  meta_template_id: string;
  name: string;
  language: string;
  body_text: string;
};

/**
 * Insert a stub template row unless a unique index already holds one
 * (a concurrent sync / webhook, or a local unlinked row with the same
 * name + language). Returns whether a row was inserted.
 */
export async function insertTemplateStub(db: Db, stub: TemplateStub): Promise<boolean> {
  const inserted = await db
    .insertInto("message_templates")
    .values(stub)
    .onConflict((oc) => oc.doNothing())
    .returning("id")
    .executeTakeFirst();
  return inserted !== undefined;
}
