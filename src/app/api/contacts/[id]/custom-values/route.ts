// PUT /api/contacts/[id]/custom-values { values: [{ custom_field_id, value }] }
// Replaces the contact's custom field values (agent+). Blank values are dropped.

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { isUuid, readJsonBody } from '@/server/http'
import { getContact, listCustomValues, replaceCustomValues } from '@/server/repos/contacts'

const t = getT('Api.common')

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    const body = await readJsonBody(request)
    if (!Array.isArray(body.values) || body.values.length > 500) throw new HttpError(400, t('invalidRequestBody'))
    const values: { custom_field_id: string; value: string }[] = []
    for (const v of body.values as Array<Record<string, unknown>>) {
      if (!v || !isUuid(v.custom_field_id) || typeof v.value !== 'string') {
        throw new HttpError(400, t('invalidRequestBody'))
      }
      const value = v.value.trim()
      if (value) values.push({ custom_field_id: v.custom_field_id, value: value.slice(0, 5000) })
    }
    const saved = await asUser(ctx.userId, async (db) => {
      if (!(await getContact(db, ctx.accountId, id))) throw new HttpError(404, t('notFound'))
      // Field definitions must be this account's own.
      const fieldIds = [...new Set(values.map((v) => v.custom_field_id))]
      if (fieldIds.length > 0) {
        const owned = await db
          .selectFrom('custom_fields')
          .select('id')
          .where('account_id', '=', ctx.accountId)
          .where('id', 'in', fieldIds)
          .execute()
        if (owned.length !== fieldIds.length) throw new HttpError(400, t('invalidRequestBody'))
      }
      await replaceCustomValues(db, id, values)
      return listCustomValues(db, id)
    })
    return NextResponse.json({ custom_values: saved })
  } catch (err) {
    return toErrorResponse(err)
  }
}
