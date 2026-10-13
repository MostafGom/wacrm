import { NextResponse } from 'next/server'
import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody } from '@/server/http'
import {
  deleteAutomation,
  getAutomation,
  updateAutomation,
  type AutomationPatch,
} from '@/server/repos/automations'

const t = getT('Api')

// ------------------------------------------------------------
// Tenancy note (GHSA-xvrq-88hg-44q6)
//
// Every handler matches the row on `account_id` — the tenancy column
// migration 017 introduced — and NOT on `user_id`, which records the
// original *author* and is never rewritten. (RLS scopes the same way;
// the explicit filter is the first line of defense.)
//
// `user_id` is not an authorization fact: `remove_account_member`
// (migration 018) moves a removed member into a fresh personal account
// as its `owner`, which clears `requireRole('agent')` trivially while
// leaving `automations.user_id` pointing at them. Matching on it let an
// ex-member keep full CRUD over automations they had authored inside
// the account they were removed from.
// ------------------------------------------------------------

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    // Reading is open to any member (`automations_select` has no role
    // floor) but is still account-scoped.
    const ctx = await requireRole('viewer')
    const result = await asUser(ctx.userId, async (db) => {
      const automation = await getAutomation(db, ctx.accountId, id)
      if (!automation) return null
      return { automation, steps: await loadStepsTree(db, ctx.accountId, id) }
    })
    if (!result) throw new HttpError(404, t('common.notFound'))
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    // Editing an automation is a write — the RLS automations_update
    // policy requires `agent`.
    const ctx = await requireRole('agent')
    const body = await readJsonBody(request)

    const update: AutomationPatch = {}
    for (const k of [
      'name',
      'description',
      'trigger_type',
      'trigger_config',
      'is_active',
    ] as const) {
      if (k in body) (update as Record<string, unknown>)[k] = body[k]
    }
    const steps = Array.isArray(body.steps) ? (body.steps as BuilderStepInput[]) : null

    const outcome = await asUser(ctx.userId, async (db) => {
      // Tenancy check before we touch anything. Load the fields we need
      // to compute the post-patch "effective" state for validation.
      const existing = await getAutomation(db, ctx.accountId, id)
      if (!existing) return { notFound: true as const }

      // If this PATCH leaves the automation active (either explicitly
      // activating it OR editing an already-active one), validate the
      // merged configuration first. Activation is the natural gate —
      // drafts are still allowed to be incomplete.
      const willBeActive =
        typeof update.is_active === 'boolean' ? update.is_active : existing.is_active
      if (willBeActive) {
        const mergedTriggerType = (update.trigger_type ?? existing.trigger_type) as string
        const mergedTriggerConfig = update.trigger_config ?? existing.trigger_config
        const mergedSteps = steps
          ? (steps as { step_type: string; step_config: Record<string, unknown> }[])
          : await loadStepsTree(db, ctx.accountId, id)
        const issues = [
          ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
          ...validateStepsForActivation(mergedSteps),
        ]
        if (issues.length > 0) return { issues }
      }

      if (Object.keys(update).length > 0) {
        await updateAutomation(db, ctx.accountId, id, update)
      }
      // Same transaction: the row and its step tree change together.
      if (steps) await replaceSteps(db, ctx.accountId, id, steps)
      return { ok: true as const }
    })

    if ('notFound' in outcome) throw new HttpError(404, t('common.notFound'))
    if ('issues' in outcome) {
      return NextResponse.json(
        {
          error: t('automations.invalidActiveConfig'),
          issues: outcome.issues,
        },
        { status: 400 },
      )
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    // Deleting an automation is a write — `agent`, like the RLS
    // automations_delete policy. A row outside the account is a no-op.
    const ctx = await requireRole('agent')
    await asUser(ctx.userId, (db) => deleteAutomation(db, ctx.accountId, id))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
