import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetRateLimitForTests } from '@/lib/rate-limit'

const caller = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'agent' }))
// Real error classes / toErrorResponse; only the caller lookup is faked.
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: async (min: string) => {
      if (min === 'admin' && caller.role !== 'admin') throw new actual.ForbiddenError()
      return { userId: 'user-1', accountId: 'acct-1', role: caller.role, account: { id: 'acct-1', name: 'Acme' } }
    },
  }
})
vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule())

const repo = vi.hoisted(() => ({ setMemberRole: vi.fn(), removeAccountMember: vi.fn() }))
vi.mock('@/server/repos/members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/repos/members')>()),
  setMemberRole: repo.setMemberRole,
  removeAccountMember: repo.removeAccountMember,
}))

import { DELETE, PATCH } from './route'

const params = { params: Promise.resolve({ userId: 'target-1' }) }

function patch(body: unknown) {
  return PATCH(
    new Request('http://localhost/api/account/members/target-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params,
  )
}

function pgError(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}

beforeEach(() => {
  __resetRateLimitForTests()
  caller.role = 'admin'
  repo.setMemberRole.mockReset().mockResolvedValue(undefined)
  repo.removeAccountMember.mockReset().mockResolvedValue('new-acct')
})

describe('PATCH /api/account/members/[userId]', () => {
  it('changes the role through the RPC', async () => {
    const res = await patch({ role: 'viewer' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(repo.setMemberRole).toHaveBeenCalledWith({}, 'target-1', 'viewer')
  })

  it('rejects owner promotion before calling the RPC', async () => {
    const res = await patch({ role: 'owner' })
    expect(res.status).toBe(400)
    expect(repo.setMemberRole).not.toHaveBeenCalled()
  })

  it('maps SQLSTATE 42501 → 403 and 22023 → 400 with the RPC message', async () => {
    repo.setMemberRole.mockRejectedValueOnce(pgError('42501', 'Target user is not a member of your account'))
    let res = await patch({ role: 'agent' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Target user is not a member of your account' })

    repo.setMemberRole.mockRejectedValueOnce(pgError('22023', 'Cannot change your own role'))
    res = await patch({ role: 'agent' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Cannot change your own role' })
  })

  it('answers 500 without leaking unexpected errors', async () => {
    repo.setMemberRole.mockRejectedValueOnce(pgError('XX000', 'internal detail'))
    const res = await patch({ role: 'agent' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('internal detail')
  })

  it('403s below admin', async () => {
    caller.role = 'agent'
    const res = await patch({ role: 'viewer' })
    expect(res.status).toBe(403)
    expect(repo.setMemberRole).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/account/members/[userId]', () => {
  it('returns the new personal account id', async () => {
    const res = await DELETE(new Request('http://localhost/api/account/members/target-1', { method: 'DELETE' }), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, newPersonalAccountId: 'new-acct' })
  })
})
