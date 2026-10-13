// GET /api/conversations/unread → { counts: [{ id, unread_count }] }   (any member)
//
// Seed for the sidebar's "unread conversations" dot (useTotalUnread);
// realtime conversation events keep it live afterwards.

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { listUnreadCounts } from '@/server/repos/conversations'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const counts = await asUser(ctx.userId, (db) => listUnreadCounts(db, ctx.accountId))
    return NextResponse.json({ counts })
  } catch (err) {
    return toErrorResponse(err)
  }
}
