// ============================================================
// POST /api/account/members/[userId]/reset-link — owner only.
//
// Generates a single-use, one-hour password-reset link for a member
// of the caller's account. This is how password resets work on a
// self-hosted install without SMTP: the owner shares the link with the
// teammate over a channel they trust. (With SMTP configured the normal
// "Forgot password" email flow works as well.)
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { generateRecoveryLink } from '@/lib/auth/service'
import { getT } from '@/lib/i18n/translate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { asUser } from '@/server/db'
import { isMemberOfAccount } from '@/server/repos/members'

export const runtime = 'nodejs'

const t = getT('Api')

function baseUrl(request: Request): string {
  const fromEnv = process.env.PUBLIC_URL ?? process.env.NEXT_PUBLIC_SITE_URL
  if (fromEnv) return fromEnv
  const proto = request.headers.get('x-forwarded-proto') ?? 'http'
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  return `${proto}://${host}`
}

export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const ctx = await requireRole('owner')
    const limit = checkRateLimit(`admin:resetLink:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { userId } = await params
    // Only members of the caller's account qualify (RLS backs this up).
    const member = await asUser(ctx.userId, (db) => isMemberOfAccount(db, ctx.accountId, userId)).catch(() => false)
    if (!member) {
      return NextResponse.json({ error: t('account.members.notFound') }, { status: 404 })
    }

    const url = await generateRecoveryLink(userId, baseUrl(request))
    console.info(`[reset-link] owner ${ctx.userId} generated a reset link for ${userId}`)
    return NextResponse.json({ url, expires_in_minutes: 60 }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return toErrorResponse(err)
  }
}
