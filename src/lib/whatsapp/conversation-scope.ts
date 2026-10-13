import { asService } from '@/server/db'
import { conversationInAccount } from '@/server/repos/engine-data'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

// ------------------------------------------------------------
// Conversation tenancy guard for the service-role send paths.
//
// Both engines persist an outbound message (a `messages` insert keyed
// on `conversation_id`) plus a `conversations` preview update as the
// service role — so RLS does not scope either write.
//
// The engines already refuse a contact outside the account. A
// conversation id was taken on trust, which is what made
// GHSA-m4fx-g6pr-hrw8 exploitable: the manual trigger at
// POST /api/automations/engine copies `body.context` verbatim into the
// run, so `context.conversation_id` is caller-controlled, and a known
// foreign UUID wrote a message row into another tenant's thread.
//
// Callers check here before the Meta call rather than after: once Meta
// has the message it is delivered, and there is nothing left to undo.
// (The message insert itself is also account-guarded — see
// recordBotMessage — as a second line of defense.)
// ------------------------------------------------------------

/**
 * Throw unless `conversationId` is a conversation of `accountId`.
 *
 * The message is deliberately the same for "no such conversation" and
 * "not yours" — the engines surface it into automation logs the
 * triggering user can read, and distinguishing the two would confirm
 * whether a given UUID exists.
 */
export async function assertConversationInAccount(
  conversationId: string,
  accountId: string,
): Promise<void> {
  let found: boolean
  try {
    found = await asService((db) => conversationInAccount(db, accountId, conversationId))
  } catch (error) {
    throw new Error(
      t('send.conversationLookupFailed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  if (!found) {
    throw new Error(t('send.conversationNotFound'))
  }
}
