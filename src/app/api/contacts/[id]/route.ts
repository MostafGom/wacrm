// /api/contacts/[id]
//   GET    → { contact, tag_ids, notes, custom_values, deals }  (any member)
//   PATCH  { name?, phone?, email?, company? } → { contact }    (agent+)
//          409 { code: 'duplicate_phone' } when the new number is taken
//   DELETE → { ok }                                             (agent+)

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils'
import { asUser } from '@/server/db'
import { isUniqueViolation } from '@/server/db/errors'
import { optionalString, readJsonBody } from '@/server/http'
import {
  deleteContacts,
  getContact,
  listCustomValues,
  listDealsForContact,
  listNotes,
  tagIdsForContacts,
  updateContact,
  type ContactFields,
} from '@/server/repos/contacts'

const t = getT('Api.contacts')
const tCommon = getT('Api.common')

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('viewer')
    const { id } = await params
    const result = await asUser(ctx.userId, async (db) => {
      const contact = await getContact(db, ctx.accountId, id)
      if (!contact) return null
      const [tagMap, notes, customValues, deals] = await Promise.all([
        tagIdsForContacts(db, [id]),
        listNotes(db, ctx.accountId, id),
        listCustomValues(db, id),
        listDealsForContact(db, ctx.accountId, id),
      ])
      return { contact, tag_ids: tagMap[id] ?? [], notes, custom_values: customValues, deals }
    })
    if (!result) throw new HttpError(404, tCommon('notFound'))
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    const body = await readJsonBody(request)

    const patch: ContactFields = {}
    const name = optionalString(body.name, 200)
    const email = optionalString(body.email, 320)
    const company = optionalString(body.company, 200)
    if (name !== undefined) patch.name = name
    if (email !== undefined) patch.email = email
    if (company !== undefined) patch.company = company

    const result = await asUser(ctx.userId, async (db) => {
      const current = await getContact(db, ctx.accountId, id)
      if (!current) throw new HttpError(404, tCommon('notFound'))
      if (typeof body.phone === 'string' && body.phone.trim() !== current.phone) {
        // A changed number must carry its country code (issue #586);
        // untouched webhook-created digits-only numbers stay editable.
        if (!parseInternationalPhone(body.phone)) throw new HttpError(400, t('phoneInvalid'))
        patch.phone = body.phone.trim()
      }
      return updateContact(db, ctx.accountId, id, patch)
    })
    return NextResponse.json({ contact: result })
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json({ error: t('duplicatePhone'), code: 'duplicate_phone' }, { status: 409 })
    }
    return toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    const deleted = await asUser(ctx.userId, (db) => deleteContacts(db, ctx.accountId, [id]))
    if (!deleted) throw new HttpError(404, tCommon('notFound'))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
