// Route-level tests for /api/dashboard/*: any member may read, the
// viewer's time zone is resolved before aggregating, and query params
// are validated. The aggregates themselves are covered by
// src/server/repos/dashboard.int.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const caller = vi.hoisted(() => ({ userId: 'user-1' as string | null, accountId: 'acct-1', role: 'viewer' as string | null }))
vi.mock('@/lib/auth/server-session', async () => (await import('@/test/auth-mocks')).sessionModule(caller))
vi.mock('@/server/repos/profiles', async () => (await import('@/test/auth-mocks')).profilesModule(caller))
vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule())

const repo = vi.hoisted(() => ({
  resolveTimeZone: vi.fn(),
  loadMetrics: vi.fn(),
  loadConversationsSeries: vi.fn(),
  loadPipelineDonut: vi.fn(),
  loadResponseTime: vi.fn(),
  loadActivitySources: vi.fn(),
  buildActivityItems: vi.fn(),
}))
vi.mock('@/server/repos/dashboard', () => repo)

import { GET as metrics } from './metrics/route'
import { GET as chart } from './conversations-chart/route'
import { GET as pipeline } from './pipeline/route'
import { GET as responseTime } from './response-time/route'
import { GET as activity } from './activity/route'

const get = (path: string) => new Request(`http://localhost${path}`)

beforeEach(() => {
  caller.userId = 'user-1'
  caller.role = 'viewer'
  Object.values(repo).forEach((fn) => fn.mockReset())
  repo.resolveTimeZone.mockImplementation(async (_db: unknown, tz: string | null) => tz ?? 'UTC')
})

describe('/api/dashboard', () => {
  it('metrics: resolves the tz then aggregates for the caller account', async () => {
    repo.loadMetrics.mockResolvedValue({ openDealsValue: 1 })
    const res = await metrics(get('/api/dashboard/metrics?tz=Europe/Lisbon'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ metrics: { openDealsValue: 1 } })
    expect(repo.resolveTimeZone).toHaveBeenCalledWith({}, 'Europe/Lisbon')
    expect(repo.loadMetrics).toHaveBeenCalledWith({}, 'acct-1', 'Europe/Lisbon')
  })

  it('rejects signed-out callers', async () => {
    caller.userId = null
    expect((await metrics(get('/api/dashboard/metrics'))).status).toBe(401)
    expect(repo.loadMetrics).not.toHaveBeenCalled()
  })

  it('conversations chart: validates the range', async () => {
    repo.loadConversationsSeries.mockResolvedValue([])
    expect((await chart(get('/api/dashboard/conversations-chart?days=90&tz=UTC'))).status).toBe(200)
    expect(repo.loadConversationsSeries).toHaveBeenCalledWith({}, 'acct-1', 'UTC', 90)
    expect((await chart(get('/api/dashboard/conversations-chart?days=0'))).status).toBe(400)
    expect((await chart(get('/api/dashboard/conversations-chart?days=abc'))).status).toBe(400)
  })

  it('pipeline + response time', async () => {
    repo.loadPipelineDonut.mockResolvedValue({ stages: [], totalValue: 0 })
    expect(await (await pipeline()).json()).toEqual({ pipeline: { stages: [], totalValue: 0 } })
    repo.loadResponseTime.mockResolvedValue({ buckets: [], thisWeekAvg: null, lastWeekAvg: null })
    const res = await responseTime(get('/api/dashboard/response-time?tz=Asia/Seoul'))
    expect(await res.json()).toEqual({ responseTime: { buckets: [], thisWeekAvg: null, lastWeekAvg: null } })
    expect(repo.loadResponseTime).toHaveBeenCalledWith({}, 'acct-1', 'Asia/Seoul')
  })

  it('activity: passes the limit through and caps it at 50', async () => {
    repo.loadActivitySources.mockResolvedValue({})
    repo.buildActivityItems.mockReturnValue([])
    expect((await activity(get('/api/dashboard/activity?limit=50'))).status).toBe(200)
    expect(repo.buildActivityItems).toHaveBeenCalledWith({}, 50)
    expect((await activity(get('/api/dashboard/activity?limit=51'))).status).toBe(400)
  })
})
