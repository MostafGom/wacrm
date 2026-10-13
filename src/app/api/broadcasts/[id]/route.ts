// /api/broadcasts/[id]
//   GET    → { broadcast, recipients: (BroadcastRecipient & { contact })[] }   (any member)
//            recipients newest first; 404 when not in the account
//   PATCH  { status: 'sent' | 'failed' } → { ok: true }    (agent+)
//            The wizard's terminal status once its send loop finishes.
//            Counts stay owned by the recipient aggregate trigger.
//   DELETE → { ok: true }                                   (agent+)
//            Recipients cascade on broadcasts.id (migration 001).

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { isUuid, readJsonBody } from '@/server/http'
import {
  deleteBroadcast,
  getBroadcast,
  listRecipientsWithContact,
  setBroadcastStatus,
} from '@/server/repos/broadcasts'

const t = getT('Api.common')

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('viewer')
    const { id } = await params
    if (!isUuid(id)) throw new HttpError(404, t('notFound'))
    const result = await asUser(ctx.userId, async (db) => {
      const broadcast = await getBroadcast(db, ctx.accountId, id)
      if (!broadcast) return null
      return { broadcast, recipients: await listRecipientsWithContact(db, ctx.accountId, id) }
    })
    if (!result) throw new HttpError(404, t('notFound'))
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    if (!isUuid(id)) throw new HttpError(404, t('notFound'))
    const body = await readJsonBody(request)
    if (body.status !== 'sent' && body.status !== 'failed') {
      throw new HttpError(400, t('invalidRequestBody'))
    }
    const status = body.status
    const updated = await asUser(ctx.userId, (db) => setBroadcastStatus(db, ctx.accountId, id, status))
    if (!updated) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    if (!isUuid(id)) throw new HttpError(404, t('notFound'))
    await asUser(ctx.userId, (db) => deleteBroadcast(db, ctx.accountId, id))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
