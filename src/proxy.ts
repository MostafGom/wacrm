import { NextResponse, type NextRequest } from 'next/server'

import { SESSION_COOKIE, sessionCookieOptions, validateSession } from '@/lib/auth/session'

// Next 16 "proxy" (formerly middleware) — runs on the Node.js runtime,
// so it can validate the session against Postgres directly. Route
// handlers and /api/db re-validate on their own; this layer only
// decides redirects and keeps the sliding session cookie fresh.
export async function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value
  let session: Awaited<ReturnType<typeof validateSession>> = null
  try {
    session = await validateSession(token)
  } catch (err) {
    // DB unreachable — treat as signed out rather than 500 every page.
    console.error('[proxy] session validation failed:', err)
  }
  const user = session?.user ?? null

  // Re-issue the cookie with the (possibly slid) expiry, or clear a dead one.
  const withSessionCookie = <T extends NextResponse>(response: T): T => {
    if (session && token) {
      response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(session.expiresAt))
    } else if (token) {
      response.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(new Date(0)), maxAge: 0 })
    }
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withSessionCookie(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  // Every top-level route under src/app/(dashboard)/ belongs here —
  // proxy.test.ts reads that directory and fails on a missing one.
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/flows', '/agents', '/notifications', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withSessionCookie(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return withSessionCookie(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return withSessionCookie(NextResponse.next({ request }))
}

export const config = {
  matcher: [
    // Skip static assets and the public media route (Meta fetches it
    // without cookies; no session lookup needed).
    '/((?!_next/static|_next/image|favicon.ico|api/storage/public/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
