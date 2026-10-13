import { NextResponse } from 'next/server'
import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateFlowForActivation } from '@/lib/flows/validate'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody } from '@/server/http'
import { getFlow, listFlowNodes, updateFlow } from '@/server/repos/flows'

const t = getT('Api')

/**
 * POST /api/flows/[id]/activate
 *
 * Body: { status: 'draft' | 'active' | 'archived' }
 *
 * Activating runs the full validator and refuses on any 'error'
 * severity issue. Drafts and archives are unconditional — users
 * need to be able to save broken-work-in-progress and pause flows
 * without first fixing them.
 *
 * Returns the updated flow on success; on validation failure returns
 * the full issue list so the builder can highlight each problem.
 */

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params

    // Changing status (activate / draft / archive) is a write — the RLS
    // flows_update policy requires `agent`.
    const ctx = await requireRole('agent')

    const body = (await readJsonBody(request).catch(() => null)) as
      | { status?: 'draft' | 'active' | 'archived' }
      | null
    const status = body?.status
    if (!status || !['draft', 'active', 'archived'].includes(status)) {
      throw new HttpError(400, t('flows.statusInvalid'))
    }

    const result = await asUser(ctx.userId, async (db) => {
      const flow = await getFlow(db, ctx.accountId, id)
      if (!flow) return { notFound: true as const }

      if (status === 'active') {
        const nodes = await listFlowNodes(db, ctx.accountId, id)
        const issues = validateFlowForActivation(
          {
            name: flow.name,
            trigger_type: flow.trigger_type,
            trigger_config: flow.trigger_config as Record<string, unknown>,
            entry_node_id: flow.entry_node_id,
          },
          nodes.map((n) => ({ node_key: n.node_key, node_type: n.node_type, config: n.config })),
        )
        if (issues.some((i) => i.severity === 'error')) return { issues }
      }

      return { flow: await updateFlow(db, ctx.accountId, id, { status }) }
    })

    if ('notFound' in result) throw new HttpError(404, t('common.notFound'))
    if ('issues' in result) {
      return NextResponse.json(
        {
          error: t('flows.cannotActivate'),
          issues: result.issues,
        },
        { status: 422 },
      )
    }
    return NextResponse.json({ flow: result.flow ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
