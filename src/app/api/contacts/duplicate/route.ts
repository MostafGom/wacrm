// GET /api/contacts/duplicate?phone=… → { existing: Contact | null, exact }
// Powers the contact form's on-blur "this number already exists" notice
// with the same fuzzy match the webhook and imports use (issue #212).

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { findExistingContact, isExactMatch } from '@/lib/contacts/dedupe'
import { asUser } from '@/server/db'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const phone = (new URL(request.url).searchParams.get('phone') ?? '').trim().slice(0, 64)
    if (!phone) return NextResponse.json({ existing: null, exact: false })
    const existing = await asUser(ctx.userId, (db) => findExistingContact(db, ctx.accountId, phone))
    return NextResponse.json({ existing, exact: existing ? isExactMatch(existing, phone) : false })
  } catch (err) {
    return toErrorResponse(err)
  }
}
