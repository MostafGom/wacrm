// GET /api/conversations → { conversations }   (any member)
//
// Every conversation of the caller's account with its contact and the
// contact's tags (flattened onto contact.tags), most recent activity
// first. The inbox filters / searches this list client-side.

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { normalizeConversations } from '@/lib/inbox/conversations'
import { asUser } from '@/server/db'
import { listConversationsWithContact } from '@/server/repos/conversations'
import type { Conversation } from '@/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const rows = await asUser(ctx.userId, (db) => listConversationsWithContact(db, ctx.accountId))
    return NextResponse.json({
      conversations: normalizeConversations(rows as unknown as Conversation[]),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
