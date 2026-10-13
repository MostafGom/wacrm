// POST /api/storage/upload (multipart: bucket, path, file, [upsert],
// [contentType], [cacheControl]) — browser uploads. Authorisation is the
// bucket's RLS policies on storage.objects (the row is inserted as the
// signed-in user); size / MIME limits come from storage.buckets.

import { NextResponse, type NextRequest } from 'next/server'

import { SESSION_COOKIE, validateSession } from '@/lib/auth/session'
import { isSameOrigin } from '@/lib/http/request'
import { checkRateLimit } from '@/lib/rate-limit'
import { publicObjectUrl } from '@/lib/storage/public-url'
import { toStorageError, uploadObject } from '@/lib/storage/server'

export const runtime = 'nodejs'

// Largest bucket limit is 16 MB; leave room for multipart overhead.
const MAX_REQUEST_BYTES = 17 * 1024 * 1024

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 })
  const session = await validateSession(request.cookies.get(SESSION_COOKIE)?.value)
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!checkRateLimit(`upload:${session.user.id}`, { limit: 60, windowMs: 60_000 }).success) {
    return NextResponse.json({ error: 'Too many uploads' }, { status: 429 })
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'The object exceeded the maximum allowed size' }, { status: 413 })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }
  const bucket = form.get('bucket')
  const path = form.get('path')
  const file = form.get('file')
  if (typeof bucket !== 'string' || typeof path !== 'string' || !(file instanceof Blob)) {
    return NextResponse.json({ error: 'bucket, path and file are required' }, { status: 400 })
  }
  const contentType = (form.get('contentType') as string | null) || file.type || undefined

  try {
    await uploadObject('authenticated', session.user.id, {
      bucket,
      path,
      body: Buffer.from(await file.arrayBuffer()),
      contentType,
      cacheControl: (form.get('cacheControl') as string | null) ?? undefined,
      upsert: form.get('upsert') === 'true',
    })
    return NextResponse.json({ path, publicUrl: publicObjectUrl(bucket, path) })
  } catch (err) {
    const e = toStorageError(err)
    return NextResponse.json({ error: e.message }, { status: Number(e.statusCode ?? 500) })
  }
}
