import type { Runner } from '@/server/db'
import { listRecentTextMessages } from '@/server/repos/ai-conversations'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  run: Runner,
  accountId: string,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  // Newest-first from the DB; reversed to chronological below.
  const rows = await run((db) =>
    listRecentTextMessages(db, accountId, conversationId, limit),
  )

  return [...rows]
    .reverse()
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text!.trim(),
    }))
}
