// GET  /api/custom-fields — account custom contact field definitions.
// POST /api/custom-fields { field_name } — create one (admin+).

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { readJsonBody, requiredString } from '@/server/http'
import { createCustomField, listCustomFields } from '@/server/repos/custom-fields'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const fields = await asUser(ctx.userId, (db) => listCustomFields(db, ctx.accountId))
    return NextResponse.json({ fields })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = await readJsonBody(request)
    const fieldName = requiredString(body.field_name, undefined, 100)
    const field = await asUser(ctx.userId, (db) =>
      createCustomField(db, { account_id: ctx.accountId, user_id: ctx.userId, field_name: fieldName, field_type: 'text' }),
    )
    return NextResponse.json({ field }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
