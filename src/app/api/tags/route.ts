// GET  /api/tags — the account's tags (any member).
// POST /api/tags { name, color } — create a tag (admin+, like the RLS policy).

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { optionalString, readJsonBody, requiredString } from '@/server/http'
import { createTag, listTags } from '@/server/repos/tags'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const tags = await asUser(ctx.userId, (db) => listTags(db, ctx.accountId))
    return NextResponse.json({ tags })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = await readJsonBody(request)
    const name = requiredString(body.name, undefined, 100)
    const color = optionalString(body.color, 32) ?? '#3b82f6'
    const tag = await asUser(ctx.userId, (db) =>
      createTag(db, { account_id: ctx.accountId, user_id: ctx.userId, name, color }),
    )
    return NextResponse.json({ tag }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
