// GET /api/conversations/[id]/reactions → { reactions }   (any member)
//
// Current emoji reactions of every message in the conversation. Writes
// go through POST /api/whatsapp/react (which also tells Meta).

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { isUuid } from '@/server/http'
import { listConversationReactions } from '@/server/repos/reactions'

export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('viewer')
    const { id } = await params
    const reactions = isUuid(id)
      ? await asUser(ctx.userId, (db) => listConversationReactions(db, ctx.accountId, id))
      : []
    return NextResponse.json({ reactions })
  } catch (err) {
    return toErrorResponse(err)
  }
}
