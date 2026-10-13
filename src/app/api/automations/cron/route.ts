import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { expireAwaitingReplies, resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { asService } from '@/server/db'
import { claimPendingExecution, listDuePendingExecutions } from '@/server/repos/automation-runs'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows: a single
 * `UPDATE … WHERE status = 'pending' RETURNING id` per row, so only
 * one invocation wins it. SELECT ... FOR UPDATE is avoided — the claim
 * commits before the (slow, network-bound) resume runs.
 *
 * The due-row scan spans accounts by design; each row's own account_id
 * scopes everything the engine does with it.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Close out wait_for_reply runs whose 24h reply window lapsed. The
  // webhook already refuses to resume them; this just settles their
  // status and explains the outcome on the log.
  const expired = await expireAwaitingReplies()

  let due
  try {
    due = await asService((db) => listDuePendingExecutions(db, new Date(), 50))
  } catch (error) {
    console.error('[automations-cron] due scan failed:', error)
    return NextResponse.json({ error: 'due scan failed' }, { status: 500 })
  }
  if (due.length === 0) return NextResponse.json({ processed: 0, expired })

  let processed = 0
  for (const row of due) {
    // Claim and resume are separate transactions: the claim commits
    // first, so the resume (which calls Meta) holds no lock.
    const claimed = await asService((db) => claimPendingExecution(db, row.id, 'pending')).catch(
      (err) => {
        console.error('[automations-cron] claim failed:', row.id, err)
        return false
      },
    )
    if (!claimed) continue

    await resumePendingExecution({
      id: row.id,
      automation_id: row.automation_id,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id,
      user_id: row.user_id,
      contact_id: row.contact_id ?? null,
      log_id: row.log_id ?? null,
      parent_step_id: row.parent_step_id ?? null,
      branch: row.branch ?? null,
      next_step_position: row.next_step_position,
      context: (row.context as AutomationContext | null) ?? {},
    })
    processed++
  }

  return NextResponse.json({ processed, expired })
}
