// Conversation-side state of the AI auto-reply bot: eligibility reads,
// the take-over / resume toggle, handoff, the reply-slot claim and the
// transcript fed to the model.

import { sql, type Db } from "@/server/db";

/** Does the account have an active message-level automation (which may reply itself)? */
export async function hasActiveMessageAutoResponder(db: Db, accountId: string): Promise<boolean> {
  const row = await db
    .selectFrom("automations")
    .select("id")
    .where("account_id", "=", accountId)
    .where("is_active", "=", true)
    .where("trigger_type", "in", ["new_message_received", "keyword_match"])
    .limit(1)
    .executeTakeFirst();
  return !!row;
}

export function getConversationAiState(db: Db, accountId: string, conversationId: string) {
  return db
    .selectFrom("conversations")
    .select(["assigned_agent_id", "ai_autoreply_disabled", "ai_reply_count"])
    .where("id", "=", conversationId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}

export async function conversationExists(db: Db, accountId: string, conversationId: string): Promise<boolean> {
  const row = await db
    .selectFrom("conversations")
    .select("id")
    .where("id", "=", conversationId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return !!row;
}

export interface ConversationAiPatch {
  ai_autoreply_disabled?: boolean;
  ai_handoff_summary?: string | null;
  ai_reply_count?: number;
  assigned_agent_id?: string | null;
}

/** Returns the number of rows updated (0 when not in the account). */
export async function updateConversationAi(
  db: Db,
  accountId: string,
  conversationId: string,
  patch: ConversationAiPatch,
): Promise<number> {
  const r = await db
    .updateTable("conversations")
    .set(patch)
    .where("id", "=", conversationId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}

/**
 * Atomically take one auto-reply slot (cap check + increment in one
 * UPDATE, migration 029). False when the cap is already reached.
 * EXECUTE is granted to service_role only — call under asService.
 */
export async function claimAiReplySlot(db: Db, conversationId: string, maxReplies: number): Promise<boolean> {
  const r = await sql<{ claimed: boolean }>`
    SELECT public.claim_ai_reply_slot(${conversationId}::uuid, ${maxReplies}::int) AS claimed`.execute(db);
  return r.rows[0]?.claimed === true;
}

/** Last `limit` text messages of a conversation, newest first. */
export function listRecentTextMessages(db: Db, accountId: string, conversationId: string, limit: number) {
  return db
    .selectFrom("messages")
    .innerJoin("conversations", "conversations.id", "messages.conversation_id")
    .select(["messages.sender_type", "messages.content_text"])
    .where("messages.conversation_id", "=", conversationId)
    .where("conversations.account_id", "=", accountId)
    .where("messages.content_type", "=", "text")
    .orderBy("messages.created_at", "desc")
    .limit(limit)
    .execute();
}
