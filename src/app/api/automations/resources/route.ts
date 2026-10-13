// GET /api/automations/resources — everything the automation builder's
// pickers need, for the caller's account (any member):
//   { tags, custom_fields, templates (APPROVED only), pipelines, stages }

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { getBuilderResources } from '@/server/repos/automations'
import { listCustomFields } from '@/server/repos/custom-fields'
import { listTags } from '@/server/repos/tags'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const result = await asUser(ctx.userId, async (db) => {
      const [tags, customFields, rest] = await Promise.all([
        listTags(db, ctx.accountId),
        listCustomFields(db, ctx.accountId),
        getBuilderResources(db, ctx.accountId),
      ])
      return { tags, custom_fields: customFields, ...rest }
    })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
