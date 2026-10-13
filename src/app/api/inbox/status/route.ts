// GET /api/inbox/status → { whatsapp_connected: boolean }   (any member)
//
// Drives the inbox's "WhatsApp not connected" banner. Reads only the
// account's whatsapp_config.status — never the token. (The settings
// page's GET /api/whatsapp/config also probes Meta; this doesn't.)

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { getWhatsAppStatus } from '@/server/repos/messages'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const status = await asUser(ctx.userId, (db) => getWhatsAppStatus(db, ctx.accountId))
    return NextResponse.json({ whatsapp_connected: status === 'connected' })
  } catch (err) {
    return toErrorResponse(err)
  }
}
