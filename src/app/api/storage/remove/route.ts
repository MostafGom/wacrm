// POST /api/storage/remove { bucket, paths } — deletes objects the
// signed-in user may delete under the bucket's RLS policies.

import { NextResponse, type NextRequest } from 'next/server'

import { SESSION_COOKIE, validateSession } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/http/request'
import { removeObjects, toStorageError } from '@/lib/storage/server'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 })
  const session = await validateSession(request.cookies.get(SESSION_COOKIE)?.value)
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })

  const body = (await request.json().catch(() => null)) as { bucket?: unknown; paths?: unknown } | null
  if (
    !body ||
    typeof body.bucket !== 'string' ||
    !Array.isArray(body.paths) ||
    body.paths.length > 100 ||
    !body.paths.every((p) => typeof p === 'string')
  ) {
    return NextResponse.json({ error: 'bucket and paths[] are required' }, { status: 400 })
  }
  try {
    const removed = await removeObjects('authenticated', session.user.id, body.bucket, body.paths as string[])
    return NextResponse.json({ removed })
  } catch (err) {
    const e = toStorageError(err)
    return NextResponse.json({ error: e.message }, { status: Number(e.statusCode ?? 500) })
  }
}
