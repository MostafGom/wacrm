// GET /api/me — the signed-in user's profile + account summary, used by
// the AuthProvider (src/hooks/use-auth.tsx). Returns profile: null when
// the user has no profile row (a bootstrap failure the UI explains).

import { NextResponse } from 'next/server'

import { UnauthorizedError, toErrorResponse } from '@/lib/auth/account'
import { getServerSession } from '@/lib/auth/server-session'
import { asUser } from '@/server/db'
import { getAccountSummary, getProfileByUserId } from '@/server/repos/profiles'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const session = await getServerSession()
    if (!session) throw new UnauthorizedError()
    const userId = session.user.id
    const result = await asUser(userId, async (db) => {
      const profile = await getProfileByUserId(db, userId)
      const account = profile?.account_id ? await getAccountSummary(db, profile.account_id) : null
      return { profile: profile ?? null, account: account ?? null }
    })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
