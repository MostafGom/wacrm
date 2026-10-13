import { beforeEach, describe, expect, it, vi } from 'vitest'

const caller = vi.hoisted(() => ({
  userId: 'user-1' as string | null,
  accountId: 'acct-1',
  role: 'agent' as string | null,
}))
vi.mock('@/lib/auth/server-session', async () => (await import('@/test/auth-mocks')).sessionModule(caller))
vi.mock('@/server/repos/profiles', async () => (await import('@/test/auth-mocks')).profilesModule(caller))
vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule())
// The account context still builds the transitional request-scoped
// client from cookies; give it an empty cookie jar outside a request.
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
  headers: async () => new Headers(),
}))

const repo = vi.hoisted(() => ({
  getAiConfigSummary: vi.fn(),
  getAiConfigCredentials: vi.fn(),
  insertAiConfig: vi.fn(),
  updateAiConfig: vi.fn(),
  deleteAiConfig: vi.fn(),
  isAccountMember: vi.fn(),
}))
vi.mock('@/server/repos/ai-config', () => repo)

import { DELETE, GET } from './route'

beforeEach(() => {
  caller.userId = 'user-1'
  caller.role = 'agent'
})

describe('GET /api/ai/config', () => {
  it('returns configured:false when there is no row', async () => {
    repo.getAiConfigSummary.mockResolvedValue(undefined)
    const res = await GET()
    expect(await res.json()).toEqual({ configured: false })
  })

  it('returns has_* flags and settings, never key material', async () => {
    repo.getAiConfigSummary.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-x',
      base_url: null,
      system_prompt: null,
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
      handoff_agent_id: null,
      has_key: true,
      has_embeddings_key: false,
    })
    const res = await GET()
    const body = await res.json()
    expect(body).toEqual({
      configured: true,
      has_key: true,
      has_embeddings_key: false,
      provider: 'openai',
      model: 'gpt-x',
      base_url: null,
      system_prompt: null,
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
      handoff_agent_id: null,
    })
    expect(body).not.toHaveProperty('api_key')
    expect(body).not.toHaveProperty('embeddings_api_key')
    expect(repo.getAiConfigSummary).toHaveBeenCalledWith({}, 'acct-1')
  })

  it('500s with the load error when the read fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    repo.getAiConfigSummary.mockRejectedValue(new Error('db down'))
    const res = await GET()
    expect(res.status).toBe(500)
    err.mockRestore()
  })
})

describe('DELETE /api/ai/config', () => {
  it('is admin-only', async () => {
    const res = await DELETE()
    expect(res.status).toBe(403)
    expect(repo.deleteAiConfig).not.toHaveBeenCalled()
  })

  it('deletes the account config for an admin', async () => {
    caller.role = 'admin'
    const res = await DELETE()
    expect(await res.json()).toEqual({ success: true })
    expect(repo.deleteAiConfig).toHaveBeenCalledWith({}, 'acct-1')
  })
})
