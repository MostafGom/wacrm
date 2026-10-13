// DELETE /api/contacts/[id]/notes/[noteId]  (agent+)

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { deleteNote } from '@/server/repos/contacts'

const t = getT('Api.common')

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; noteId: string }> }) {
  try {
    const ctx = await requireRole('agent')
    const { id, noteId } = await params
    const deleted = await asUser(ctx.userId, (db) => deleteNote(db, ctx.accountId, id, noteId))
    if (!deleted) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
