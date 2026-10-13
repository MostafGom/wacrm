// GET /api/dashboard/pipeline → { pipeline: { stages, totalValue } } (any member)
// Open deal count + value per stage for the donut.

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { loadPipelineDonut } from '@/server/repos/dashboard'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const pipeline = await asUser(ctx.userId, (db) => loadPipelineDonut(db, ctx.accountId))
    return NextResponse.json({ pipeline })
  } catch (err) {
    return toErrorResponse(err)
  }
}
