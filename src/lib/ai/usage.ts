import type { Runner } from '@/server/db'
import { insertAiUsageLog } from '@/server/repos/ai-usage'
import type { AiProvider, AiUsage } from './types'

export interface LogAiUsageArgs {
  accountId: string
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
  conversationId: string | null
  mode: 'auto_reply' | 'draft'
  provider: AiProvider
  model: string
  /** Provider usage; a no-op when null (nothing worth recording). */
  usage: AiUsage | null
}

/**
 * Best-effort append to `ai_usage_log` — one row per LLM call, for cost
 * visibility on the account's BYO key. NEVER throws: usage accounting
 * must not fail a reply the customer is waiting on, so any DB error is
 * logged and swallowed. Skips entirely when the provider didn't report
 * usage (we'd only be writing zeros).
 *
 * Pass `serviceRunner`: there's no `authenticated` INSERT policy on the
 * log, so a user-role write would be rejected (and swallowed here).
 */
export async function logAiUsage(
  run: Runner,
  args: LogAiUsageArgs,
): Promise<void> {
  if (!args.usage) return
  const usage = args.usage
  try {
    await run((db) =>
      insertAiUsageLog(db, {
        account_id: args.accountId,
        conversation_id: args.conversationId,
        mode: args.mode,
        provider: args.provider,
        model: args.model,
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      }),
    )
  } catch (err) {
    console.error('[ai usage] log insert failed:', err)
  }
}
