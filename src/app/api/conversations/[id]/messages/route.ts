// GET /api/conversations/[id]/messages → { messages }   (any member)
//
// The whole thread, oldest first. A conversation outside the caller's
// account simply has no messages (same as the RLS-scoped read before).

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { isUuid } from '@/server/http'
import { listConversationMessages } from '@/server/repos/messages'

export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('viewer')
    const { id } = await params
    const messages = isUuid(id)
      ? await asUser(ctx.userId, (db) => listConversationMessages(db, ctx.accountId, id))
      : []
    return NextResponse.json({ messages })
  } catch (err) {
    return toErrorResponse(err)
  }
}
