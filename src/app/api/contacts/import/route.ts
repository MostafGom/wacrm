// POST /api/contacts/import { rows: [{ phone, name?, email?, company?, tagNames? }] }
// → ImportResult (see src/server/services/contacts-import.ts). Agent+;
// missing tags are only created for admin+ callers.

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { canEditSettings } from '@/lib/auth/roles'
import { getT } from '@/lib/i18n/translate'
import { userRunner } from '@/server/db'
import { readJsonBody } from '@/server/http'
import { importContacts, type ImportRow } from '@/server/services/contacts-import'

export const maxDuration = 300

const t = getT('Api.common')
const MAX_ROWS = 20_000

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : null)

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const body = await readJsonBody(request)
    if (!Array.isArray(body.rows) || body.rows.length > MAX_ROWS) throw new HttpError(400, t('invalidRequestBody'))

    const rows: ImportRow[] = []
    for (const r of body.rows as Array<Record<string, unknown>>) {
      if (!r || typeof r.phone !== 'string') throw new HttpError(400, t('invalidRequestBody'))
      rows.push({
        phone: r.phone.trim().slice(0, 64),
        name: str(r.name, 200),
        email: str(r.email, 320),
        company: str(r.company, 200),
        tagNames: Array.isArray(r.tagNames)
          ? (r.tagNames as unknown[]).filter((n): n is string => typeof n === 'string').map((n) => n.slice(0, 100)).slice(0, 50)
          : [],
      })
    }

    const result = await importContacts(userRunner(ctx.userId), {
      accountId: ctx.accountId,
      userId: ctx.userId,
      canCreateTags: canEditSettings(ctx.role),
      rows,
    })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
