// Inbound WhatsApp message persistence: the contact / conversation /
// message / reaction writes the Meta webhook makes. Runs under the
// service role (no session), so every query is scoped by the account
// resolved from whatsapp_config — or by a conversation id that was
// itself resolved inside that account.
//
// Races are handled with ON CONFLICT DO NOTHING + re-read rather than by
// catching 23505: a failed statement aborts the whole transaction.

import type { Insertable, Selectable, Updateable } from "kysely";

import { sql, type DB, type Db } from "@/server/db";

export type InboundContactRow = Selectable<DB["contacts"]>;
export type InboundConversationRow = Selectable<DB["conversations"]>;

// ------------------------------------------------------------
// Contacts
// ------------------------------------------------------------

/**
 * Look a contact up by BSUID. Exact match on the column backing
 * migration 040's unique index — no fuzzy matching, because a BSUID is
 * an opaque identifier with exactly one correct spelling.
 */
export async function findContactByWaUserId(
  db: Db,
  accountId: string,
  waUserId: string,
): Promise<InboundContactRow | null> {
  const row = await db
    .selectFrom("contacts")
    .selectAll()
    .where("account_id", "=", accountId)
    .where("wa_user_id", "=", waUserId)
    .executeTakeFirst();
  return row ?? null;
}

export type ContactIdentityPatch = Pick<
  Updateable<DB["contacts"]>,
  "name" | "wa_user_id" | "wa_parent_user_id" | "wa_username" | "phone"
>;

/** Apply an identity backfill to one contact; returns the updated row. */
export async function updateContactIdentity(
  db: Db,
  accountId: string,
  contactId: string,
  patch: ContactIdentityPatch,
): Promise<InboundContactRow | null> {
  const row = await db
    .updateTable("contacts")
    .set({ ...patch, updated_at: new Date().toISOString() })
    .where("id", "=", contactId)
    .where("account_id", "=", accountId)
    .returningAll()
    .executeTakeFirst();
  return row ?? null;
}

export interface NewInboundContact {
  account_id: string;
  user_id: string;
  phone: string;
  name: string | null;
  wa_user_id: string | null;
  wa_parent_user_id: string | null;
  wa_username: string | null;
}

/**
 * Insert a contact unless a unique index (022's phone, 040's BSUID)
 * already holds one. Returns null on conflict — the caller re-resolves
 * the row the concurrent delivery created.
 */
export async function insertInboundContact(db: Db, row: NewInboundContact): Promise<InboundContactRow | null> {
  const inserted = await db
    .insertInto("contacts")
    .values(row)
    .onConflict((oc) => oc.doNothing())
    .returningAll()
    .executeTakeFirst();
  return inserted ?? null;
}

// ------------------------------------------------------------
// Conversations
// ------------------------------------------------------------

/**
 * The account's conversation with a contact, oldest first — the same
 * canonical survivor the dedup migration (036) keeps, so pre-existing
 * duplicates converge instead of compounding (issue #363).
 */
