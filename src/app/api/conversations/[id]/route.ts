// /api/conversations/[id]
//   GET   → { conversation }  (any member) — with contact + contact.tags
//   PATCH { status?: 'open'|'pending'|'closed', assigned_agent_id?: uuid|null }
//         → { conversation }  (agent+, matching conversations_update RLS)

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { normalizeConversation } from '@/lib/inbox/conversations'
import { asUser } from '@/server/db'
import { isUuid, readJsonBody } from '@/server/http'
import {
  getConversationWithContact,
  updateConversation,
  type ConversationPatch,
} from '@/server/repos/conversations'
import type { Conversation } from '@/types'

const tCommon = getT('Api.common')

const STATUSES = ['open', 'pending', 'closed']

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('viewer')
    const { id } = await params
    const row = isUuid(id)
      ? await asUser(ctx.userId, (db) => getConversationWithContact(db, ctx.accountId, id))
      : undefined
    if (!row) throw new HttpError(404, tCommon('conversationNotFound'))
    return NextResponse.json({ conversation: normalizeConversation(row as unknown as Conversation) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    const body = await readJsonBody(request)

    const patch: ConversationPatch = {}
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !STATUSES.includes(body.status)) {
        throw new HttpError(400, tCommon('invalidRequestBody'))
      }
      patch.status = body.status
    }
    if (body.assigned_agent_id !== undefined) {
      if (body.assigned_agent_id !== null && !isUuid(body.assigned_agent_id)) {
        throw new HttpError(400, tCommon('invalidRequestBody'))
      }
      patch.assigned_agent_id = body.assigned_agent_id
    }
    if (Object.keys(patch).length === 0) throw new HttpError(400, tCommon('invalidRequestBody'))

    const row = isUuid(id)
      ? await asUser(ctx.userId, (db) => updateConversation(db, ctx.accountId, id, patch))
      : undefined
    if (!row) throw new HttpError(404, tCommon('conversationNotFound'))
    return NextResponse.json({ conversation: row })
  } catch (err) {
    return toErrorResponse(err)
  }
}
