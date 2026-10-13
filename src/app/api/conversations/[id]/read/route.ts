// POST /api/conversations/[id]/read → { ok }   (any member)
//
// Reset the conversation's unread badge. Runs under the caller's RLS:
// conversations_update needs 'agent', so for a viewer this matches no
// row and is a silent no-op — exactly what the inbox's direct update
// always did for viewers.

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { isUuid } from '@/server/http'
import { markConversationRead } from '@/server/repos/conversations'

const tCommon = getT('Api.common')

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('viewer')
    const { id } = await params
    if (!isUuid(id)) throw new HttpError(404, tCommon('conversationNotFound'))
    await asUser(ctx.userId, (db) => markConversationRead(db, ctx.accountId, id))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
