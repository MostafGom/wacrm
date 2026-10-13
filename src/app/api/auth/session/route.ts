import { NextResponse, type NextRequest } from 'next/server'

import { currentSession, handleAuthError } from '../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const session = await currentSession(request)
    return NextResponse.json(
      { session: session ? { user: session.user } : null },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return handleAuthError(err)
  }
}
