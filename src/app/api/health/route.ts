// GET /api/health — liveness + database reachability, for the
// docker-compose healthcheck and uptime monitors. No auth, no data.

import { getPool } from '@/lib/db/pool'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await getPool().query('SELECT 1')
    return Response.json({ ok: true })
  } catch {
    return Response.json({ ok: false, error: 'database unreachable' }, { status: 503 })
  }
}
