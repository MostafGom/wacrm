// Helpers shared by the /api/auth/* route handlers.

import { NextResponse, type NextRequest } from 'next/server'

import { AuthFailure, type IssuedSession, type SessionMeta } from '@/lib/auth/service'
import { SESSION_COOKIE, sessionCookieOptions, validateSession } from '@/lib/auth/session'
import { getClientIp, isSameOrigin } from '@/lib/http/request'
import { getT } from '@/lib/i18n/translate'
import { checkRateLimit } from '@/lib/rate-limit'

const t = getT('Auth.errors')

export function authError(code: string, status: number, message: string): NextResponse {
  // Shape matches what the browser auth facade turns into an AuthError.
  return NextResponse.json({ error: { code, message } }, { status })
}

export function handleAuthError(err: unknown): NextResponse {
  if (err instanceof AuthFailure) return authError(err.code, err.status, err.message)
  console.error('[auth] unexpected error:', err)
  return authError('unexpected_failure', 500, t('unexpected'))
}

export function sessionMeta(request: NextRequest): SessionMeta {
  return { userAgent: request.headers.get('user-agent'), ip: getClientIp(request) }
}

export function setSessionCookie(res: NextResponse, session: IssuedSession): NextResponse {
  res.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt))
  return res
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(new Date(0)), maxAge: 0 })
  return res
}

/**
 * Same-origin + per-IP (and optional per-key) rate limit. Returns a
 * response to send back, or null to continue.
 */
export function guard(
  request: NextRequest,
  bucket: string,
  opts: { limit: number; windowMs: number; key?: string },
): NextResponse | null {
  if (!isSameOrigin(request)) return authError('forbidden_origin', 403, t('forbiddenOrigin'))
  const ip = getClientIp(request)
  const checks = [`${bucket}:ip:${ip}`]
  if (opts.key) checks.push(`${bucket}:key:${opts.key}`)
  for (const k of checks) {
    if (!checkRateLimit(k, opts).success) {
      return authError('over_request_rate_limit', 429, t('rateLimited'))
    }
  }
  return null
}

export async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function currentSession(request: NextRequest) {
  return validateSession(request.cookies.get(SESSION_COOKIE)?.value)
}
