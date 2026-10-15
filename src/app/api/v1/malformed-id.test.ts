// A non-uuid {id} in a /api/v1 path is just an unknown resource: 404
// `not_found`, never a 500 from Postgres failing the uuid cast.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  db: vi.fn(() => {
    throw new Error('the database must not be queried for a malformed id')
  }),
}))

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => ({ accountId: 'acc-1', keyId: 'key-1', scopes: [] })),
}))
vi.mock('@/server/db', () => ({
  asService: h.db,
  serviceRunner: () => h.db,
  sql: vi.fn(),
}))

import * as broadcast from './broadcasts/[id]/route'
import * as contact from './contacts/[id]/route'
import * as conversation from './conversations/[id]/route'
import * as messages from './conversations/[id]/messages/route'
import * as webhook from './webhooks/[id]/route'

const params = { params: Promise.resolve({ id: 'not-a-uuid' }) }
const get = () => new Request('http://x/api/v1/thing/not-a-uuid')
const withBody = (method: string) =>
  new Request('http://x/api/v1/thing/not-a-uuid', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', enabled: false }),
  })

const cases: Array<[string, () => Promise<Response>]> = [
  ['GET contacts/{id}', () => contact.GET(get(), params)],
  ['PATCH contacts/{id}', () => contact.PATCH(withBody('PATCH'), params)],
  ['GET conversations/{id}', () => conversation.GET(get(), params)],
  ['GET conversations/{id}/messages', () => messages.GET(get(), params)],
  ['GET broadcasts/{id}', () => broadcast.GET(get(), params)],
  ['GET webhooks/{id}', () => webhook.GET(get(), params)],
  ['PATCH webhooks/{id}', () => webhook.PATCH(withBody('PATCH'), params)],
  ['DELETE webhooks/{id}', () => webhook.DELETE(withBody('DELETE'), params)],
]

describe('/api/v1 malformed ids', () => {
  beforeEach(() => {
    h.db.mockClear()
  })

  it.each(cases)('%s → 404 not_found', async (_name, call) => {
    const res = await call()
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('not_found')
    expect(h.db).not.toHaveBeenCalled()
  })
})
