// Browser loaders for the dashboard widgets. The aggregation runs
// server-side (src/server/repos/dashboard.ts, behind /api/dashboard/*);
// these just fetch and unwrap. Each rejects on failure so the page's
// per-widget .catch() keeps working.
//
// Day boundaries are LOCAL to the viewer, as before: the browser's
// IANA time zone travels with every time-windowed request.

import { apiRequest, type ApiResult } from '@/lib/http/client'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  ResponseTimeSummary,
} from './types'

/** The browser's IANA zone (e.g. `Europe/Lisbon`); UTC if unavailable. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function unwrap<T>(res: ApiResult<T>): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

// --- 1. Metric cards ---------------------------------------------------

export async function loadMetrics(): Promise<MetricsBundle> {
  const res = await apiRequest<{ metrics: MetricsBundle }>('/api/dashboard/metrics', {
    query: { tz: browserTimeZone() },
  })
  return unwrap(res).metrics
}

// --- 2. Conversations over time ---------------------------------------

export async function loadConversationsSeries(rangeDays: number): Promise<ConversationsSeriesPoint[]> {
  const res = await apiRequest<{ series: ConversationsSeriesPoint[] }>('/api/dashboard/conversations-chart', {
    query: { days: rangeDays, tz: browserTimeZone() },
  })
  return unwrap(res).series
}

// --- 3. Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(): Promise<PipelineDonutData> {
  const res = await apiRequest<{ pipeline: PipelineDonutData }>('/api/dashboard/pipeline')
  return unwrap(res).pipeline
}

// --- 4. Response time by day of week ----------------------------------

export async function loadResponseTime(): Promise<ResponseTimeSummary> {
  const res = await apiRequest<{ responseTime: ResponseTimeSummary }>('/api/dashboard/response-time', {
    query: { tz: browserTimeZone() },
  })
  return unwrap(res).responseTime
}

// --- 5. Activity feed --------------------------------------------------

export async function loadActivity(limit = 20): Promise<ActivityItem[]> {
  const res = await apiRequest<{ items: ActivityItem[] }>('/api/dashboard/activity', { query: { limit } })
  return unwrap(res).items
}
