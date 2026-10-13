// GET /api/dashboard/conversations-chart?days=7|30|90&tz=<IANA zone>
//   → { series: [{ day: 'YYYY-MM-DD', incoming, outgoing }] } (any member)

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { loadConversationsSeries, resolveTimeZone } from '@/server/repos/dashboard'

const t = getT('Api.common')

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const params = new URL(request.url).searchParams
    const days = Number(params.get('days') ?? 30)
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new HttpError(400, t('invalidRequestBody'))
    const series = await asUser(ctx.userId, async (db) =>
      loadConversationsSeries(db, ctx.accountId, await resolveTimeZone(db, params.get('tz')), days),
    )
    return NextResponse.json({ series })
  } catch (err) {
    return toErrorResponse(err)
  }
}
