// Route-level tests for /api/deals/**: role gates (viewer reads, agent
// writes deals, admin sets the default currency), body validation and
// the tenancy check on references. SQL lives in deals.int.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const caller = vi.hoisted(() => ({ userId: 'user-1' as string | null, accountId: 'acct-1', role: 'agent' as string | null }))
vi.mock('@/lib/auth/server-session', async () => (await import('@/test/auth-mocks')).sessionModule(caller))
vi.mock('@/server/repos/profiles', async () => (await import('@/test/auth-mocks')).profilesModule(caller))
vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule())
// requireRole still builds the transitional request-scoped client, which reads cookies.
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() }))

const repo = vi.hoisted(() => ({
  listDeals: vi.fn(),
  getDeal: vi.fn(),
  dealRefsValid: vi.fn(),
  insertDeal: vi.fn(),
  updateDeal: vi.fn(),
  deleteDeal: vi.fn(),
  listContactOptions: vi.fn(),
  listAssigneeOptions: vi.fn(),
  latestConversationForContact: vi.fn(),
  setAccountDefaultCurrency: vi.fn(),
}))
vi.mock('@/server/repos/deals', () => repo)

import { GET as listRoute, POST as createRoute } from './route'
import { DELETE as deleteRoute, PATCH as patchRoute } from './[id]/route'
import { GET as optionsRoute } from './form-options/route'
import { PATCH as currencyRoute } from './default-currency/route'

const PID = '11111111-1111-4111-8111-111111111111'
const SID = '22222222-2222-4222-8222-222222222222'
const CID = '33333333-3333-4333-8333-333333333333'
const DID = '44444444-4444-4444-8444-444444444444'

