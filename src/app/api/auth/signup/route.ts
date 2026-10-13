import { NextResponse, type NextRequest } from 'next/server'

import { signUp } from '@/lib/auth/service'
import { guard, handleAuthError, readJson, sessionMeta, setSessionCookie } from '../_shared'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const blocked = guard(request, 'auth-signup', { limit: 5, windowMs: 60_000 })
  if (blocked) return blocked
  const body = await readJson(request)
  const data = (body.data ?? {}) as Record<string, unknown>
  try {
    const { user, session } = await signUp(
      {
        email: body.email,
        password: body.password,
        fullName: data.full_name,
        redirectTo: typeof body.redirectTo === 'string' ? body.redirectTo : undefined,
        inviteToken: typeof body.inviteToken === 'string' ? body.inviteToken : null,
      },
      sessionMeta(request),
    )
    const res = NextResponse.json({ user, session: session ? { user } : null })
    return session ? setSessionCookie(res, session) : res
  } catch (err) {
    return handleAuthError(err)
  }
}
