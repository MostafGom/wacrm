import { beforeEach, describe, expect, it, vi } from 'vitest'

// /api/broadcasts + /api/broadcasts/[id]/results — role gates, the
// no-contacts answer the wizard maps to its own message, and the
// per-recipient params frozen at create time (issue #472).

const caller = vi.hoisted(() => ({ userId: 'user-1', accountId: 'acct-1', role: 'agent' as string | null }))
vi.mock('@/lib/auth/server-session', async () => (await import('@/test/auth-mocks')).sessionModule(caller))
vi.mock('@/server/repos/profiles', async () => (await import('@/test/auth-mocks')).profilesModule(caller))
vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule())

const audienceRepo = vi.hoisted(() => ({
  resolveAudienceContacts: vi.fn(),
  customValueIndex: vi.fn(),
  countAudience: vi.fn(),
}))
vi.mock('@/server/repos/broadcast-audience', () => audienceRepo)

const repo = vi.hoisted(() => ({
  insertBroadcast: vi.fn(),
  insertPendingRecipients: vi.fn(),
  listBroadcasts: vi.fn(),
  stampRecipient: vi.fn(),
}))
vi.mock('@/server/repos/broadcasts', () => repo)

import { POST } from './route'
import { POST as POST_RESULTS } from './[id]/results/route'

const FIELD = '33333333-3333-4333-8333-333333333333'
const BROADCAST_ID = '44444444-4444-4444-8444-444444444444'
const RECIPIENT_ID = '55555555-5555-4555-8555-555555555555'

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const SEND_BODY = {
  name: 'Promo',
  template_name: 'promo',
  template_language: 'en_US',
  template_variables: {
    '2': { type: 'custom_field', value: FIELD },
    '1': { type: 'field', value: 'name' },
  },
  audience: { type: 'all' },
}

beforeEach(() => {
  caller.role = 'agent'
  for (const fn of [...Object.values(repo), ...Object.values(audienceRepo)]) fn.mockReset()
})

describe('POST /api/broadcasts', () => {
  it('refuses a viewer before touching the database', async () => {
    caller.role = 'viewer'
    const res = await post(SEND_BODY)
    expect(res.status).toBe(403)
    expect(audienceRepo.resolveAudienceContacts).not.toHaveBeenCalled()
  })

  it('answers 400 no_contacts when the audience resolves to nobody', async () => {
    audienceRepo.resolveAudienceContacts.mockResolvedValue([])
    const res = await post(SEND_BODY)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('no_contacts')
    expect(repo.insertBroadcast).not.toHaveBeenCalled()
  })

  it('freezes each recipient\'s params and returns the send plan', async () => {
    audienceRepo.resolveAudienceContacts.mockResolvedValue([
      { id: 'c1', name: 'Ann', phone: '+15550001' },
    ])
    audienceRepo.customValueIndex.mockResolvedValue(new Map([['c1', new Map([[FIELD, 'gold']])]]))
    repo.insertBroadcast.mockResolvedValue({ id: BROADCAST_ID, status: 'sending' })
    repo.insertPendingRecipients.mockImplementation(
      async (_db: unknown, _id: string, rows: { contactId: string; params: string[] }[]) =>
        rows.map((r) => ({ id: RECIPIENT_ID, contact_id: r.contactId, template_params: r.params })),
    )

    const res = await post(SEND_BODY)
    expect(res.status).toBe(201)
    expect(repo.insertBroadcast).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ account_id: 'acct-1', user_id: 'user-1', status: 'sending', total_recipients: 1 }),
    )
    expect(await res.json()).toEqual({
      broadcast: { id: BROADCAST_ID, status: 'sending' },
      recipients: [{ id: RECIPIENT_ID, phone: '+15550001', template_params: ['Ann', 'gold'] }],
    })
  })

  it('saves a draft without resolving the audience', async () => {
    repo.insertBroadcast.mockResolvedValue({ id: BROADCAST_ID, status: 'draft' })
    const res = await post({ ...SEND_BODY, draft: true })
    expect(res.status).toBe(201)
    expect(audienceRepo.resolveAudienceContacts).not.toHaveBeenCalled()
    expect(repo.insertBroadcast.mock.calls[0][1]).toMatchObject({
      status: 'draft',
      total_recipients: 0,
      audience_filter: { type: 'all' },
    })
  })

  it('stores the header media URL so a server-side resume can resend it', async () => {
    audienceRepo.resolveAudienceContacts.mockResolvedValue([{ id: 'c1', name: 'Ann', phone: '+15550001' }])
    audienceRepo.customValueIndex.mockResolvedValue(new Map())
    repo.insertBroadcast.mockResolvedValue({ id: BROADCAST_ID, status: 'sending' })
    repo.insertPendingRecipients.mockResolvedValue([])

    const res = await post({ ...SEND_BODY, header_media_url: ' https://cdn.example.com/promo.png ' })
    expect(res.status).toBe(201)
    expect(repo.insertBroadcast.mock.calls[0][1]).toMatchObject({
      header_media_url: 'https://cdn.example.com/promo.png',
    })
  })

  it('rejects a header media URL that is not http(s)', async () => {
    const res = await post({ ...SEND_BODY, header_media_url: 'javascript:alert(1)' })
    expect(res.status).toBe(400)
    expect(repo.insertBroadcast).not.toHaveBeenCalled()
  })

  it('rejects a malformed audience', async () => {
    const res = await post({ ...SEND_BODY, audience: { type: 'everyone' } })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/broadcasts/[id]/results', () => {
  function postResults(body: unknown) {
    return POST_RESULTS(
      new Request(`http://localhost/api/broadcasts/${BROADCAST_ID}/results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: BROADCAST_ID }) },
    )
  }

  it('stamps each outcome scoped to the caller\'s account', async () => {
    repo.stampRecipient.mockResolvedValue(true)
    const res = await postResults({
      results: [
        { id: RECIPIENT_ID, status: 'sent', whatsapp_message_id: 'wamid-1' },
        { id: RECIPIENT_ID, status: 'failed', error_message: 'No phone number on contact' },
      ],
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ updated: 2 })
    expect(repo.stampRecipient).toHaveBeenNthCalledWith(1, expect.anything(), 'acct-1', BROADCAST_ID, {
      id: RECIPIENT_ID,
      status: 'sent',
      whatsapp_message_id: 'wamid-1',
    })
  })

  it('refuses a viewer and malformed results', async () => {
    expect((await postResults({ results: [{ id: 'nope', status: 'sent' }] })).status).toBe(400)
    caller.role = 'viewer'
    expect((await postResults({ results: [] })).status).toBe(403)
    expect(repo.stampRecipient).not.toHaveBeenCalled()
  })
})
