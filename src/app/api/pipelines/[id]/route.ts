// PATCH  /api/pipelines/[id] { name } → { pipeline } (admin+)
// DELETE /api/pipelines/[id] → { ok } (admin+). Stages and deals cascade.

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody, requiredString } from '@/server/http'
import { deletePipeline, renamePipeline } from '@/server/repos/pipelines'

const t = getT('Api.common')

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const body = await readJsonBody(request)
    const name = requiredString(body.name, undefined, 200)
    const pipeline = await asUser(ctx.userId, (db) => renamePipeline(db, ctx.accountId, id, name))
    if (!pipeline) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ pipeline })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const deleted = await asUser(ctx.userId, (db) => deletePipeline(db, ctx.accountId, id))
    if (!deleted) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
