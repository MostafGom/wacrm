// Delivery-status webhooks (sent / delivered / read / failed) mirrored
// onto `messages` and `broadcast_recipients`. Service role; scoped to
// the account that owns the phone number the status arrived on.

import type { Updateable } from "kysely";

import type { DB, Db } from "@/server/db";

export type MessageStatusPatch = Pick<
  Updateable<DB["messages"]>,
  "status" | "error_code" | "error_title" | "error_details"
>;

/**
 * Apply a status to every message in the account carrying `wamid`.
 * message_id is NOT unique on its own (migration 009 — Meta ids repeat
 * across numbers), so this updates 0..N rows. Returns one matched
 * conversation id (for the webhook fan-out), or null when none matched.
 */
export async function updateMessageStatusByWamid(
  db: Db,
  accountId: string,
  wamid: string,
  patch: MessageStatusPatch,
): Promise<string | null> {
  const rows = await db
    .updateTable("messages")
    .set(patch)
    .where("message_id", "=", wamid)
    .where("conversation_id", "in", (eb) =>
      eb.selectFrom("conversations").select("id").where("account_id", "=", accountId),
    )
    .returning("conversation_id")
    .execute();
  return rows[0]?.conversation_id ?? null;
}

/** The account's broadcast recipient row for an outbound wamid, locked for the ladder check. */
export async function findBroadcastRecipientByWamid(
  db: Db,
  accountId: string,
  wamid: string,
): Promise<{ id: string; status: string } | null> {
  const row = await db
    .selectFrom("broadcast_recipients as r")
    .innerJoin("broadcasts as b", "b.id", "r.broadcast_id")
    .select(["r.id", "r.status"])
    .where("r.whatsapp_message_id", "=", wamid)
    .where("b.account_id", "=", accountId)
    .limit(1)
    .forUpdate("r")
    .executeTakeFirst();
  return row ?? null;
}

export type RecipientStatusPatch = Pick<
  Updateable<DB["broadcast_recipients"]>,
  "status" | "sent_at" | "delivered_at" | "read_at" | "error_message"
>;

/** Update one recipient row (id resolved by findBroadcastRecipientByWamid). */
export async function updateBroadcastRecipient(db: Db, recipientId: string, patch: RecipientStatusPatch): Promise<void> {
  await db.updateTable("broadcast_recipients").set(patch).where("id", "=", recipientId).execute();
}
