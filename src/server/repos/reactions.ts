// Emoji reactions on messages (one per (message, actor), migration 009).

import type { Db } from "@/server/db";

/** Every reaction in a conversation of the account. */
export function listConversationReactions(db: Db, accountId: string, conversationId: string) {
  return db
    .selectFrom("message_reactions")
    .selectAll("message_reactions")
    .where("message_reactions.conversation_id", "=", conversationId)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("conversations")
          .select("conversations.id")
          .whereRef("conversations.id", "=", "message_reactions.conversation_id")
          .where("conversations.account_id", "=", accountId),
      ),
    )
    .execute();
}

/** Set (or swap) the agent's reaction on a message. */
export async function upsertAgentReaction(
  db: Db,
  values: { message_id: string; conversation_id: string; actor_id: string; emoji: string },
): Promise<void> {
  await db
    .insertInto("message_reactions")
    .values({ ...values, actor_type: "agent" })
    .onConflict((oc) =>
      oc
        .columns(["message_id", "actor_type", "actor_id"])
        .doUpdateSet((eb) => ({ emoji: eb.ref("excluded.emoji"), conversation_id: eb.ref("excluded.conversation_id") })),
    )
    .execute();
}

/** Remove the agent's reaction from a message. */
export async function deleteAgentReaction(db: Db, messageId: string, actorId: string): Promise<void> {
  await db
    .deleteFrom("message_reactions")
    .where("message_id", "=", messageId)
    .where("actor_type", "=", "agent")
    .where("actor_id", "=", actorId)
    .execute();
}
