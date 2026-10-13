// Reads and writes the automation + flow engines (and their Meta
// senders) make against CRM data: contacts, conversations, tags,
// custom values, deals, and the bot's outbound `messages` rows.
//
// The engines run under asService (RLS off), so every function here
// scopes by account explicitly. Tables without an account_id column
// (contact_tags, contact_custom_values, messages) are scoped through
// their parent contact / conversation.

import { sql, type Db } from "@/server/db";
import type { Json } from "@/server/db/schema.gen";

/** Bind any JSON value (arrays included) as a jsonb parameter. */
export function jsonb(value: unknown) {
  return sql<Json>`${JSON.stringify(value ?? null)}::jsonb`;
}

// ---- tenancy checks -------------------------------------------------

export async function contactInAccount(db: Db, accountId: string, contactId: string): Promise<boolean> {
  const row = await db
    .selectFrom("contacts")
    .select("id")
    .where("id", "=", contactId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return Boolean(row);
}

export async function conversationInAccount(db: Db, accountId: string, conversationId: string): Promise<boolean> {
  const row = await db
    .selectFrom("conversations")
    .select("id")
    .where("id", "=", conversationId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return Boolean(row);
}

/** The contact's conversation in this account (one per contact), if any. */
export async function findConversationIdForContact(
  db: Db,
  accountId: string,
  contactId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("conversations")
    .select("id")
    .where("account_id", "=", accountId)
    .where("contact_id", "=", contactId)
    .orderBy("created_at", "asc")
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function customFieldInAccount(db: Db, accountId: string, fieldId: string): Promise<boolean> {
  const row = await db
    .selectFrom("custom_fields")
    .select("id")
    .where("id", "=", fieldId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return Boolean(row);
}

// ---- contact reads / writes -----------------------------------------

/** Contact columns a condition may read. Anything else reads as absent. */
const READABLE_CONTACT_FIELDS = new Set([
  "id",
  "name",
  "phone",
  "email",
  "company",
  "avatar_url",
  "phone_normalized",
  "wa_user_id",
  "wa_parent_user_id",
  "wa_username",
  "created_at",
  "updated_at",
]);

/**
 * One contact column's value (null when unset). `undefined` when the
 * contact isn't in the account or the column isn't readable.
 */
export async function getContactFieldValue(
  db: Db,
  accountId: string,
  contactId: string,
  field: string,
): Promise<unknown> {
  if (!READABLE_CONTACT_FIELDS.has(field)) return undefined;
  const row = await db
    .selectFrom("contacts")
    .select(sql<unknown>`${sql.ref(`contacts.${field}`)}`.as("value"))
    .where("id", "=", contactId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return row ? row.value : undefined;
}

export type WritableContactField = "name" | "email" | "company";

export async function updateContactField(
  db: Db,
  accountId: string,
  contactId: string,
  field: WritableContactField,
  value: string,
): Promise<void> {
  await db
    .updateTable("contacts")
    .set({ [field]: value, updated_at: sql<string>`now()` })
    .where("id", "=", contactId)
    .where("account_id", "=", accountId)
    .execute();
}

/** Upsert on UNIQUE(contact_id, custom_field_id); no-op for a foreign contact. */
export async function upsertContactCustomValue(
  db: Db,
  accountId: string,
  contactId: string,
  customFieldId: string,
  value: string,
): Promise<void> {
  if (!(await contactInAccount(db, accountId, contactId))) return;
  await db
    .insertInto("contact_custom_values")
    .values({ contact_id: contactId, custom_field_id: customFieldId, value })
    .onConflict((oc) => oc.columns(["contact_id", "custom_field_id"]).doUpdateSet({ value }))
    .execute();
}

export async function contactHasTag(db: Db, accountId: string, contactId: string, tagId: string): Promise<boolean> {
  const row = await db
    .selectFrom("contact_tags")
    .innerJoin("contacts", "contacts.id", "contact_tags.contact_id")
    .select("contact_tags.id")
    .where("contact_tags.contact_id", "=", contactId)
    .where("contact_tags.tag_id", "=", tagId)
    .where("contacts.account_id", "=", accountId)
    .executeTakeFirst();
  return Boolean(row);
}

/** Remove a tag from a contact of this account (no-op when absent). */
export async function deleteContactTag(db: Db, accountId: string, contactId: string, tagId: string): Promise<void> {
  await db
    .deleteFrom("contact_tags")
    .where("contact_id", "=", contactId)
    .where("tag_id", "=", tagId)
    .where("contact_id", "in", (eb) =>
      eb.selectFrom("contacts").select("id").where("id", "=", contactId).where("account_id", "=", accountId),
    )
    .execute();
}

/** Contact identity a sender needs to address a WhatsApp message. */
export function getSendContact(db: Db, accountId: string, contactId: string) {
  return db
    .selectFrom("contacts")
    .select(["id", "phone", "wa_user_id"])
    .where("id", "=", contactId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}

export async function updateContactPhone(db: Db, accountId: string, contactId: string, phone: string): Promise<void> {
  await db
    .updateTable("contacts")
    .set({ phone })
    .where("id", "=", contactId)
    .where("account_id", "=", accountId)
    .execute();
}

// ---- conversations ---------------------------------------------------

export async function assignContactConversations(
  db: Db,
  accountId: string,
  contactId: string,
  agentId: string,
): Promise<void> {
  await db
    .updateTable("conversations")
    .set({ assigned_agent_id: agentId })
    .where("account_id", "=", accountId)
    .where("contact_id", "=", contactId)
    .execute();
}

export async function closeContactConversations(db: Db, accountId: string, contactId: string): Promise<void> {
  await db
    .updateTable("conversations")
    .set({ status: "closed", updated_at: sql<string>`now()` })
    .where("account_id", "=", accountId)
    .where("contact_id", "=", contactId)
    .execute();
}

/** Flip a conversation to `pending` (handoff), optionally assigning an agent. */
export async function handoffConversation(
  db: Db,
  accountId: string,
  conversationId: string,
  assignTo?: string | null,
): Promise<void> {
  await db
    .updateTable("conversations")
    .set({
      status: "pending",
      updated_at: sql<string>`now()`,
      ...(assignTo ? { assigned_agent_id: assignTo } : {}),
    })
    .where("id", "=", conversationId)
    .where("account_id", "=", accountId)
    .execute();
}

// ---- outbound bot messages ------------------------------------------

export interface BotMessageInput {
  conversationId: string;
  contentType: string;
  contentText: string | null;
  waMessageId: string;
  templateName?: string | null;
  interactivePayload?: unknown;
  aiGenerated?: boolean;
  /** Conversation-list preview text. */
  preview: string | null;
}

/**
 * Persist a message the bot already sent through Meta and bump the
 * conversation preview. The insert is guarded by the conversation's
 * account (INSERT … SELECT), so a foreign conversation id writes
 * nothing; returns false in that case.
 */
export async function recordBotMessage(db: Db, accountId: string, input: BotMessageInput): Promise<boolean> {
  const inserted = await db
    .insertInto("messages")
    .columns([
      "conversation_id",
      "sender_type",
      "content_type",
      "content_text",
      "template_name",
      "interactive_payload",
      "message_id",
      "status",
      "ai_generated",
    ])
    .expression((eb) =>
      eb
        .selectFrom("conversations")
        .select([
          "conversations.id",
          sql.lit("bot").as("sender_type"),
          sql<string>`${input.contentType}::text`.as("content_type"),
          sql<string | null>`${input.contentText}::text`.as("content_text"),
          sql<string | null>`${input.templateName ?? null}::text`.as("template_name"),
          (input.interactivePayload === undefined ? sql<Json>`NULL::jsonb` : jsonb(input.interactivePayload)).as(
            "interactive_payload",
          ),
          sql<string>`${input.waMessageId}::text`.as("message_id"),
          sql.lit("sent").as("status"),
          sql<boolean>`${input.aiGenerated ?? false}::boolean`.as("ai_generated"),
        ])
        .where("conversations.id", "=", input.conversationId)
        .where("conversations.account_id", "=", accountId),
    )
    .returning("id")
    .executeTakeFirst();
  if (!inserted) return false;

  await db
    .updateTable("conversations")
    .set({
      last_message_text: input.preview,
      last_message_at: sql<string>`now()`,
      updated_at: sql<string>`now()`,
    })
    .where("id", "=", input.conversationId)
    .where("account_id", "=", accountId)
    .execute();
  return true;
}

/** Our `messages.id` for a Meta message id, within this account. */
export async function findMessageIdByWaId(db: Db, accountId: string, waMessageId: string): Promise<string | null> {
  const row = await db
    .selectFrom("messages")
    .innerJoin("conversations", "conversations.id", "messages.conversation_id")
    .select("messages.id")
    .where("messages.message_id", "=", waMessageId)
    .where("conversations.account_id", "=", accountId)
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}

// ---- misc -----------------------------------------------------------

/** Any member of the account (the automation "round robin" placeholder). */
export async function firstAccountMemberUserId(db: Db, accountId: string): Promise<string | null> {
  const row = await db
    .selectFrom("profiles")
    .select("user_id")
    .where("account_id", "=", accountId)
    .limit(1)
    .executeTakeFirst();
  return row?.user_id ?? null;
}

export async function getAccountDefaultCurrency(db: Db, accountId: string): Promise<string | null> {
  const row = await db.selectFrom("accounts").select("default_currency").where("id", "=", accountId).executeTakeFirst();
  return row?.default_currency ?? null;
}

export async function insertDeal(
  db: Db,
  values: {
    account_id: string;
    user_id: string;
    pipeline_id: string;
    stage_id: string;
    contact_id: string | null;
    title: string;
    value: number;
    currency: string;
  },
): Promise<void> {
  await db
    .insertInto("deals")
    .values({ ...values, status: "open" })
    .execute();
}
