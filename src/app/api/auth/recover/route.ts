import { NextResponse, type NextRequest } from 'next/server'

import { isMailEnabled } from '@/lib/auth/mailer'
import { requestPasswordReset } from '@/lib/auth/service'
import { guard, handleAuthError, readJson } from '../_shared'

export const runtime = 'nodejs'

// Always 200 for a well-formed request, whether or not the address
// exists — no account enumeration. `mail_enabled: false` tells the UI
// to point the user at their workspace owner instead of their inbox.
export async function POST(request: NextRequest) {
  const body = await readJson(request)
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined
  const blocked = guard(request, 'auth-recover', { limit: 5, windowMs: 60_000, key: email })
  if (blocked) return blocked
  try {
    await requestPasswordReset(body.email, typeof body.redirectTo === 'string' ? body.redirectTo : undefined)
    return NextResponse.json({ ok: true, mail_enabled: isMailEnabled() })
  } catch (err) {
    return handleAuthError(err)
  }
}
