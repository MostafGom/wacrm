// GET /api/notifications/unread-count — badge count for the sidebar.

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { countUnreadNotifications } from '@/server/repos/notifications'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const count = await asUser(ctx.userId, (db) => countUnreadNotifications(db, ctx.userId))
    return NextResponse.json({ count })
  } catch (err) {
    return toErrorResponse(err)
  }
}
