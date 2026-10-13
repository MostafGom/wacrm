// POST /api/notifications/read-all — mark every unread notification read.

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { markAllNotificationsRead } from '@/server/repos/notifications'

export async function POST() {
  try {
    const ctx = await getCurrentAccount()
    const updated = await asUser(ctx.userId, (db) => markAllNotificationsRead(db, ctx.userId))
    return NextResponse.json({ updated })
  } catch (err) {
    return toErrorResponse(err)
  }
}
