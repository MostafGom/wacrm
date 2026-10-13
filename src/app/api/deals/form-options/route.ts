// GET /api/deals/form-options[?contactId=<uuid>] (any member)
//   → { contacts: [{ id, name, phone }], profiles: [{ id, full_name, email }],
//       conversation: { id, status, last_message_at } | null }
// What the deal form's pickers need. With `contactId`, only the
// contact's most recent conversation is returned (pickers omitted) —
// the form re-asks whenever the selected contact changes.

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { isUuid } from '@/server/http'
import { latestConversationForContact, listAssigneeOptions, listContactOptions } from '@/server/repos/deals'

const t = getT('Api.common')

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const contactId = new URL(request.url).searchParams.get('contactId')
    if (contactId !== null) {
      if (!isUuid(contactId)) throw new HttpError(400, t('invalidRequestBody'))
      const conversation = await asUser(ctx.userId, (db) =>
        latestConversationForContact(db, ctx.accountId, contactId),
      )
      return NextResponse.json({ conversation: conversation ?? null })
    }
    const result = await asUser(ctx.userId, async (db) => ({
      contacts: await listContactOptions(db, ctx.accountId),
      profiles: await listAssigneeOptions(db, ctx.accountId),
    }))
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
