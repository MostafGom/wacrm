import { beforeEach, describe, expect, it, vi } from 'vitest'

// A campaign that is still sending can't be deleted: the detail page
// disables Delete ("Cannot delete while a broadcast is actively
// sending"), and the API must refuse the same request.

const caller = vi.hoisted(() => ({ userId: 'user-1' as string | null, accountId: 'acct-1', role: 'agent' as string | null }))

vi.mock('@/lib/auth/server-session', async () => (await import('@/test/auth-mocks')).sessionModule(caller))
vi.mock('@/server/repos/profiles', async () => (await import('@/test/auth-mocks')).profilesModule(caller))
vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule())

const repo = vi.hoisted(() => ({
  deleteBroadcast: vi.fn(async () => true),
  getBroadcast: vi.fn(async (): Promise<{ id: string; status: string } | undefined> => ({ id: 'b-1', status: 'sent' })),
  listRecipientsWithContact: vi.fn(async () => []),
  setBroadcastStatus: vi.fn(async () => true),
}))
vi.mock('@/server/repos/broadcasts', () => repo)

import { DELETE } from './route'

const ID = '11111111-1111-4111-8111-111111111111'
const del = () => DELETE(new Request(`http://localhost/api/broadcasts/${ID}`, { method: 'DELETE' }), { params: Promise.resolve({ id: ID }) })

beforeEach(() => {
  caller.role = 'agent'
  repo.deleteBroadcast.mockClear()
  repo.getBroadcast.mockResolvedValue({ id: ID, status: 'sent' })
})

describe('DELETE /api/broadcasts/[id]', () => {
  it('deletes a finished broadcast', async () => {
    const res = await del()
    expect(res.status).toBe(200)
    expect(repo.deleteBroadcast).toHaveBeenCalledTimes(1)
  })

  it('refuses with 409 while the broadcast is sending', async () => {
    repo.getBroadcast.mockResolvedValue({ id: ID, status: 'sending' })
    const res = await del()
    expect(res.status).toBe(409)
    expect(repo.deleteBroadcast).not.toHaveBeenCalled()
  })

  it('404s for a broadcast outside the account', async () => {
    repo.getBroadcast.mockResolvedValue(undefined)
    const res = await del()
    expect(res.status).toBe(404)
    expect(repo.deleteBroadcast).not.toHaveBeenCalled()
  })

  it('is agent+ (viewer → 403)', async () => {
    caller.role = 'viewer'
    const res = await del()
    expect(res.status).toBe(403)
    expect(repo.deleteBroadcast).not.toHaveBeenCalled()
  })
})
