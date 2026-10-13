// Messages of a conversation, plus the per-account prerequisites the
// outbound send path reads (WhatsApp config) and its side effects
// (pausing flow runs).
//
// `messages` has no account_id column: every query is scoped through
// its conversation's account.

import type { ExpressionBuilder } from "kysely";

import { sql, type DB, type Db } from "@/server/db";
import type { Json } from "@/server/db/schema.gen";
import { keysetAfter, type Cursor } from "@/lib/api/v1/pagination";

/** `messages.conversation_id` belongs to a conversation of `accountId`. */
function inAccount(accountId: string) {
  return (eb: ExpressionBuilder<DB, "messages">) =>
    eb.exists(
      eb
        .selectFrom("conversations as mc")
        .select("mc.id")
        .whereRef("mc.id", "=", "messages.conversation_id")
        .where("mc.account_id", "=", accountId),
    );
}

// ------------------------------------------------------------
// Reads
// ------------------------------------------------------------

/** The whole thread, oldest first (inbox). */
export function listConversationMessages(db: Db, accountId: string, conversationId: string) {
  return db
    .selectFrom("messages")
    .selectAll("messages")
    .where("messages.conversation_id", "=", conversationId)
    .where(inAccount(accountId))
    .orderBy("messages.created_at", "asc")
    .execute();
}

/** Public API (v1) list: newest first, keyset-paginated on (created_at desc, id desc). */
export function listMessagesKeyset(
  db: Db,
  accountId: string,
  conversationId: string,
  q: { limit: number; cursor: Cursor | null },
) {
  let query = db
    .selectFrom("messages")
    .selectAll("messages")
    .where("messages.conversation_id", "=", conversationId)
    .where(inAccount(accountId));
  if (q.cursor) query = query.where(keysetAfter("messages.created_at", "messages.id", q.cursor));
  return query.orderBy("messages.created_at", "desc").orderBy("messages.id", "desc").limit(q.limit).execute();
}

/** A message of the account (with its Meta id + conversation), or undefined. */
export function getMessageRef(db: Db, accountId: string, messageId: string) {
  return db
    .selectFrom("messages")
    .select(["messages.id", "messages.message_id", "messages.conversation_id"])
    .where("messages.id", "=", messageId)
    .where(inAccount(accountId))
    .executeTakeFirst();
}

/** Reply target — must live in the same conversation. */
export function getReplyParent(db: Db, conversationId: string, messageId: string) {
  return db
    .selectFrom("messages")
    .select(["message_id", "conversation_id"])
    .where("id", "=", messageId)
    .where("conversation_id", "=", conversationId)
    .executeTakeFirst();
}

// ------------------------------------------------------------
// Writes
// ------------------------------------------------------------

export interface OutboundMessageValues {
  conversation_id: string;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  template_name: string | null;
  interactive_payload: Json | null;
  message_id: string;
  reply_to_message_id: string | null;
}

/** Persist an agent message that Meta accepted. */
export function insertOutboundMessage(db: Db, values: OutboundMessageValues) {
  return db
    .insertInto("messages")
    .values({
      ...values,
      interactive_payload: values.interactive_payload === null ? null : JSON.stringify(values.interactive_payload),
      sender_type: "agent",
      status: "sent",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// ------------------------------------------------------------
// Sending prerequisites / side effects
// ------------------------------------------------------------

/**
 * The account's WhatsApp config row, INCLUDING the encrypted access
 * token. Server-side send paths only — never return it to a browser.
 */
export function getWhatsAppSendConfig(db: Db, accountId: string) {
  return db
    .selectFrom("whatsapp_config")
    .select(["id", "phone_number_id", "access_token", "user_id"])
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}

/** Connection status only (safe for the browser). */
export async function getWhatsAppStatus(db: Db, accountId: string): Promise<string | null> {
  const row = await db
    .selectFrom("whatsapp_config")
    .select("status")
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return row?.status ?? null;
}

/** Re-encrypt a legacy-format token in place (GCM self-heal). */
export async function updateWhatsAppAccessToken(
  db: Db,
  accountId: string,
  configId: string,
  accessToken: string,
): Promise<void> {
  await db
    .updateTable("whatsapp_config")
    .set({ access_token: accessToken })
    .where("id", "=", configId)
    .where("account_id", "=", accountId)
    .execute();
}

/** APPROVED templates of the account, newest first (inbox template picker). */
export function listApprovedTemplates(db: Db, accountId: string) {
  return db
    .selectFrom("message_templates")
    .selectAll()
    .where("account_id", "=", accountId)
    .where("status", "=", "APPROVED")
    .orderBy("created_at", "desc")
    .execute();
}

/** Pause the contact's active Flow runs — an agent stepped in. */
export async function pauseActiveFlowRunsForContact(db: Db, accountId: string, contactId: string): Promise<void> {
  await db
    .updateTable("flow_runs")
    .set({ status: "paused_by_agent", ended_at: sql<string>`now()`, end_reason: "agent_replied" })
    .where("account_id", "=", accountId)
    .where("contact_id", "=", contactId)
    .where("status", "=", "active")
    .execute();
}
