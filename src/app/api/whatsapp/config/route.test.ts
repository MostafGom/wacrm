import { beforeEach, describe, expect, it, vi } from 'vitest'

// Connecting / disconnecting the WhatsApp number is admin-only, and the
// role check must run BEFORE any Meta call or database write (RLS alone
// would only reject the final write — after the number was registered
// and the WABA subscribed — and a non-admin DELETE used to report
// success while deleting nothing).

const caller = vi.hoisted(() => ({ userId: 'user-1' as string | null, accountId: 'acct-1', role: 'agent' as string | null }))

vi.mock('@/lib/auth/server-session', async () => (await import('@/test/auth-mocks')).sessionModule(caller))
vi.mock('@/server/repos/profiles', async () => (await import('@/test/auth-mocks')).profilesModule(caller))
vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule())

const repo = vi.hoisted(() => ({
  deleteWhatsAppConfig: vi.fn(async () => undefined),
  getExistingConfigForSave: vi.fn(async () => undefined),
  getWhatsAppCredentials: vi.fn(async () => undefined),
  insertWhatsAppConfig: vi.fn(async () => undefined),
  isPhoneNumberClaimedElsewhere: vi.fn(async () => false),
  updateWhatsAppConfig: vi.fn(async () => undefined),
}))
vi.mock('@/server/repos/whatsapp-config', () => repo)

const meta = vi.hoisted(() => ({
  verifyPhoneNumber: vi.fn(async () => ({ id: '123', display_phone_number: '+1 555' })),
  registerPhoneNumber: vi.fn(async () => undefined),
  subscribeWabaToApp: vi.fn(async () => undefined),
  listWabaPhoneNumbers: vi.fn(async () => [{ id: '123' }]),
  getSubscribedApps: vi.fn(async () => []),
}))
vi.mock('@/lib/whatsapp/meta-api', () => meta)

import { DELETE, POST } from './route'

function saveRequest() {
  return new Request('http://localhost/api/whatsapp/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone_number_id: '123', access_token: 'tok', pin: '123456' }),
  })
}

beforeEach(() => {
  caller.userId = 'user-1'
  vi.clearAllMocks()
})

describe('WhatsApp config — admin only', () => {
  it.each(['agent', 'viewer'])('refuses POST for %s before calling Meta or the database', async (role) => {
    caller.role = role
    const res = await POST(saveRequest())
    expect(res.status).toBe(403)
    expect(meta.verifyPhoneNumber).not.toHaveBeenCalled()
    expect(meta.registerPhoneNumber).not.toHaveBeenCalled()
    expect(repo.insertWhatsAppConfig).not.toHaveBeenCalled()
  })

  it.each(['agent', 'viewer'])('refuses DELETE for %s instead of reporting a silent no-op', async (role) => {
    caller.role = role
    const res = await DELETE()
    expect(res.status).toBe(403)
    expect(repo.deleteWhatsAppConfig).not.toHaveBeenCalled()
  })

  it.each(['admin', 'owner'])('lets %s through to the Meta checks and the save', async (role) => {
    caller.role = role
    const res = await POST(saveRequest())
    expect(res.status).toBeLessThan(400)
    expect(meta.verifyPhoneNumber).toHaveBeenCalled()
    expect(repo.insertWhatsAppConfig).toHaveBeenCalled()

    const del = await DELETE()
    expect(del.status).toBe(200)
    expect(repo.deleteWhatsAppConfig).toHaveBeenCalled()
  })

  it('still answers 401 without a session', async () => {
    caller.userId = null
    expect((await POST(saveRequest())).status).toBe(401)
    expect((await DELETE()).status).toBe(401)
  })
})
