// DELETE /api/pipelines/[id]/stages/[stageId] → { ok } (admin+)
//   409 { code: 'stage_has_deals' } while deals still sit in the stage
//   (the deals → stage FK would refuse the delete anyway).

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { countDealsInStage, deleteStage } from '@/server/repos/pipelines'

const t = getT('Api.common')
const tSettings = getT('Pipelines.settings')

type Params = { params: Promise<{ id: string; stageId: string }> }

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const { id, stageId } = await params
    const result = await asUser(ctx.userId, async (db) => {
      if ((await countDealsInStage(db, ctx.accountId, stageId)) > 0) return 'has_deals' as const
      return (await deleteStage(db, ctx.accountId, id, stageId)) ? ('deleted' as const) : ('missing' as const)
    })
    if (result === 'has_deals') {
      return NextResponse.json({ error: tSettings('toastMoveOrDeleteDeals'), code: 'stage_has_deals' }, { status: 409 })
    }
    if (result === 'missing') throw new HttpError(404, t('notFound'))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
