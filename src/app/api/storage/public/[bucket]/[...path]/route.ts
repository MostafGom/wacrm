// GET /api/storage/public/<bucket>/<path> — public object reads.
//
// Must stay unauthenticated: Meta's servers fetch outbound media
// (images, documents, voice notes) from these URLs. Only objects that
// are registered in storage.objects inside a `public` bucket are served,
// with headers that stop a hostile upload from executing in our origin.

import { Readable } from 'node:stream'

import { InvalidObjectPathError, getDriver } from '@/lib/storage/driver'
import { getPublicObjectMeta } from '@/lib/storage/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const INLINE = /^(image|audio|video)\/|^application\/pdf$/

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bucket: string; path: string[] }> },
) {
  const { bucket, path: segments } = await params
  const path = segments.map((s) => decodeURIComponent(s)).join('/')

  let meta
  try {
    meta = await getPublicObjectMeta(bucket, path)
  } catch (err) {
    if (err instanceof InvalidObjectPathError) return notFound()
    throw err
  }
  if (!meta) return notFound()

  const etag = `"${Buffer.from(`${meta.updatedAt}:${meta.size}`).toString('base64url')}"`
  const baseHeaders: Record<string, string> = {
    'Content-Type': meta.mimetype,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': INLINE.test(meta.mimetype) ? 'inline' : 'attachment',
    'Cache-Control': `public, ${meta.cacheControl}`,
    'Accept-Ranges': 'bytes',
    ETag: etag,
  }
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: baseHeaders })
  }

  const range = parseRange(request.headers.get('range'), meta.size)
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${meta.size}` } })
  }

  const driver = await getDriver()
  const object = await driver.get(bucket, path, range ?? undefined)
  if (!object) return notFound()

  const body = Readable.toWeb(object.stream) as ReadableStream
  if (range) {
    return new Response(body, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Length': String(object.size),
        'Content-Range': `bytes ${range.start}-${range.start + object.size - 1}/${object.totalSize}`,
      },
    })
  }
  return new Response(body, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(object.size) } })
}

export const HEAD = GET
