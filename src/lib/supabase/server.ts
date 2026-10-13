// Session-scoped server client (route handlers, server components).
//
// Resolves the `wacrm_session` cookie and returns a DbClient whose
// queries run as `authenticated` with auth.uid() = the signed-in user
// (or as `anon` without a session), so every RLS policy applies exactly
// as it did under Supabase. The module path is kept so existing
// `import { createClient } from '@/lib/supabase/server'` call sites
// work unchanged.
import { cookies } from 'next/headers'

import { SESSION_COOKIE, validateSession, type ValidSession } from '@/lib/auth/session'
import { createServerDb } from '@/lib/db/server-client'
import type { DbClient } from '@/lib/db/types'
import { userStorage } from '@/lib/storage/server'

export async function getServerSession(): Promise<ValidSession | null> {
  const cookieStore = await cookies()
  return validateSession(cookieStore.get(SESSION_COOKIE)?.value)
}

export async function createClient(): Promise<DbClient> {
  const session = await getServerSession()
  const userId = session?.user.id ?? null
  return createServerDb({
    role: userId ? 'authenticated' : 'anon',
    userId,
    user: session?.user ?? null,
    storage: userStorage(userId),
  })
}
