import { NextResponse, type NextRequest } from 'next/server'

import { signInWithPassword } from '@/lib/auth/service'
import { guard, handleAuthError, readJson, sessionMeta, setSessionCookie } from '../_shared'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const body = await readJson(request)
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined
  const blocked = guard(request, 'auth-login', { limit: 10, windowMs: 60_000, key: email })
  if (blocked) return blocked
  try {
    const { user, session } = await signInWithPassword(body.email, body.password, sessionMeta(request))
    return setSessionCookie(NextResponse.json({ user, session: { user } }), session)
  } catch (err) {
    return handleAuthError(err)
  }
}
