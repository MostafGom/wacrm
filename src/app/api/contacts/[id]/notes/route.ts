// POST /api/contacts/[id]/notes { note_text } → { note }  (agent+)

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody, requiredString } from '@/server/http'
import { getContact, insertNote } from '@/server/repos/contacts'

const t = getT('Api.contacts')
const tCommon = getT('Api.common')

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    const body = await readJsonBody(request)
    const noteText = requiredString(body.note_text, t('contentRequired'), 10_000)
    const note = await asUser(ctx.userId, async (db) => {
      if (!(await getContact(db, ctx.accountId, id))) throw new HttpError(404, tCommon('notFound'))
      return insertNote(db, { account_id: ctx.accountId, user_id: ctx.userId, contact_id: id, note_text: noteText })
    })
    return NextResponse.json({ note }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
