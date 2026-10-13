// POST /api/broadcasts/[id]/results   (agent+)
//   { results: [{ id, status: 'sent', whatsapp_message_id? }
//             | { id, status: 'failed', error_message? }] }  (≤ 100)
//   → { updated }
//
// The wizard sends each batch through /api/whatsapp/broadcast (which
// only talks to Meta) and stamps the outcomes here. `whatsapp_message_id`
// is what lets the status webhook advance delivered/read later; the
// count columns follow through the recipient aggregate trigger.

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { isUuid, readJsonBody } from '@/server/http'
import { stampRecipient, type RecipientResult } from '@/server/repos/broadcasts'

const t = getT('Api.common')

const MAX_RESULTS = 100

function parseResults(raw: unknown): RecipientResult[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_RESULTS) return null
  const out: RecipientResult[] = []
  for (const item of raw as unknown[]) {
    const r = item as Record<string, unknown> | null
    if (!r || !isUuid(r.id)) return null
    if (r.status === 'sent') {
      const wamid = r.whatsapp_message_id
      if (wamid !== undefined && wamid !== null && (typeof wamid !== 'string' || wamid.length > 256)) return null
      out.push({ id: r.id, status: 'sent', whatsapp_message_id: (wamid as string | null | undefined) ?? null })
    } else if (r.status === 'failed') {
      const message = typeof r.error_message === 'string' ? r.error_message.slice(0, 2000) : t('unknownError')
      out.push({ id: r.id, status: 'failed', error_message: message })
    } else {
      return null
    }
  }
  return out
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    if (!isUuid(id)) throw new HttpError(404, t('notFound'))
    const body = await readJsonBody(request)
    const results = parseResults(body.results)
    if (!results) throw new HttpError(400, t('invalidRequestBody'))

    const updated = await asUser(ctx.userId, async (db) => {
      let n = 0
      for (const result of results) {
        if (await stampRecipient(db, ctx.accountId, id, result)) n++
      }
      return n
    })
    return NextResponse.json({ updated })
  } catch (err) {
    return toErrorResponse(err)
  }
}
