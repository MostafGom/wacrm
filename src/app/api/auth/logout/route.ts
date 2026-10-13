import { NextResponse, type NextRequest } from 'next/server'

import { revokeAllSessions, revokeSessionToken, SESSION_COOKIE, validateSession } from '@/lib/auth/session'
import { clearSessionCookie, guard, handleAuthError, readJson } from '../_shared'

export const runtime = 'nodejs'

// scope: 'local' (this device, default) | 'global' (every device) |
// 'others' (every device except this one) — same as supabase-js.
export async function POST(request: NextRequest) {
  const blocked = guard(request, 'auth-logout', { limit: 30, windowMs: 60_000 })
  if (blocked) return blocked
  const { scope = 'local' } = await readJson(request)
  const token = request.cookies.get(SESSION_COOKIE)?.value
  try {
    const session = await validateSession(token)
    if (session && scope === 'global') await revokeAllSessions(session.user.id)
    else if (session && scope === 'others') await revokeAllSessions(session.user.id, session.sessionId)
    else if (token) await revokeSessionToken(token)
    const res = NextResponse.json({ ok: true })
    return scope === 'others' ? res : clearSessionCookie(res)
  } catch (err) {
    return handleAuthError(err)
  }
}
