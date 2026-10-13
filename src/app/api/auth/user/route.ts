import { NextResponse, type NextRequest } from 'next/server'

import { updateUser } from '@/lib/auth/service'
import { authError, currentSession, guard, handleAuthError, readJson } from '../_shared'
import { getT } from '@/lib/i18n/translate'

export const runtime = 'nodejs'

const t = getT('Auth.errors')

// PUT { password?, current_password?, email?, data? } — getAuthClient().updateUser().
export async function PUT(request: NextRequest) {
  const blocked = guard(request, 'auth-user', { limit: 20, windowMs: 60_000 })
  if (blocked) return blocked
  const session = await currentSession(request)
  if (!session) return authError('session_missing', 401, t('sessionMissing'))
  const body = await readJson(request)
  try {
    const { user, emailChangePending } = await updateUser(session.user.id, session.sessionId, {
      password: body.password,
      currentPassword: body.current_password,
      email: body.email,
      data: body.data,
    })
    return NextResponse.json({ user, email_change_pending: emailChangePending })
  } catch (err) {
    return handleAuthError(err)
  }
}
