// GET  /api/pipelines → { pipelines } (any member), oldest first.
// POST /api/pipelines { name, stages: [{ name, color, position }] }
//      → 201 { pipeline } (admin+, like the pipelines RLS). The pipeline
//      and its initial stages are written in one transaction; the
//      client supplies the (translated) default stage names.

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { readJsonBody, requiredString } from '@/server/http'
import { createPipelineWithStages, listPipelines } from '@/server/repos/pipelines'

import { parseStageList } from './stage-input'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const pipelines = await asUser(ctx.userId, (db) => listPipelines(db, ctx.accountId))
    return NextResponse.json({ pipelines })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = await readJsonBody(request)
    const name = requiredString(body.name, undefined, 200)
    const stages = body.stages === undefined ? [] : parseStageList(body.stages)
    const pipeline = await asUser(ctx.userId, (db) =>
      createPipelineWithStages(db, { account_id: ctx.accountId, user_id: ctx.userId, name }, stages),
    )
    return NextResponse.json({ pipeline }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
