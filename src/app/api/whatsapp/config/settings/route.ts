// GET   /api/whatsapp/config/settings — the account's saved WhatsApp
//       config for the settings form (any member). The encrypted
//       tokens never leave the server: `has_verify_token` says whether
//       a verify token is stored. → { config: WhatsAppConfigView | null }
// PATCH /api/whatsapp/config/settings { mirror_inbound_media: boolean }
//       — toggle the inbound-media mirror (admin+, like the
//       whatsapp_config_update RLS policy). → { ok: true }
//
// Saving credentials goes through POST /api/whatsapp/config, which
// verifies them with Meta and encrypts them.

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody } from '@/server/http'
import { getWhatsAppConfigForClient, setMirrorInboundMedia } from '@/server/repos/whatsapp-config'

const t = getT('Api.common')

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const config = await asUser(ctx.userId, (db) => getWhatsAppConfigForClient(db, ctx.accountId))
    return NextResponse.json({ config: config ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = await readJsonBody(request)
    if (typeof body.mirror_inbound_media !== 'boolean') {
      throw new HttpError(400, t('invalidRequestBody'))
    }
    const value = body.mirror_inbound_media
    const updated = await asUser(ctx.userId, (db) => setMirrorInboundMedia(db, ctx.accountId, value))
    if (!updated) throw new HttpError(404, t('notFound'))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
