import { describe, it, expect, vi, beforeEach } from 'vitest'

// ------------------------------------------------------------
// Regression coverage for GHSA-xvrq-88hg-44q6.
//
// The per-automation handlers used to match the row on
// `automations.user_id` (the immutable author), which a user removed
// from the account still satisfies — `remove_account_member` reseats
// them as `owner` of a fresh personal account, so `requireRole('agent')`
// passes and the account is never compared.
//
// The scenario below is exactly that: caller is an owner of `acc-new`,
// the automation lives in `acc-old`, and `user_id` still matches them.
// Every handler must answer 404 and touch nothing.
//
// The repository is replaced by a fake that applies the same
// (id, account_id) predicate the SQL does, so a handler that forgot to
// pass the caller's account genuinely reaches the foreign row.
// ------------------------------------------------------------

const caller = vi.hoisted(() => ({
  userId: 'user-removed' as string | null,
  accountId: 'acc-new',
  role: 'owner' as string | null,
}))

const h = vi.hoisted(() => ({
  state: {
    /** The one automation row the fake DB holds. */
    row: {
      id: 'auto-1',
      account_id: 'acc-old',
      user_id: 'user-removed',
      name: 'Old account automation',
      description: null as string | null,
      is_active: false,
      trigger_type: 'keyword_match',
      trigger_config: { keywords: ['hi'] },
    } as Record<string, unknown>,
    /** Writes the fake DB accepted, by table + operation. */
    writes: [] as { table: string; op: string; values: Record<string, unknown> }[],
    /** message_templates rows (name, language, body_text) per account. */
    templates: [] as { account_id: string; name: string; language: string | null; body_text: string }[],
  },
}))

vi.mock('@/lib/auth/server-session', async () => (await import('@/test/auth-mocks')).sessionModule(caller))
vi.mock('@/server/repos/profiles', async () => (await import('@/test/auth-mocks')).profilesModule(caller))
vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule())

vi.mock('@/server/repos/automations', () => {
  const { state } = h
  const mine = (accountId: string, id: string) =>
    state.row.id === id && state.row.account_id === accountId
  return {
    getAutomation: async (_db: unknown, accountId: string, id: string) =>
      mine(accountId, id) ? state.row : undefined,
    updateAutomation: async (_db: unknown, accountId: string, id: string, patch: Record<string, unknown>) => {
      if (!mine(accountId, id)) return false
      state.writes.push({ table: 'automations', op: 'update', values: patch })
      return true
    },
    deleteAutomation: async (_db: unknown, accountId: string, id: string) => {
      if (!mine(accountId, id)) return false
      state.writes.push({ table: 'automations', op: 'delete', values: { id } })
      return true
    },
    insertAutomation: async (_db: unknown, values: Record<string, unknown>) => {
      state.writes.push({ table: 'automations', op: 'insert', values })
      return { ...values, id: 'auto-copy' }
    },
    listAutomationSteps: async () => [],
    listTemplateBodies: async (_db: unknown, accountId: string, names: string[]) =>
      state.templates.filter((t) => t.account_id === accountId && names.includes(t.name)),
    insertAutomationSteps: async () => {},
    deleteAutomationSteps: async () => {},
  }
})

import { GET, PATCH, DELETE } from './route'
import { POST as DUPLICATE } from './duplicate/route'

const params = Promise.resolve({ id: 'auto-1' })

beforeEach(() => {
  h.state.writes = []
  h.state.templates = []
  h.state.row.is_active = false
  caller.accountId = 'acc-new'
})

describe('automations/[id] tenancy (GHSA-xvrq-88hg-44q6)', () => {
  it('refuses a removed member who still matches user_id', async () => {
    const get = await GET(new Request('http://t/'), { params })
    expect(get.status).toBe(404)

    const patch = await PATCH(
      new Request('http://t/', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'pwned' }),
      }),
      { params },
    )
    expect(patch.status).toBe(404)

    const del = await DELETE(new Request('http://t/'), { params })
    expect(del.status).toBe(200) // scoped DELETE is a no-op, not an error

    const dup = await DUPLICATE(new Request('http://t/', { method: 'POST' }), { params })
    expect(dup.status).toBe(404)

    // Nothing was written into the account the caller left.
    expect(h.state.writes).toEqual([])
  })

  it('still serves a member of the automation own account', async () => {
    caller.accountId = 'acc-old'

    const get = await GET(new Request('http://t/'), { params })
    expect(get.status).toBe(200)
    expect(((await get.json()) as { automation: { id: string } }).automation.id).toBe('auto-1')

    const patch = await PATCH(
      new Request('http://t/', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'renamed' }),
      }),
      { params },
    )
    expect(patch.status).toBe(200)

    const dup = await DUPLICATE(new Request('http://t/', { method: 'POST' }), { params })
    expect(dup.status).toBe(201)
  })

  it('clones into the caller account, never the row stored account', async () => {
    caller.accountId = 'acc-old'
    await DUPLICATE(new Request('http://t/', { method: 'POST' }), { params })
    const insert = h.state.writes.find(
      (w) => w.table === 'automations' && w.op === 'insert',
    )
    expect(insert).toBeDefined()
    expect(insert!.values.account_id).toBe('acc-old')
    expect(insert!.values.is_active).toBe(false)
  })

  it('a viewer can read but not write', async () => {
    caller.accountId = 'acc-old'
    caller.role = 'viewer'
    try {
      expect((await GET(new Request('http://t/'), { params })).status).toBe(200)
      const patch = await PATCH(
        new Request('http://t/', { method: 'PATCH', body: JSON.stringify({ name: 'x' }) }),
        { params },
      )
      expect(patch.status).toBe(403)
      expect(h.state.writes).toEqual([])
    } finally {
      caller.role = 'owner'
    }
  })
})

describe('PATCH activation validation', () => {
  const patch = (body: Record<string, unknown>) =>
    PATCH(new Request('http://t/', { method: 'PATCH', body: JSON.stringify(body) }), { params })

  beforeEach(() => {
    caller.accountId = 'acc-old'
  })

  it('says "activate" when an inactive automation is being activated', async () => {
    const res = await patch({ is_active: true }) // the row has no steps
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Cannot activate automation with invalid configuration')
    expect(h.state.writes).toEqual([])
  })

  it('says "keep active" when an active automation is edited into an invalid state', async () => {
    h.state.row.is_active = true
    const res = await patch({ steps: [{ step_type: 'send_message', step_config: { text: '' } }] })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Cannot keep automation active with invalid configuration')
  })

  it("requires a value for each of the chosen template's body placeholders", async () => {
    h.state.templates = [
      { account_id: 'acc-old', name: 'order_update', language: 'en_US', body_text: 'Hi {{1}}, order {{2}} shipped' },
      // Another account's template of the same name must not be consulted.
      { account_id: 'acc-new', name: 'order_update', language: 'en_US', body_text: 'Hi {{1}} {{2}} {{3}}' },
    ]
    const step = (variables?: Record<string, string>) => ({
      step_type: 'send_template',
      step_config: { template_name: 'order_update', language: 'en_US', ...(variables ? { variables } : {}) },
    })

    const missing = await patch({ is_active: true, steps: [step({ '1': 'Ann' })] })
    expect(missing.status).toBe(400)
    const body = (await missing.json()) as { issues: { path: string; message: string }[] }
    expect(body.issues).toEqual([
      { path: 'steps[0].variables.2', message: 'value for template variable {{2}} is required' },
    ])

    const ok = await patch({ is_active: true, steps: [step({ '1': 'Ann', '2': '#42' })] })
    expect(ok.status).toBe(200)
  })
})
