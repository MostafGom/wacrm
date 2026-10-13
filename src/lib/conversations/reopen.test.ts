import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule())
vi.mock('@/server/repos/inbound-messages', () => ({
  reopenConversationIfClosed: vi.fn(async () => true),
}))

import { reopenClosedConversation } from './reopen'
import { reopenConversationIfClosed } from '@/server/repos/inbound-messages'

/**
 * Regression cover for issue #409's "closed conversation lockout": an
 * inbound message bumped `unread_count` but never touched `status`, so a
 * closed thread accumulated unread customer messages while still reading
 * as resolved and staying out of the inbox's Open filter.
 *
 * The SQL side — `status = 'open'` written only while the row is still
 * `closed` (the guard against a stale snapshot overwriting an agent's
 * re-close) and only inside the account — is covered against real
 * Postgres in src/server/repos/inbound-messages.int.test.ts.
 */

const repo = vi.mocked(reopenConversationIfClosed)

beforeEach(() => {
  repo.mockResolvedValue(true)
})

describe('reopenClosedConversation', () => {
  it('flips a closed conversation back to open, scoped to the account', async () => {
    const reopened = await reopenClosedConversation('acc-1', {
      id: 'conv-1',
      status: 'closed',
    })

    expect(reopened).toBe(true)
    expect(repo).toHaveBeenCalledTimes(1)
    expect(repo).toHaveBeenCalledWith(expect.anything(), 'acc-1', 'conv-1')
  })

  it.each(['open', 'pending'])(
    'issues no query for a %s conversation',
    async (status) => {
      const reopened = await reopenClosedConversation('acc-1', {
        id: 'conv-1',
        status,
      })

      expect(reopened).toBe(false)
      expect(repo).not.toHaveBeenCalled()
    },
  )

  it('issues no query when status is missing', async () => {
    expect(await reopenClosedConversation('acc-1', { id: 'conv-1' })).toBe(false)
    expect(repo).not.toHaveBeenCalled()
  })

  it('swallows a failed update so inbound processing continues', async () => {
    // Throwing here would abort the webhook and make Meta redeliver the
    // message — a worse outcome than a thread that stays closed.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    repo.mockRejectedValueOnce(new Error('permission denied'))

    await expect(
      reopenClosedConversation('acc-1', { id: 'conv-1', status: 'closed' }),
    ).resolves.toBe(false)

    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
