// POST /api/broadcasts/audience-count  { audience } → { count: number | null }   (any member)
//
// The wizard's reach estimate. POST because a CSV audience can be large;
// `count` is null while the audience is only partially configured.

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { localAudienceCount, parseAudienceConfig } from '@/lib/broadcast-audience'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody } from '@/server/http'
import { countAudience } from '@/server/repos/broadcast-audience'

const t = getT('Api.common')

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const body = await readJsonBody(request)
    const audience = parseAudienceConfig(body.audience)
    if (!audience) throw new HttpError(400, t('invalidRequestBody'))
    const local = localAudienceCount(audience)
    const count =
      local !== undefined
        ? local
        : await asUser(ctx.userId, (db) => countAudience(db, ctx.accountId, audience))
    return NextResponse.json({ count })
  } catch (err) {
    return toErrorResponse(err)
  }
}
