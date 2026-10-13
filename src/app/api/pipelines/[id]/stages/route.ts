// /api/pipelines/[id]/stages
//   GET  → { stages } by position (any member)
//   POST { name, color, position } → 201 { stage } (admin+)
//   PUT  { stages: [{ id, name, color, position }] } → { stages } (admin+)
//        Writes every stage in ONE upsert (the settings dialog's save:
//        renames, colours and the new order together).

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody } from '@/server/http'
import { insertStage, listStages, upsertStages } from '@/server/repos/pipelines'

import { parseStage, parseStageUpserts } from '../../stage-input'

const t = getT('Api.common')

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('viewer')
    const { id } = await params
    const stages = await asUser(ctx.userId, (db) => listStages(db, ctx.accountId, id))
    return NextResponse.json({ stages })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const stageInput = parseStage(await readJsonBody(request))
    const stage = await asUser(ctx.userId, (db) => insertStage(db, ctx.accountId, id, stageInput))
    if (!stage) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ stage }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const body = await readJsonBody(request)
    const rows = parseStageUpserts(body.stages)
    const stages = await asUser(ctx.userId, (db) => upsertStages(db, ctx.accountId, id, rows))
    if (!stages) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ stages })
  } catch (err) {
    return toErrorResponse(err)
  }
}
