// GET /api/dashboard/metrics?tz=<IANA zone> → { metrics } (any member)
// Metric cards; "today" / "yesterday" are local days in `tz`.

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { loadMetrics, resolveTimeZone } from '@/server/repos/dashboard'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const tzParam = new URL(request.url).searchParams.get('tz')
    const metrics = await asUser(ctx.userId, async (db) =>
      loadMetrics(db, ctx.accountId, await resolveTimeZone(db, tzParam)),
    )
    return NextResponse.json({ metrics })
  } catch (err) {
    return toErrorResponse(err)
  }
}
