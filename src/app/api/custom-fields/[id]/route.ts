// PATCH  /api/custom-fields/[id] { field_name } — rename (admin+).
// DELETE /api/custom-fields/[id] — delete with its values (admin+).

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody, requiredString } from '@/server/http'
import { deleteCustomField, renameCustomField } from '@/server/repos/custom-fields'

const t = getT('Api.common')

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const body = await readJsonBody(request)
    const fieldName = requiredString(body.field_name, undefined, 100)
    const field = await asUser(ctx.userId, (db) => renameCustomField(db, ctx.accountId, id, fieldName))
    if (!field) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ field })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const deleted = await asUser(ctx.userId, (db) => deleteCustomField(db, ctx.accountId, id))
    if (!deleted) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
