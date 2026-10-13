import { NextResponse } from 'next/server'
import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { listRunEvents, listRunsForFlow } from '@/server/repos/flow-runs'
import { getFlow } from '@/server/repos/flows'

const t = getT('Api')

/**
 * GET /api/flows/[id]/runs
 *
 * Newest-first list of flow runs for a single flow, with the event
 * timeline for each. Used by the run-history viewer page
 * (`/flows/[id]/runs`) to give the owner end-to-end visibility into
 * what the bot did with each customer.
 *
 * Any member may read (flow_runs_select has no role floor); every
 * query is scoped to the caller's account.
 *
 * Limited to the 50 most recent runs. Pagination can come later;
 * the dashboard surface here is for debugging, not heavy querying.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const ctx = await requireRole('viewer')

    const found = await asUser(ctx.userId, async (db) => {
      // Confirm the flow exists in the account before the run query —
      // gives us a clean 404 instead of an empty array.
      const flow = await getFlow(db, ctx.accountId, id)
      if (!flow) return null
      // Each run comes with its contact (id, name, phone).
      const runs = await listRunsForFlow(db, ctx.accountId, id, 50)
      return { flow: { id: flow.id, name: flow.name }, runs }
    })
    if (!found) throw new HttpError(404, t('common.notFound'))

    // One events query for every run. Separate transaction so a failure
    // stays non-fatal — the page can still show runs without timelines.
    let events: Awaited<ReturnType<typeof listRunEvents>> = []
    if (found.runs.length > 0) {
      try {
        events = await asUser(ctx.userId, (db) =>
          listRunEvents(
            db,
            ctx.accountId,
            found.runs.map((r) => r.id),
          ),
        )
      } catch (evsErr) {
        console.error('[flows-runs] events fetch failed:', evsErr)
      }
    }

    return NextResponse.json({ flow: found.flow, runs: found.runs, events })
  } catch (err) {
    return toErrorResponse(err)
  }
}
