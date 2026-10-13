// Conversations (the inbox threads) and their embedded contact.

import type { ExpressionBuilder } from "kysely";
import { jsonObjectFrom } from "kysely/helpers/postgres";

import { sql, type DB, type Db } from "@/server/db";
import { contactTagsEmbed } from "@/server/repos/contacts";
import { keysetAfter, type Cursor } from "@/lib/api/v1/pagination";

// ------------------------------------------------------------
// Embeds
// ------------------------------------------------------------

/**
 * `contact: { ...contact, contact_tags: [{ tags }] }` — the shape
 * PostgREST's `*, contact:contacts(*, contact_tags(tags(*)))` produced
 * (formerly CONVERSATION_SELECT). normalizeConversation flattens it.
 */
function contactWithTagsEmbed(eb: ExpressionBuilder<DB, "conversations">) {
  return jsonObjectFrom(
    eb
      .selectFrom("contacts")
      .selectAll("contacts")
      .select((eb2) => contactTagsEmbed(eb2 as unknown as ExpressionBuilder<DB, "contacts">))
      .whereRef("contacts.id", "=", "conversations.contact_id"),
  ).as("contact");
}

/** Conversations of an account with the contact + tags embed. */
function conversationsWithContact(db: Db, accountId: string) {
  return db
    .selectFrom("conversations")
    .selectAll("conversations")
    .select((eb) => contactWithTagsEmbed(eb))
    .where("conversations.account_id", "=", accountId);
}

// ------------------------------------------------------------
// Reads
// ------------------------------------------------------------

/** Every conversation of the account, most recent activity first (inbox list). */
export function listConversationsWithContact(db: Db, accountId: string) {
  return conversationsWithContact(db, accountId).orderBy("conversations.last_message_at", "desc").execute();
}

/** One conversation with its contact + tags, or undefined. */
export function getConversationWithContact(db: Db, accountId: string, conversationId: string) {
  return conversationsWithContact(db, accountId).where("conversations.id", "=", conversationId).executeTakeFirst();
}

/** Public API (v1) list: keyset-paginated on (created_at desc, id desc). */
export function listConversationsKeyset(
  db: Db,
  accountId: string,
  q: { limit: number; cursor: Cursor | null; status?: string | null; contactId?: string | null },
) {
  let query = conversationsWithContact(db, accountId);
  if (q.status) query = query.where("conversations.status", "=", q.status);
  if (q.contactId) query = query.where("conversations.contact_id", "=", q.contactId);
  if (q.cursor) query = query.where(keysetAfter("conversations.created_at", "conversations.id", q.cursor));
  return query
    .orderBy("conversations.created_at", "desc")
    .orderBy("conversations.id", "desc")
    .limit(q.limit)
    .execute();
}

/** The conversation's id when it belongs to the account. */
export async function conversationIdInAccount(
  db: Db,
  accountId: string,
  conversationId: string,
): Promise<string | undefined> {
  const row = await db
    .selectFrom("conversations")
    .select("id")
    .where("id", "=", conversationId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return row?.id;
}

/** Conversation + its contact row (no tags) — what the send core needs. */
export function getConversationForSend(db: Db, accountId: string, conversationId: string) {
  return db
    .selectFrom("conversations")
    .selectAll("conversations")
    .select((eb) =>
      jsonObjectFrom(
        eb.selectFrom("contacts").selectAll("contacts").whereRef("contacts.id", "=", "conversations.contact_id"),
      ).as("contact"),
    )
    .where("conversations.id", "=", conversationId)
    .where("conversations.account_id", "=", accountId)
    .executeTakeFirst();
}

/** `{ id, unread_count }` for every conversation (sidebar unread dot). */
export function listUnreadCounts(db: Db, accountId: string) {
  return db
    .selectFrom("conversations")
    .select(["id", "unread_count"])
    .where("account_id", "=", accountId)
    .execute();
}

// ------------------------------------------------------------
// Find-or-create (one conversation per (account, contact), migration 036)
// ------------------------------------------------------------

/** Oldest conversation of the contact (the canonical survivor of pre-036 duplicates). */
export async function findConversationIdForContact(
  db: Db,
  accountId: string,
  contactId: string,
): Promise<string | undefined> {
  const row = await db
    .selectFrom("conversations")
    .select("id")
    .where("account_id", "=", accountId)
    .where("contact_id", "=", contactId)
    .orderBy("created_at", "asc")
    .limit(1)
    .executeTakeFirst();
  return row?.id;
}

/**
 * Return the contact's conversation, creating it when missing. The
 * insert is ON CONFLICT DO NOTHING against the (account_id, contact_id)
 * unique index, so a concurrent create re-resolves the winning row
 * instead of failing (and aborting) the transaction.
 */
export async function findOrCreateConversationId(
  db: Db,
  accountId: string,
  contactId: string,
  userId: string,
): Promise<string | undefined> {
  const existing = await findConversationIdForContact(db, accountId, contactId);
  if (existing) return existing;
  const created = await db
    .insertInto("conversations")
    .values({ account_id: accountId, user_id: userId, contact_id: contactId })
    .onConflict((oc) => oc.columns(["account_id", "contact_id"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  if (created) return created.id;
  return findConversationIdForContact(db, accountId, contactId);
}

// ------------------------------------------------------------
// Writes
// ------------------------------------------------------------

export interface ConversationPatch {
  status?: string;
  assigned_agent_id?: string | null;
}

export function updateConversation(db: Db, accountId: string, conversationId: string, patch: ConversationPatch) {
  return db
    .updateTable("conversations")
    .set(patch)
    .where("id", "=", conversationId)
    .where("account_id", "=", accountId)
    .returningAll()
    .executeTakeFirst();
}

/**
 * Reset the unread badge. Under asUser the conversations_update policy
 * needs 'agent', so for a viewer this silently matches nothing — the
 * same no-op the inbox always got.
 */
export async function markConversationRead(db: Db, accountId: string, conversationId: string): Promise<void> {
  await db
    .updateTable("conversations")
    .set({ unread_count: 0 })
    .where("id", "=", conversationId)
    .where("account_id", "=", accountId)
    .execute();
}

/** Bump the list preview after an outbound send. */
export async function touchConversationLastMessage(
  db: Db,
  accountId: string,
  conversationId: string,
  lastMessageText: string,
): Promise<void> {
  await db
    .updateTable("conversations")
    .set({
      last_message_text: lastMessageText,
      last_message_at: sql<string>`now()`,
      updated_at: sql<string>`now()`,
    })
    .where("id", "=", conversationId)
    .where("account_id", "=", accountId)
    .execute();
}
