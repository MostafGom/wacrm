// Quick replies — reusable snippets (plain text or a saved interactive
// message) shared across the account. RLS: any member reads, agent+
// writes (migration 035).

import type { Db } from "@/server/db";
import type { Json } from "@/server/db/schema.gen";

export function listQuickReplies(db: Db, accountId: string) {
  return db
    .selectFrom("quick_replies")
    .selectAll()
    .where("account_id", "=", accountId)
    .orderBy("created_at", "desc")
    .execute();
}

export function createQuickReply(
  db: Db,
  values: {
    account_id: string;
    user_id: string;
    title: string;
    kind: "text" | "interactive";
    content_text: string | null;
    interactive_payload: unknown;
  },
) {
  return db
    .insertInto("quick_replies")
    .values({ ...values, interactive_payload: toJsonb(values.interactive_payload) })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface QuickReplyUpdate {
  title?: string;
  kind?: "text" | "interactive";
  content_text?: string | null;
  interactive_payload?: unknown;
}

/** Partial update scoped to the account. A foreign / unknown id updates nothing. */
export async function updateQuickReply(db: Db, accountId: string, id: string, update: QuickReplyUpdate): Promise<void> {
  const set: Record<string, unknown> = { ...update };
  if ("interactive_payload" in update) set.interactive_payload = toJsonb(update.interactive_payload);
  await db
    .updateTable("quick_replies")
    .set(set)
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .execute();
}

export async function deleteQuickReply(db: Db, accountId: string, id: string): Promise<void> {
  await db.deleteFrom("quick_replies").where("id", "=", id).where("account_id", "=", accountId).execute();
}

// node-postgres serializes JS arrays as Postgres arrays, not JSON, so
// jsonb values are passed as JSON text.
function toJsonb(value: unknown): Json | null {
  return value == null ? null : (JSON.stringify(value) as unknown as Json);
}
