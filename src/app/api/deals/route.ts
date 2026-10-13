// GET  /api/deals?pipelineId=<uuid> → { deals } (any member)
//      Newest first, each with `contact` and `assignee` embedded.
// POST /api/deals { title, pipeline_id, stage_id, value?, currency?,
//      contact_id?, assigned_to?, notes?, expected_close_date? }
//      → 201 { deal } (agent+). New deals start `open`.

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { isUuid, readJsonBody } from '@/server/http'
import { dealRefsValid, insertDeal, listDeals } from '@/server/repos/deals'

import { parseDealFields } from './deal-input'

const t = getT('Api.common')

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const pipelineId = new URL(request.url).searchParams.get('pipelineId')
    if (!isUuid(pipelineId)) throw new HttpError(400, t('invalidRequestBody'))
    const deals = await asUser(ctx.userId, (db) => listDeals(db, ctx.accountId, pipelineId))
    return NextResponse.json({ deals })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const fields = parseDealFields(await readJsonBody(request))
    const { title, pipeline_id, stage_id } = fields
    if (!title || !pipeline_id || !stage_id) throw new HttpError(400, t('invalidRequestBody'))

    const deal = await asUser(ctx.userId, async (db) => {
      const ok = await dealRefsValid(db, ctx.accountId, {
        pipelineId: pipeline_id,
        stageId: stage_id,
        contactId: fields.contact_id,
        assignedTo: fields.assigned_to,
      })
      if (!ok) throw new HttpError(400, t('invalidRequestBody'))
      return insertDeal(db, {
        ...fields,
        title,
        pipeline_id,
        stage_id,
        status: 'open',
        account_id: ctx.accountId,
        user_id: ctx.userId,
      })
    })
    return NextResponse.json({ deal }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
