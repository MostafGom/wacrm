// ============================================================
// POST /api/db — the browser's data endpoint.
//
// Receives a query/RPC AST recorded by the browser query builder
// (`@/lib/supabase/client`), validates its shape, and runs it as the
// signed-in user (`authenticated` role, auth.uid() = session user), so
// the RLS policies from the migrations decide what is visible — the
// same trust model Supabase's PostgREST endpoint had, minus anonymous
// access and with an RPC allowlist.
//
// Transitional: Phase B moves feature by feature to typed server
// routes, shrinking what reaches this endpoint (see DB_HTTP_DENY_TABLES).
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'

import { SESSION_COOKIE, validateSession } from '@/lib/auth/session'
import { DbRequestError } from '@/lib/db/ast'
import { execute } from '@/lib/db/execute'
import { validateBrowserAst } from '@/lib/db/validate'
import { isSameOrigin } from '@/lib/http/request'
import { checkRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 2 * 1024 * 1024

function errorResult(status: number, code: string, message: string) {
  return NextResponse.json(
    { data: null, error: { message, code, details: null, hint: null }, count: null, status, statusText: 'Error' },
    { status },
  )
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return errorResult(403, 'forbidden_origin', 'Cross-origin request rejected')

  const session = await validateSession(request.cookies.get(SESSION_COOKIE)?.value)
  if (!session) return errorResult(401, 'PGRST301', 'Not signed in')

  if (!checkRateLimit(`db:${session.user.id}`, { limit: 1200, windowMs: 60_000 }).success) {
    return errorResult(429, 'rate_limited', 'Too many requests')
  }

  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_BODY_BYTES) return errorResult(413, 'PGRST413', 'Request body too large')

  let ast
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) return errorResult(413, 'PGRST413', 'Request body too large')
    ast = validateBrowserAst(JSON.parse(raw))
  } catch (err) {
    if (err instanceof DbRequestError) return errorResult(err.status, err.code, err.message)
    return errorResult(400, 'PGRST100', 'Malformed request body')
  }

  if (process.env.NODE_ENV === 'development' && process.env.DB_LOG_HTTP === 'true') {
    console.log(`[api/db] ${ast.kind === 'rpc' ? `rpc ${ast.fn}` : `${ast.op} ${ast.table}`}`)
  }

  const result = await execute(ast, { role: 'authenticated', userId: session.user.id, timeoutMs: 15_000 })
  // Always 200 for a well-formed request: supabase-js callers read
  // `error` from the body, and the body carries PostgREST's status.
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
