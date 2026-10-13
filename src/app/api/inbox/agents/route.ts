// GET /api/inbox/agents → { profiles: [{ id, user_id, full_name, avatar_url, account_role }] }
// (any member) — the assignee picker in the thread header.

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { listAccountProfiles } from '@/server/repos/profiles'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const rows = await asUser(ctx.userId, (db) => listAccountProfiles(db, ctx.accountId))
    const profiles = rows.map((p) => ({
      id: p.id,
      user_id: p.user_id,
      full_name: p.full_name,
      avatar_url: p.avatar_url,
      account_role: p.account_role,
    }))
    return NextResponse.json({ profiles })
  } catch (err) {
    return toErrorResponse(err)
  }
}
