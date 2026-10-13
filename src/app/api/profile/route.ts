// PATCH /api/profile { full_name, avatar_url } — update the signed-in
// user's own display name + avatar (Settings → Profile). Any signed-in
// user; only their own row is touched (RLS profiles_update backs it up).
// The avatar itself is uploaded by the browser to the `avatars` bucket
// first; this stores the resulting public URL (or null to remove it).
//
// Email changes don't go through here — they use the auth API
// (PUT /api/auth/user) so the confirmation flow applies.

import { NextResponse } from 'next/server'

import { HttpError, UnauthorizedError, toErrorResponse } from '@/lib/auth/account'
import { getServerSession } from '@/lib/auth/server-session'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { optionalString, readJsonBody, requiredString } from '@/server/http'
import { updateOwnProfile } from '@/server/repos/account'

const t = getT('Api.common')

export async function PATCH(request: Request) {
  try {
    const session = await getServerSession()
    if (!session) throw new UnauthorizedError()
    const userId = session.user.id

    const body = await readJsonBody(request)
    const fullName = requiredString(body.full_name, undefined, 200)
    const avatarUrl = optionalString(body.avatar_url, 2048) ?? null

    const updated = await asUser(userId, (db) =>
      updateOwnProfile(db, userId, { full_name: fullName, avatar_url: avatarUrl }),
    )
    if (!updated) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
