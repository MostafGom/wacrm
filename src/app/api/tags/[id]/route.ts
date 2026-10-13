// DELETE /api/tags/[id] — delete a tag (admin+). Its contact_tags rows
// cascade.

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { deleteTag } from '@/server/repos/tags'

const t = getT('Api.common')

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const deleted = await asUser(ctx.userId, (db) => deleteTag(db, ctx.accountId, id))
    if (!deleted) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
