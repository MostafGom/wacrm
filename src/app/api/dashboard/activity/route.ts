// GET /api/dashboard/activity?limit=1..50 → { items: ActivityItem[] } (any member)
// Recent messages, contacts, deals, broadcasts and automation runs,
// merged newest first with pre-formatted text.

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { buildActivityItems, loadActivitySources } from '@/server/repos/dashboard'

const t = getT('Api.common')

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, t('invalidRequestBody'))
    const sources = await asUser(ctx.userId, (db) => loadActivitySources(db, ctx.accountId))
    return NextResponse.json({ items: buildActivityItems(sources, limit) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
