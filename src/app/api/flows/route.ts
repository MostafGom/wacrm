import { NextResponse } from 'next/server'
import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getFlowTemplate } from '@/lib/flows/templates'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody } from '@/server/http'
import { insertFlow, insertFlowNodes, listFlows } from '@/server/repos/flows'

const t = getT('Api')

/**
 * GET /api/flows — list the account's flows (any member).
 * POST /api/flows — create a new (draft) flow (agent+).
 *
 * The previous per-account beta gate was removed when Flows went to
 * soft-GA; the UI still shows a "Beta" label so users know the surface
 * is young, but the routes themselves are open.
 */

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const flows = await asUser(ctx.userId, (db) => listFlows(db, ctx.accountId))
    return NextResponse.json({ flows })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    // Creating a flow is a write — the RLS flows_insert policy requires
    // `agent`.
    const ctx = await requireRole('agent')

    const body = (await readJsonBody(request)) as {
      name?: string
      description?: string | null
      trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
      trigger_config?: Record<string, unknown>
      /**
       * If set, clone the matching template's name + trigger +
       * entry_node_id + nodes[] into a fresh draft for this user.
       * `name` from the body overrides the template default if
       * provided.
       */
      template_slug?: string
    }
    if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') {
      throw new HttpError(400, t('common.invalidRequestBody'))
    }

    // -------- Template clone path --------
    if (body.template_slug) {
      const template = getFlowTemplate(body.template_slug)
      if (!template) {
        throw new HttpError(400, t('flows.unknownTemplate', { slug: String(body.template_slug) }))
      }
      // Flow + nodes in one transaction: a failed node insert rolls the
      // parent back, so a half-cloned template never sits as an empty
      // draft.
      const flow = await asUser(ctx.userId, async (db) => {
        const created = await insertFlow(db, {
          user_id: ctx.userId,
          account_id: ctx.accountId,
          name: body.name?.trim() || template.name,
          description: template.description,
          status: 'draft',
          trigger_type: template.trigger_type,
          trigger_config: template.trigger_config,
          entry_node_id: template.entry_node_id,
        })
        await insertFlowNodes(
          db,
          ctx.accountId,
          created.id,
          template.nodes.map((n) => ({
            node_key: n.node_key,
            node_type: n.node_type,
            config: n.config,
          })),
        )
        return created
      })
      return NextResponse.json({ flow }, { status: 201 })
    }

    // -------- Plain (empty) create path --------
    if (!body.name?.trim()) {
      throw new HttpError(400, t('flows.nameRequired'))
    }
    const name = body.name.trim()
    const trigger_type = body.trigger_type ?? 'keyword'

    const flow = await asUser(ctx.userId, (db) =>
      insertFlow(db, {
        user_id: ctx.userId,
        account_id: ctx.accountId,
        name,
        description: body.description ?? null,
        status: 'draft',
        trigger_type,
        trigger_config: body.trigger_config ?? {},
      }),
    )
    return NextResponse.json({ flow }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
