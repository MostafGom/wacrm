// GET /api/whatsapp/templates?status=APPROVED&mine=1
//   → { templates: MessageTemplate[] }   newest first (any member)
//
// `status` narrows to one Meta status (the broadcast wizard only offers
// APPROVED templates — anything else would 400 at send time). `mine=1`
// narrows to templates the caller authored (Settings → Templates).

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { listTemplates } from '@/server/repos/templates'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const url = new URL(request.url)
    const status = url.searchParams.get('status')?.trim().slice(0, 40) || undefined
    const mine = url.searchParams.get('mine') === '1'
    const templates = await asUser(ctx.userId, (db) =>
      listTemplates(db, ctx.accountId, { status, userId: mine ? ctx.userId : undefined }),
    )
    return NextResponse.json({ templates })
  } catch (err) {
    return toErrorResponse(err)
  }
}
