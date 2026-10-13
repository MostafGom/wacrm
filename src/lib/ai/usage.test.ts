import { describe, it, expect, vi } from 'vitest'
import type { Db, Runner } from '@/server/db'

const h = vi.hoisted(() => ({ insertAiUsageLog: vi.fn() }))
vi.mock('@/server/repos/ai-usage', () => h)

import { logAiUsage } from './usage'

const run: Runner = (fn) => fn({} as Db)

describe('logAiUsage', () => {
  it('inserts a row mapping normalized usage to the log columns', async () => {
    h.insertAiUsageLog.mockResolvedValue(undefined)
    await logAiUsage(run, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    expect(h.insertAiUsageLog).toHaveBeenCalledWith({}, {
      account_id: 'acct-1',
      conversation_id: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      prompt_tokens: 30,
      completion_tokens: 6,
      total_tokens: 36,
    })
  })

  it('is a no-op when the provider reported no usage', async () => {
    await logAiUsage(run, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-x',
      usage: null,
    })
    expect(h.insertAiUsageLog).not.toHaveBeenCalled()
  })

  it('never throws when the insert errors', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.insertAiUsageLog.mockRejectedValue(new Error('boom'))
    await expect(
      logAiUsage(run, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        mode: 'draft',
        provider: 'openai',
        model: 'gpt-x',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    ).resolves.toBeUndefined()
    err.mockRestore()
  })
})
