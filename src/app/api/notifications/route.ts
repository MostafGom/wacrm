// GET /api/notifications — the caller's latest notifications (newest first).

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { listNotifications } from '@/server/repos/notifications'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const notifications = await asUser(ctx.userId, (db) => listNotifications(db, ctx.accountId, ctx.userId))
    return NextResponse.json({ notifications })
  } catch (err) {
    return toErrorResponse(err)
  }
}
