import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'
import { asService } from '@/server/db'
import { listActiveRunsForSweep, timeOutRun } from '@/server/repos/flow-runs'

/**
 * Sweep abandoned active flow runs.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Without this sweep, a customer who abandons a flow mid-conversation
 * keeps a row in `idx_one_active_run_per_contact` (the partial unique
 * index on `flow_runs WHERE status='active'`) forever — blocking any
 * new triggers for them. The cron is therefore not optional.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision. The two endpoints (`/api/automations/cron`
 * and this one) are independent operations; we keep them on separate
 * URLs so one failing doesn't block the other.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger). A 5-minute interval is more than enough for a 24h timeout
 * default; once per hour would also be acceptable for low-volume
 * tenants.
 *
 * The scan spans accounts by design (it runs as the service role); each
 * timeout is a single gated UPDATE on the run's id.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Constant-time compare so an attacker who can hit the endpoint
  // can't recover the secret byte-by-byte from response-time deltas.
  // Length pre-check is required by timingSafeEqual (throws otherwise)
  // and leaks only the length itself, which isn't sensitive.
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()

  // Pull all currently-active runs along with their parent flow's
  // fallback_policy. Joined in one query — the small set of active
  // runs per tenant keeps this cheap.
  let runs: Awaited<ReturnType<typeof listActiveRunsForSweep>>
  try {
    runs = await asService((db) => listActiveRunsForSweep(db))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[flows-cron] active-run scan failed:', message)
    return NextResponse.json({ error: 'active-run scan failed' }, { status: 500 })
  }
  if (!runs.length) return NextResponse.json({ swept: 0 })

  let swept = 0
  for (const r of runs) {
    const policy = resolveFallbackPolicy(
      (r.fallback_policy ?? null) as Parameters<typeof resolveFallbackPolicy>[0],
    )
    const lastAdvanced = new Date(r.last_advanced_at)
    const ageHours = (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60)
    if (ageHours < policy.on_timeout_hours) continue

    // Mark timed_out — guarded by the precondition `status='active'`
    // so concurrent advance from a late inbound doesn't overwrite a
    // legitimate update. The `timeout` event lands in the same
    // transaction.
    const timedOut = await asService((db) =>
      timeOutRun(db, r.id, now, {
        age_hours: Math.round(ageHours * 10) / 10,
        policy_hours: policy.on_timeout_hours,
      }),
    ).catch((err) => {
      console.error('[flows-cron] timeout failed:', r.id, err)
      return false
    })
    if (timedOut) swept += 1
  }

  return NextResponse.json({ swept })
}
