// GET /api/dashboard/response-time?tz=<IANA zone>
//   → { responseTime: { buckets, thisWeekAvg, lastWeekAvg } } (any member)

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { loadResponseTime, resolveTimeZone } from '@/server/repos/dashboard'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const tzParam = new URL(request.url).searchParams.get('tz')
    const responseTime = await asUser(ctx.userId, async (db) =>
      loadResponseTime(db, ctx.accountId, await resolveTimeZone(db, tzParam)),
    )
    return NextResponse.json({ responseTime })
  } catch (err) {
    return toErrorResponse(err)
  }
}
