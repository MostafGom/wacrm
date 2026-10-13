// /api/contacts
//   GET    ?page=0&pageSize=25&search=…&tag=<id>&tag=<id>
//          → { contacts: (Contact & { tag_ids })[], total }   (any member)
//   POST   { name?, phone, email?, company? } → { contact }  (agent+)
//          409 { code: 'duplicate_phone', existing } when the number exists
//   DELETE { ids: string[] } → { deleted }                    (agent+)

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { getT } from '@/lib/i18n/translate'
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils'
import { asUser } from '@/server/db'
import { isUuid, optionalString, readJsonBody, uuidArray } from '@/server/http'
import { deleteContacts, insertContact, listContactsPage, tagIdsForContacts } from '@/server/repos/contacts'

const t = getT('Api.contacts')

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const url = new URL(request.url)
    const page = Math.max(0, Number(url.searchParams.get('page') ?? 0) || 0)
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? 25) || 25))
    const search = url.searchParams.get('search') ?? undefined
    const tagIds = url.searchParams.getAll('tag').filter(isUuid)

    const result = await asUser(ctx.userId, async (db) => {
      const { contacts, total } = await listContactsPage(db, ctx.accountId, {
        offset: page * pageSize,
        limit: pageSize,
        search,
        tagIds,
      })
      const tagMap = await tagIdsForContacts(
        db,
        contacts.map((c) => c.id as string),
      )
      return {
        contacts: contacts.map((c) => ({ ...c, tag_ids: tagMap[c.id as string] ?? [] })),
        total,
      }
    })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const body = await readJsonBody(request)
    const phone = parseInternationalPhone(typeof body.phone === 'string' ? body.phone : '')
    if (!phone || typeof body.phone !== 'string') throw new HttpError(400, t('phoneInvalid'))

    const outcome = await asUser(ctx.userId, async (db) => {
      const contact = await insertContact(db, {
        account_id: ctx.accountId,
        user_id: ctx.userId,
        phone: (body.phone as string).trim(),
        name: optionalString(body.name, 200) ?? null,
        email: optionalString(body.email, 320) ?? null,
        company: optionalString(body.company, 200) ?? null,
      })
      if (contact) return { contact }
      // The per-account unique phone index (migration 022) held it.
      return { existing: await findExistingContact(db, ctx.accountId, phone) }
    })

    if ('contact' in outcome) return NextResponse.json({ contact: outcome.contact }, { status: 201 })
    return NextResponse.json(
      { error: t('duplicatePhone'), code: 'duplicate_phone', existing: outcome.existing ?? null },
      { status: 409 },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const body = await readJsonBody(request)
    const ids = uuidArray(body.ids, 500)
    const deleted = await asUser(ctx.userId, (db) => deleteContacts(db, ctx.accountId, ids))
    return NextResponse.json({ deleted })
  } catch (err) {
    return toErrorResponse(err)
  }
}
