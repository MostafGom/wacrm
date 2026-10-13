// ============================================================
// GET /api/realtime — Server-Sent Events stream of row changes for
// the signed-in user's account (replaces Supabase Realtime).
//
// Events:
//   event: change   data: { t, op, new, old, ts }
//   event: resync   the server may have missed events; refetch
// A comment line is sent every 25 s to keep proxies from idling the
// connection out. The session is re-checked every 5 minutes, so a
// revoked session stops receiving data.
//
// Requires a long-running Node server (docker / VPS) — not suitable
// for serverless platforms that cap response duration.
// ============================================================

import { SESSION_COOKIE, validateSession } from '@/lib/auth/session'
import { withRole } from '@/lib/db/tx'
import { getHub, type Subscriber } from '@/lib/realtime/hub'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PING_MS = 25_000
const RECHECK_MS = 5 * 60_000
const MAX_STREAMS_PER_USER = 8

export async function GET(request: Request) {
  const token = request.headers
    .get('cookie')
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1)
  const session = await validateSession(token)
  if (!session) return new Response('Not signed in', { status: 401 })

  const accountId = await withRole('authenticated', session.user.id, async (c) => {
    const r = await c.query<{ account_id: string | null }>(
      'SELECT account_id FROM public.profiles WHERE user_id = $1',
      [session.user.id],
    )
    return r.rows[0]?.account_id ?? null
  })
  if (!accountId) return new Response('No account', { status: 403 })

  const hub = getHub()
  if (hub.countFor(session.user.id) >= MAX_STREAMS_PER_USER) {
    return new Response('Too many realtime connections', { status: 429 })
  }

  const encoder = new TextEncoder()
  let cleanup = () => {}

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const write = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }
      const sub: Subscriber = {
        accountId,
        userId: session.user.id,
        send(event, data) {
          write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        },
      }

      const ping = setInterval(() => write(': ping\n\n'), PING_MS)
      const recheck = setInterval(async () => {
        const still = await validateSession(token).catch(() => null)
        if (!still) cleanup()
      }, RECHECK_MS)

      cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(ping)
        clearInterval(recheck)
        hub.remove(sub)
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
      request.signal.addEventListener('abort', () => cleanup())

      // Tell EventSource to retry after 3 s if the stream drops.
      write('retry: 3000\n\n')
      await hub.add(sub)
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable nginx response buffering for this stream.
      'X-Accel-Buffering': 'no',
    },
  })
}
