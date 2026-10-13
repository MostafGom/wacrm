// Route-level tests for /api/pipelines/**: role gates (members read,
// admins write — the pipelines / pipeline_stages RLS), body validation
// and the 409 on deleting a stage that still holds deals. The repo is
// mocked; SQL behaviour lives in src/server/repos/pipelines.int.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const caller = vi.hoisted(() => ({ userId: 'user-1' as string | null, accountId: 'acct-1', role: 'admin' as string | null }))
vi.mock('@/lib/auth/server-session', async () => (await import('@/test/auth-mocks')).sessionModule(caller))
vi.mock('@/server/repos/profiles', async () => (await import('@/test/auth-mocks')).profilesModule(caller))
vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule())
// requireRole still builds the transitional request-scoped client, which reads cookies.
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() }))

const repo = vi.hoisted(() => ({
  listPipelines: vi.fn(),
  createPipelineWithStages: vi.fn(),
  renamePipeline: vi.fn(),
  deletePipeline: vi.fn(),
  listStages: vi.fn(),
  insertStage: vi.fn(),
  upsertStages: vi.fn(),
  countDealsInStage: vi.fn(),
  deleteStage: vi.fn(),
}))
vi.mock('@/server/repos/pipelines', () => repo)

import { GET as listRoute, POST as createRoute } from './route'
import { DELETE as deletePipelineRoute, PATCH as renameRoute } from './[id]/route'
import { GET as stagesGet, POST as stagesPost, PUT as stagesPut } from './[id]/stages/route'
import { DELETE as stageDelete } from './[id]/stages/[stageId]/route'

const PID = '11111111-1111-4111-8111-111111111111'
const SID = '22222222-2222-4222-8222-222222222222'
const SID2 = '33333333-3333-4333-8333-333333333333'

function req(method: string, body?: unknown) {
  return new Request('http://localhost/api/pipelines', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
const idParams = { params: Promise.resolve({ id: PID }) }
const stageParams = { params: Promise.resolve({ id: PID, stageId: SID }) }

beforeEach(() => {
  caller.userId = 'user-1'
  caller.role = 'admin'
  Object.values(repo).forEach((fn) => fn.mockReset())
})

describe('/api/pipelines', () => {
  it('lists for any member, scoped to the caller account', async () => {
    caller.role = 'viewer'
    repo.listPipelines.mockResolvedValue([{ id: PID, name: 'Sales' }])
    const res = await listRoute()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pipelines: [{ id: PID, name: 'Sales' }] })
    expect(repo.listPipelines).toHaveBeenCalledWith({}, 'acct-1')
  })

  it('rejects signed-out callers', async () => {
    caller.userId = null
    expect((await listRoute()).status).toBe(401)
  })

  it('creates a pipeline with its stages (admin)', async () => {
    repo.createPipelineWithStages.mockResolvedValue({ id: PID, name: 'New' })
    const stages = [{ name: 'Lead', color: '#3b82f6', position: 0 }]
    const res = await createRoute(req('POST', { name: '  New ', stages }))
    expect(res.status).toBe(201)
    expect(repo.createPipelineWithStages).toHaveBeenCalledWith(
      {},
      { account_id: 'acct-1', user_id: 'user-1', name: 'New' },
      stages,
    )
  })

  it('forbids pipeline creation for agents and validates the body', async () => {
    caller.role = 'agent'
    expect((await createRoute(req('POST', { name: 'X' }))).status).toBe(403)
    caller.role = 'admin'
    expect((await createRoute(req('POST', { name: '' }))).status).toBe(400)
    expect((await createRoute(req('POST', { name: 'X', stages: [{ name: 'A', position: -1 }] }))).status).toBe(400)
    expect(repo.createPipelineWithStages).not.toHaveBeenCalled()
  })

  it('renames and deletes (admin), 404 when not in the account', async () => {
    repo.renamePipeline.mockResolvedValue(undefined)
    expect((await renameRoute(req('PATCH', { name: 'R' }), idParams)).status).toBe(404)
    repo.deletePipeline.mockResolvedValue(true)
    expect((await deletePipelineRoute(req('DELETE'), idParams)).status).toBe(200)
    caller.role = 'agent'
    expect((await deletePipelineRoute(req('DELETE'), idParams)).status).toBe(403)
  })
})

describe('/api/pipelines/[id]/stages', () => {
  it('lists stages for viewers', async () => {
    caller.role = 'viewer'
    repo.listStages.mockResolvedValue([])
    expect((await stagesGet(req('GET'), idParams)).status).toBe(200)
    expect(repo.listStages).toHaveBeenCalledWith({}, 'acct-1', PID)
  })

  it('adds a stage (admin only)', async () => {
    repo.insertStage.mockResolvedValue({ id: SID })
    const res = await stagesPost(req('POST', { name: 'Won', color: '#22c55e', position: 3 }), idParams)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ stage: { id: SID } })
    caller.role = 'agent'
    expect((await stagesPost(req('POST', { name: 'W', position: 0 }), idParams)).status).toBe(403)
  })

  it('saves every stage in one upsert call', async () => {
    repo.upsertStages.mockResolvedValue([])
    const stages = [
      { id: SID2, name: 'B', color: '#000', position: 0 },
      { id: SID, name: 'A', color: '#fff', position: 1 },
    ]
    expect((await stagesPut(req('PUT', { stages }), idParams)).status).toBe(200)
    expect(repo.upsertStages).toHaveBeenCalledTimes(1)
    expect(repo.upsertStages).toHaveBeenCalledWith({}, 'acct-1', PID, stages)
  })

  it('rejects malformed or duplicate stage ids', async () => {
    const bad = [{ id: 'nope', name: 'A', color: '#000', position: 0 }]
    expect((await stagesPut(req('PUT', { stages: bad }), idParams)).status).toBe(400)
    const dup = [
      { id: SID, name: 'A', color: '#000', position: 0 },
      { id: SID, name: 'B', color: '#000', position: 1 },
    ]
    expect((await stagesPut(req('PUT', { stages: dup }), idParams)).status).toBe(400)
    expect(repo.upsertStages).not.toHaveBeenCalled()
  })

  it('refuses to delete a stage that still has deals (409 stage_has_deals)', async () => {
    repo.countDealsInStage.mockResolvedValue(2)
    const res = await stageDelete(req('DELETE'), stageParams)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('stage_has_deals')
    expect(repo.deleteStage).not.toHaveBeenCalled()
  })

  it('deletes an empty stage', async () => {
    repo.countDealsInStage.mockResolvedValue(0)
    repo.deleteStage.mockResolvedValue(true)
    expect((await stageDelete(req('DELETE'), stageParams)).status).toBe(200)
    expect(repo.deleteStage).toHaveBeenCalledWith({}, 'acct-1', PID, SID)
  })
})
