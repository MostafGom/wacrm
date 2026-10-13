import { describe, it, expect, vi } from 'vitest'
import type { Db, Runner } from '@/server/db'

const h = vi.hoisted(() => ({ listRecentTextMessages: vi.fn() }))
vi.mock('@/server/repos/ai-conversations', () => h)

import { buildConversationContext } from './context'

const run: Runner = (fn) => fn({} as Db)

/** The repo returns rows newest-first (created_at DESC). */
function rows(r: { sender_type: string; content_text: string | null }[]) {
  h.listRecentTextMessages.mockResolvedValue(r)
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    rows([
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ])
    const out = await buildConversationContext(run, 'acct-1', 'conv-1', 7)
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
    expect(h.listRecentTextMessages).toHaveBeenCalledWith({}, 'acct-1', 'conv-1', 7)
  })

  it('treats bot messages as assistant', async () => {
    rows([{ sender_type: 'bot', content_text: 'auto reply' }])
    const out = await buildConversationContext(run, 'acct-1', 'conv-1')
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    rows([
      { sender_type: 'customer', content_text: '   ' },
      { sender_type: 'customer', content_text: null },
      { sender_type: 'customer', content_text: 'real' },
    ])
    const out = await buildConversationContext(run, 'acct-1', 'conv-1')
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })
})
