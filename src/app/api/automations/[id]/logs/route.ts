// GET /api/automations/[id]/logs — the automation plus its 100 most
// recent run logs (newest first), each with the contact it ran for.
// Any member may read (automation_logs_select has no role floor).

import { NextResponse } from 'next/server'
import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { getAutomation, listAutomationLogs } from '@/server/repos/automations'

const t = getT('Api')

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await requireRole('viewer')
    const result = await asUser(ctx.userId, async (db) => {
      const automation = await getAutomation(db, ctx.accountId, id)
      if (!automation) return null
      return { automation, logs: await listAutomationLogs(db, ctx.accountId, id, 100) }
    })
    if (!result) throw new HttpError(404, t('common.notFound'))
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
