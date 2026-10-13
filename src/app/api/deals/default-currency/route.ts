// PATCH /api/deals/default-currency { currency: 'EUR' } → { ok } (admin+)
// The account-wide default deal currency (accounts.default_currency,
// issue #218). Admin-only like the accounts_update RLS policy; the
// DB CHECK wants a 3-letter uppercase code.

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody } from '@/server/http'
import { setAccountDefaultCurrency } from '@/server/repos/deals'

const t = getT('Api.common')

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = await readJsonBody(request)
    const currency = body.currency
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, t('invalidRequestBody'))
    const updated = await asUser(ctx.userId, (db) => setAccountDefaultCurrency(db, ctx.accountId, currency))
    if (!updated) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
