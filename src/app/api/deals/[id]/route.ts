// PATCH  /api/deals/[id] { any writable deal field } → { deal } (agent+)
//        Used by the deal form (full edit, won/lost/reopen) and by the
//        board's drag-and-drop (`{ stage_id }` only).
// DELETE /api/deals/[id] → { ok } (agent+)

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody } from '@/server/http'
import { dealRefsValid, deleteDeal, getDeal, updateDeal } from '@/server/repos/deals'

import { parseDealFields } from '../deal-input'

const t = getT('Api.common')

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    const patch = parseDealFields(await readJsonBody(request))
    if (Object.keys(patch).length === 0) throw new HttpError(400, t('invalidRequestBody'))

    const deal = await asUser(ctx.userId, async (db) => {
      const touchesRefs =
        patch.pipeline_id !== undefined ||
        patch.stage_id !== undefined ||
        patch.contact_id !== undefined ||
        patch.assigned_to !== undefined
      if (touchesRefs) {
        const current = await getDeal(db, ctx.accountId, id)
        if (!current) throw new HttpError(404, t('notFound'))
        const ok = await dealRefsValid(db, ctx.accountId, {
          pipelineId: patch.pipeline_id ?? current.pipeline_id,
          stageId: patch.stage_id ?? current.stage_id,
          contactId: patch.contact_id,
          assignedTo: patch.assigned_to,
        })
        if (!ok) throw new HttpError(400, t('invalidRequestBody'))
      }
      return updateDeal(db, ctx.accountId, id, patch)
    })
    if (!deal) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ deal })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    const deleted = await asUser(ctx.userId, (db) => deleteDeal(db, ctx.accountId, id))
    if (!deleted) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
