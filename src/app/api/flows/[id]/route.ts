import { NextResponse } from 'next/server'
import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody } from '@/server/http'
import {
  deleteFlow,
  getFlow,
  listFlowNodes,
  replaceFlowNodes,
  updateFlow,
  type FlowPatch,
} from '@/server/repos/flows'

const t = getT('Api')

/**
 * GET   /api/flows/[id]  — fetch one flow with its nodes (any member).
 * PUT   /api/flows/[id]  — replace name/trigger/entry/fallback + the
 *                          full node graph (delete-then-insert, in one
 *                          transaction with the flow update). agent+.
 * DELETE /api/flows/[id] — hard delete (CASCADE cleans up nodes, runs,
 *                          events). agent+.
 *
 * Every lookup is scoped to the caller's account; a flow in another
 * account is a 404. Flows is in soft-GA — the beta gate that previously
 * 404'd non-beta accounts is gone; the "Beta" label in the UI is the
 * only remaining signal.
 */

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const ctx = await requireRole('viewer')
    const result = await asUser(ctx.userId, async (db) => {
      const flow = await getFlow(db, ctx.accountId, id)
      if (!flow) return null
      return { flow, nodes: await listFlowNodes(db, ctx.accountId, id) }
    })
    if (!result) throw new HttpError(404, t('common.notFound'))
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface PutBody {
  name?: string
  description?: string | null
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
  trigger_config?: Record<string, unknown>
  entry_node_id?: string | null
  fallback_policy?: Record<string, unknown>
  nodes?: Array<{
    node_key: string
    node_type: string
    config: Record<string, unknown>
    position_x?: number
    position_y?: number
  }>
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    // Writes require at least `agent` — the RLS flows_update policy.
    const ctx = await requireRole('agent')

    const body = (await readJsonBody(request)) as PutBody
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
      throw new HttpError(400, t('flows.nameEmpty'))
    }
    if (body.nodes !== undefined && !Array.isArray(body.nodes)) {
      throw new HttpError(400, t('common.invalidRequestBody'))
    }

    // The body may not include `nodes` (a header-only save for editing
    // the trigger config without touching the graph). Skip node
    // replacement in that case.
    const patch: FlowPatch = {}
    if (body.name !== undefined) patch.name = body.name.trim()
    if (body.description !== undefined) patch.description = body.description
    if (body.trigger_type !== undefined) patch.trigger_type = body.trigger_type
    if (body.trigger_config !== undefined) patch.trigger_config = body.trigger_config
    if (body.entry_node_id !== undefined) patch.entry_node_id = body.entry_node_id
    if (body.fallback_policy !== undefined) patch.fallback_policy = body.fallback_policy

    const result = await asUser(ctx.userId, async (db) => {
      const flow = await updateFlow(db, ctx.accountId, id, patch)
      if (!flow) return null
      if (body.nodes !== undefined) {
        await replaceFlowNodes(db, ctx.accountId, id, body.nodes)
      }
      // Return the new state — the editor uses the response to
      // reconcile its local form state.
      return { flow, nodes: await listFlowNodes(db, ctx.accountId, id) }
    })
    if (!result) throw new HttpError(404, t('common.notFound'))
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    // Writes require at least `agent` — the RLS flows_delete policy.
    const ctx = await requireRole('agent')

    // CASCADE on flow_nodes / flow_runs / flow_run_events handles the
    // children. Active runs end abruptly — there's no graceful "drain"
    // mechanism in v1, but that's intentional: deleting a flow is a
    // deliberate destructive action and the partial unique index will
    // free up the contact for new triggers immediately.
    const deleted = await asUser(ctx.userId, (db) => deleteFlow(db, ctx.accountId, id))
    if (!deleted) throw new HttpError(404, t('common.notFound'))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