function req(method: string, body?: unknown, url = 'http://localhost/api/deals') {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
const params = { params: Promise.resolve({ id: DID }) }

beforeEach(() => {
  caller.userId = 'user-1'
  caller.role = 'agent'
  Object.values(repo).forEach((fn) => fn.mockReset())
  repo.dealRefsValid.mockResolvedValue(true)
})

describe('GET /api/deals', () => {
  it('lists a pipeline for viewers', async () => {
    caller.role = 'viewer'
    repo.listDeals.mockResolvedValue([{ id: DID, contact: null, assignee: null }])
    const res = await listRoute(req('GET', undefined, `http://localhost/api/deals?pipelineId=${PID}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deals: [{ id: DID, contact: null, assignee: null }] })
    expect(repo.listDeals).toHaveBeenCalledWith({}, 'acct-1', PID)
  })

  it('requires a pipeline id', async () => {
    expect((await listRoute(req('GET'))).status).toBe(400)
  })
})

describe('POST /api/deals', () => {
  const body = {
    title: ' Deal ',
    value: 10.5,
    currency: 'EUR',
    contact_id: CID,
    pipeline_id: PID,
    stage_id: SID,
    assigned_to: null,
    notes: null,
    expected_close_date: '2026-12-31',
  }

  it('creates an open deal stamped with the caller and account', async () => {
    repo.insertDeal.mockResolvedValue({ id: DID })
    const res = await createRoute(req('POST', body))
    expect(res.status).toBe(201)
    expect(repo.dealRefsValid).toHaveBeenCalledWith({}, 'acct-1', {
      pipelineId: PID,
      stageId: SID,
      contactId: CID,
      assignedTo: null,
    })
    expect(repo.insertDeal).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ title: 'Deal', status: 'open', account_id: 'acct-1', user_id: 'user-1', value: 10.5 }),
    )
  })

  it('is agent+ (viewers are refused)', async () => {
    caller.role = 'viewer'
    expect((await createRoute(req('POST', body))).status).toBe(403)
  })

  it('rejects missing fields, bad values and foreign references', async () => {
    expect((await createRoute(req('POST', { ...body, stage_id: undefined }))).status).toBe(400)
    expect((await createRoute(req('POST', { ...body, value: 'lots' }))).status).toBe(400)
    expect((await createRoute(req('POST', { ...body, expected_close_date: 'soon' }))).status).toBe(400)
    repo.dealRefsValid.mockResolvedValue(false)
    expect((await createRoute(req('POST', body))).status).toBe(400)
    expect(repo.insertDeal).not.toHaveBeenCalled()
  })
})

describe('/api/deals/[id]', () => {
  it('moves a deal to another stage of its pipeline (drag and drop)', async () => {
    repo.getDeal.mockResolvedValue({ id: DID, pipeline_id: PID, stage_id: 'old' })
    repo.updateDeal.mockResolvedValue({ id: DID, stage_id: SID })
    const res = await patchRoute(req('PATCH', { stage_id: SID }), params)
    expect(res.status).toBe(200)
    expect(repo.dealRefsValid).toHaveBeenCalledWith({}, 'acct-1', {
      pipelineId: PID,
      stageId: SID,
      contactId: undefined,
      assignedTo: undefined,
    })
    expect(repo.updateDeal).toHaveBeenCalledWith({}, 'acct-1', DID, { stage_id: SID })
  })

  it('changes status without a reference check', async () => {
    repo.updateDeal.mockResolvedValue({ id: DID, status: 'won' })
    expect((await patchRoute(req('PATCH', { status: 'won' }), params)).status).toBe(200)
    expect(repo.getDeal).not.toHaveBeenCalled()
    expect((await patchRoute(req('PATCH', { status: 'maybe' }), params)).status).toBe(400)
  })

  it('404s an unknown deal and refuses viewers', async () => {
    repo.updateDeal.mockResolvedValue(undefined)
    expect((await patchRoute(req('PATCH', { title: 'x' }), params)).status).toBe(404)
    caller.role = 'viewer'
    expect((await patchRoute(req('PATCH', { title: 'x' }), params)).status).toBe(403)
    expect((await deleteRoute(req('DELETE'), params)).status).toBe(403)
  })

  it('deletes (agent)', async () => {
    repo.deleteDeal.mockResolvedValue(true)
    expect((await deleteRoute(req('DELETE'), params)).status).toBe(200)
    expect(repo.deleteDeal).toHaveBeenCalledWith({}, 'acct-1', DID)
  })
})

describe('GET /api/deals/form-options', () => {
  it('returns the pickers', async () => {
    caller.role = 'viewer'
    repo.listContactOptions.mockResolvedValue([{ id: CID, name: 'A', phone: '+1' }])
    repo.listAssigneeOptions.mockResolvedValue([])
    const res = await optionsRoute(req('GET', undefined, 'http://localhost/api/deals/form-options'))
    expect(await res.json()).toEqual({ contacts: [{ id: CID, name: 'A', phone: '+1' }], profiles: [] })
  })

  it("returns the contact's latest conversation (or null)", async () => {
    repo.latestConversationForContact.mockResolvedValue(undefined)
    const res = await optionsRoute(req('GET', undefined, `http://localhost/api/deals/form-options?contactId=${CID}`))
    expect(await res.json()).toEqual({ conversation: null })
    expect(repo.latestConversationForContact).toHaveBeenCalledWith({}, 'acct-1', CID)
  })
})

describe('PATCH /api/deals/default-currency', () => {
  it('is admin-only', async () => {
    expect((await currencyRoute(req('PATCH', { currency: 'EUR' }))).status).toBe(403)
    expect(repo.setAccountDefaultCurrency).not.toHaveBeenCalled()
  })

  it('validates and saves a 3-letter code', async () => {
    caller.role = 'admin'
    repo.setAccountDefaultCurrency.mockResolvedValue(true)
    expect((await currencyRoute(req('PATCH', { currency: 'eur' }))).status).toBe(400)
    expect((await currencyRoute(req('PATCH', { currency: 'EUR' }))).status).toBe(200)
    expect(repo.setAccountDefaultCurrency).toHaveBeenCalledWith({}, 'acct-1', 'EUR')
  })
})
