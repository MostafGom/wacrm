// GET  /api/presence — presence rows for the caller's account.
// POST /api/presence { status: 'online' | 'away' } — heartbeat.

import { NextResponse } from 'next/server'

import { getCurrentAccount, HttpError, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { listPresence, touchPresence } from '@/server/repos/presence'

const t = getT('Api.common')

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const presence = await asUser(ctx.userId, (db) => listPresence(db, ctx.accountId))
    return NextResponse.json({ presence })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => null)) as { status?: unknown } | null
    const status = body?.status ?? 'online'
    if (status !== 'online' && status !== 'away') throw new HttpError(400, t('invalidRequestBody'))
    await asUser(ctx.userId, (db) => touchPresence(db, status))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
