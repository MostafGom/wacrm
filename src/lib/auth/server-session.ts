// Session of the current request, read from the `wacrm_session` cookie
// (route handlers / server components). Server-only.

import { cookies } from 'next/headers'

import { SESSION_COOKIE, validateSession, type ValidSession } from './session'

export async function getServerSession(): Promise<ValidSession | null> {
  const cookieStore = await cookies()
  return validateSession(cookieStore.get(SESSION_COOKIE)?.value)
}
