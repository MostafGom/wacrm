// PATCH /api/notifications/[id] — mark one notification read.

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { markNotificationRead } from '@/server/repos/notifications'

export async function PATCH(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getCurrentAccount()
    const { id } = await params
    const updated = await asUser(ctx.userId, (db) => markNotificationRead(db, ctx.userId, id))
    return NextResponse.json({ updated })
  } catch (err) {
    return toErrorResponse(err)
  }
}