export async function findOldestConversation(
  db: Db,
  accountId: string,
  contactId: string,
): Promise<InboundConversationRow | null> {
  const row = await db
    .selectFrom("conversations")
    .selectAll()
    .where("account_id", "=", accountId)
    .where("contact_id", "=", contactId)
    .orderBy("created_at", "asc")
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Insert a conversation unless migration 036's (account_id, contact_id)
 * unique index already holds one. Null on conflict.
 */
export async function insertInboundConversation(
  db: Db,
  row: { account_id: string; user_id: string; contact_id: string },
): Promise<InboundConversationRow | null> {
  const inserted = await db
    .insertInto("conversations")
    .values(row)
    .onConflict((oc) => oc.columns(["account_id", "contact_id"]).doNothing())
    .returningAll()
    .executeTakeFirst();
  return inserted ?? null;
}

/**
 * Atomic unread increment + last-message summary (migration 037's
 * SECURITY DEFINER RPC, issue #369). The conversation id was resolved
 * inside the account by findOldestConversation / insertInboundConversation.
 */
export async function bumpConversationOnInbound(
  db: Db,
  conversationId: string,
  lastMessageText: string,
): Promise<void> {
  await sql`SELECT public.bump_conversation_on_inbound(${conversationId}::uuid, ${lastMessageText})`.execute(db);
}

/**
 * closed → open, re-checked in SQL so a stale snapshot can't write
 * 'open' over an agent who re-closed the thread in between (#409).
 * Returns whether a row was re-opened.
 */
export async function reopenConversationIfClosed(
  db: Db,
  accountId: string,
  conversationId: string,
): Promise<boolean> {
  const r = await db
    .updateTable("conversations")
    .set({ status: "open", updated_at: new Date().toISOString() })
    .where("id", "=", conversationId)
    .where("account_id", "=", accountId)
    .where("status", "=", "closed")
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

// ------------------------------------------------------------
// Messages
// ------------------------------------------------------------

/** Internal id of a message in `conversationId` by its Meta id (wamid). */
export async function findMessageIdByMetaId(
  db: Db,
  conversationId: string,
  metaId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("messages")
    .select("id")
    .where("conversation_id", "=", conversationId)
    .where("message_id", "=", metaId)
    .executeTakeFirst();
  return row?.id ?? null;
}

/** How many customer-sent messages the conversation already holds. */
export async function countCustomerMessages(db: Db, conversationId: string): Promise<number> {
  const row = await db
    .selectFrom("messages")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("conversation_id", "=", conversationId)
    .where("sender_type", "=", "customer")
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export type NewInboundMessage = Insertable<DB["messages"]> & {
  conversation_id: string;
  message_id: string;
};

/**
 * Idempotent insert keyed on migration 037's (conversation_id,
 * message_id) unique index. Returns the new row's id on a genuine first
 * insert and null when the delivery is a replay (issue #367).
 */
export async function insertInboundMessage(db: Db, row: NewInboundMessage): Promise<string | null> {
  const inserted = await db
    .insertInto("messages")
    .values(row)
    .onConflict((oc) => oc.columns(["conversation_id", "message_id"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  return inserted?.id ?? null;
}

// ------------------------------------------------------------
// Reactions (per (target, actor) state, never a `messages` row)
// ------------------------------------------------------------

export async function deleteCustomerReaction(db: Db, messageId: string, contactId: string): Promise<void> {
  await db
    .deleteFrom("message_reactions")
    .where("message_id", "=", messageId)
    .where("actor_type", "=", "customer")
    .where("actor_id", "=", contactId)
    .execute();
}

export async function upsertCustomerReaction(
  db: Db,
  row: { message_id: string; conversation_id: string; contact_id: string; emoji: string },
): Promise<void> {
  await db
    .insertInto("message_reactions")
    .values({
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      actor_type: "customer",
      actor_id: row.contact_id,
      emoji: row.emoji,
    })
    .onConflict((oc) =>
      oc.columns(["message_id", "actor_type", "actor_id"]).doUpdateSet({
        conversation_id: (eb) => eb.ref("excluded.conversation_id"),
        emoji: (eb) => eb.ref("excluded.emoji"),
      }),
    )
    .execute();
}

// ------------------------------------------------------------
// Broadcast replies
// ------------------------------------------------------------

/**
 * Flip the contact's most recent still-unreplied broadcast recipient
 * row in this account to `replied`. Account-scoped through the parent
 * broadcast, so a reply marks the broadcast replied regardless of which
 * teammate sent it. Returns the recipient id, or null when none.
 */
export async function markLatestBroadcastReplied(
  db: Db,
  accountId: string,
  contactId: string,
): Promise<string | null> {
  const rec = await db
    .selectFrom("broadcast_recipients as r")
    .innerJoin("broadcasts as b", "b.id", "r.broadcast_id")
    .select("r.id")
    .where("r.contact_id", "=", contactId)
    .where("b.account_id", "=", accountId)
    .where("r.status", "in", ["sent", "delivered", "read"])
    .orderBy("r.created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!rec) return null;

  await db
    .updateTable("broadcast_recipients")
    .set({ status: "replied", replied_at: new Date().toISOString() })
    .where("id", "=", rec.id)
    .execute();
  return rec.id;
}
