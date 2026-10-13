import { NextResponse } from 'next/server'
import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import {
  getAutomation,
  insertAutomation,
  insertAutomationSteps,
  listAutomationSteps,
} from '@/server/repos/automations'

const t = getT('Api')

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    // Duplicating creates a new automation row — a write. `agent`, like
    // the RLS automations_insert policy.
    const ctx = await requireRole('agent')

    const copy = await asUser(ctx.userId, async (db) => {
      // Match on `account_id`, not `user_id` — see the tenancy note in the
      // sibling [id]/route.ts (GHSA-xvrq-88hg-44q6). `user_id` records the
      // author and survives removal from the account, so scoping the source
      // row by it let an ex-member clone an automation straight back into
      // the account they no longer belong to.
      const original = await getAutomation(db, ctx.accountId, id)
      if (!original) return null

      const created = await insertAutomation(db, {
        // Clone into the caller's own account. Equal to
        // `original.account_id` by construction now that the lookup above
        // is account-scoped; written from the caller's context so the
        // insert can never land in an account they aren't a member of.
        account_id: ctx.accountId,
        user_id: ctx.userId,
        name: t('automations.copyName', { name: original.name }),
        description: original.description ?? null,
        trigger_type: original.trigger_type,
        trigger_config: original.trigger_config,
        is_active: false,
      })

      const steps = await listAutomationSteps(db, ctx.accountId, id)
      if (steps.length > 0) {
        // Re-map parent_step_id: build old→new id map first so the
        // inserted rows carry correct parent references.
        const idMap = new Map<string, string>()
        for (const row of steps) idMap.set(row.id, crypto.randomUUID())
        await insertAutomationSteps(
          db,
          ctx.accountId,
          steps.map((row) => ({
            id: idMap.get(row.id)!,
            automation_id: created.id,
            parent_step_id: row.parent_step_id ? (idMap.get(row.parent_step_id) ?? null) : null,
            branch: row.branch,
            step_type: row.step_type,
            step_config: row.step_config,
            position: row.position,
          })),
        )
      }
      return created
    })

    if (!copy) throw new HttpError(404, t('common.notFound'))
    return NextResponse.json({ automation: copy }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
