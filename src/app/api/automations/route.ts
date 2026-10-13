// GET  /api/automations — the account's automations, newest first (any member).
// POST /api/automations — create an automation, optionally from a template
//                         and with its step tree (agent+, like the RLS policy).

import { NextResponse } from 'next/server'
import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getTemplate } from '@/lib/automations/templates'
import { insertSteps, type BuilderStepInput } from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody } from '@/server/http'
import { insertAutomation, listAutomations } from '@/server/repos/automations'

const t = getT('Api')

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const automations = await asUser(ctx.userId, (db) => listAutomations(db, ctx.accountId))
    return NextResponse.json({ automations })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    // Creating an automation is a write — the RLS automations_insert
    // policy requires `agent`.
    const ctx = await requireRole('agent')
    const body = await readJsonBody(request)

    const { name, description, trigger_type, trigger_config, is_active, steps, template } = body as {
      name?: string
      description?: string | null
      trigger_type?: string
      trigger_config?: Record<string, unknown>
      is_active?: boolean
      steps?: BuilderStepInput[]
      template?: string
    }

    let effectiveSteps: BuilderStepInput[] | undefined = steps
    let effectiveName = name
    let effectiveDescription = description
    let effectiveTriggerType = trigger_type
    let effectiveTriggerConfig = trigger_config

    if (template && (!steps || steps.length === 0)) {
      const tpl = getTemplate(template)
      if (tpl) {
        effectiveName = effectiveName ?? tpl.name
        effectiveDescription = effectiveDescription ?? tpl.description
        effectiveTriggerType = effectiveTriggerType ?? tpl.trigger_type
        effectiveTriggerConfig = effectiveTriggerConfig ?? (tpl.trigger_config as Record<string, unknown>)
        effectiveSteps = tpl.steps as unknown as BuilderStepInput[]
      }
    }

    if (
      !effectiveName ||
      !effectiveTriggerType ||
      typeof effectiveName !== 'string' ||
      typeof effectiveTriggerType !== 'string'
    ) {
      throw new HttpError(400, t('automations.nameTriggerRequired'))
    }
    if (effectiveSteps !== undefined && !Array.isArray(effectiveSteps)) {
      throw new HttpError(400, t('common.invalidRequestBody'))
    }

    // Block activation of a clearly broken automation up-front instead of
    // letting every trigger silently produce a failed log row. Drafts
    // (is_active=false) are allowed to be incomplete so users can save
    // progress mid-build.
    if (is_active) {
      const issues = [
        ...validateTriggerForActivation(effectiveTriggerType, effectiveTriggerConfig ?? {}),
        ...validateStepsForActivation(
          (effectiveSteps ?? []) as unknown as { step_type: string; step_config: Record<string, unknown> }[],
        ),
      ]
      if (issues.length > 0) {
        return NextResponse.json(
          { error: t('automations.invalidActivateConfig'), issues },
          { status: 400 },
        )
      }
    }

    const triggerType = effectiveTriggerType
    const automationName = effectiveName
    // The automation and its steps commit together.
    const automation = await asUser(ctx.userId, async (db) => {
      const row = await insertAutomation(db, {
        user_id: ctx.userId,
        account_id: ctx.accountId,
        name: automationName,
        description: effectiveDescription ?? null,
        trigger_type: triggerType,
        trigger_config: effectiveTriggerConfig ?? {},
        is_active: !!is_active,
      })
      if (effectiveSteps && effectiveSteps.length > 0) {
        await insertSteps(db, ctx.accountId, row.id, effectiveSteps)
      }
      return row
    })

    return NextResponse.json({ automation }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
