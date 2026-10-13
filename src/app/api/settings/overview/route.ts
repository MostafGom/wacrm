// GET /api/settings/overview — cheap counts for the Settings landing
// tiles (any member):
//   { templates, templates_pending, tags, custom_fields, whatsapp_configured }

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { getSettingsOverviewCounts } from '@/server/repos/settings-overview'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const counts = await asUser(ctx.userId, (db) => getSettingsOverviewCounts(db, ctx.accountId, ctx.userId))
    return NextResponse.json(counts)
  } catch (err) {
    return toErrorResponse(err)
  }
}
