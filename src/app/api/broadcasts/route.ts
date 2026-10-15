// /api/broadcasts
//   GET  → { broadcasts: Broadcast[] }                        newest first (any member)
//   POST { name, template_name, template_language?, template_variables?, audience, draft?,
//          header_media_url? }   (http(s) media for an image/video/document header)
//        draft: true → { broadcast }                         (agent+)  row only, no recipients
//        otherwise   → { broadcast, recipients: [{ id, phone, template_params }] }   (agent+)
//          Resolves the audience (CSV numbers the account lacks become
//          contacts), freezes each recipient's template params and
//          inserts the broadcast ('sending') + its pending recipients in
//          ONE transaction. The browser then drives the Meta fan-out via
//          /api/whatsapp/broadcast and stamps outcomes through
//          /api/broadcasts/{id}/results. 400 { code: 'no_contacts' } when
//          the audience resolves to nobody.

import { NextResponse } from 'next/server'

import { HttpError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { parseAudienceConfig } from '@/lib/broadcast-audience'
import { parseVariableMappings, resolveVariables } from '@/lib/broadcast-variables'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { readJsonBody, requiredString } from '@/server/http'
import { customValueIndex, resolveAudienceContacts } from '@/server/repos/broadcast-audience'
import { insertBroadcast, insertPendingRecipients, listBroadcasts } from '@/server/repos/broadcasts'

const tCommon = getT('Api.common')
const tSending = getT('Broadcasts.sending')

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const broadcasts = await asUser(ctx.userId, (db) => listBroadcasts(db, ctx.accountId))
    return NextResponse.json({ broadcasts })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** Optional http(s) URL of the header media; null when absent or blank. */
function parseHeaderMediaUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new HttpError(400, tCommon('invalidRequestBody'))
  const trimmed = value.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new HttpError(400, tCommon('invalidRequestBody'))
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || trimmed.length > 2048) {
    throw new HttpError(400, tCommon('invalidRequestBody'))
  }
  return trimmed
}

export async function POST(request: Request) {
  try {
    // Running (or drafting) a broadcast is a write; viewers are read-only
    // (broadcasts_insert RLS policy, migration 017).
    const ctx = await requireRole('agent')
    const body = await readJsonBody(request)

    const name = typeof body.name === 'string' ? body.name.slice(0, 200) : ''
    const templateName = requiredString(body.template_name, undefined, 512)
    const templateLanguage =
      typeof body.template_language === 'string' && body.template_language.trim()
        ? body.template_language.trim().slice(0, 20)
        : 'en_US'
    const variables = parseVariableMappings(body.template_variables)
    const audience = parseAudienceConfig(body.audience)
    if (!variables || !audience) throw new HttpError(400, tCommon('invalidRequestBody'))
    const headerMediaUrl = parseHeaderMediaUrl(body.header_media_url)

    if (body.draft === true) {
      if (!name.trim()) throw new HttpError(400, tCommon('invalidRequestBody'))
      const broadcast = await asUser(ctx.userId, (db) =>
        insertBroadcast(db, {
          account_id: ctx.accountId,
          user_id: ctx.userId,
          name: name.trim(),
          template_name: templateName,
          template_language: templateLanguage,
          template_variables: variables,
          audience_filter: { type: audience.type, tagIds: audience.tagIds },
          status: 'draft',
          total_recipients: 0,
          header_media_url: headerMediaUrl,
        }),
      )
      return NextResponse.json({ broadcast }, { status: 201 })
    }

    const result = await asUser(
      ctx.userId,
      async (db) => {
        const contacts = await resolveAudienceContacts(db, ctx.accountId, ctx.userId, audience)
        if (contacts.length === 0) {
          throw new HttpError(400, tSending('noContactsForAudience'), 'no_contacts')
        }

        // Params are resolved and frozen on each recipient row here. They
        // are what makes the campaign resumable server-side (issue #472):
        // the send loop runs in the browser tab, and if the tab goes away
        // the only record of what {{1}} should be is this column.
        const index = await customValueIndex(
          db,
          ctx.accountId,
          contacts.map((c) => c.id),
        )
        const broadcast = await insertBroadcast(db, {
          account_id: ctx.accountId,
          user_id: ctx.userId,
          name,
          template_name: templateName,
          template_language: templateLanguage,
          template_variables: variables,
          audience_filter: {
            type: audience.type,
            tagIds: audience.tagIds,
            customField: audience.customField,
            excludeTagIds: audience.excludeTagIds,
          },
          status: 'sending',
          total_recipients: contacts.length,
          header_media_url: headerMediaUrl,
        })
        const rows = await insertPendingRecipients(
          db,
          broadcast.id,
          contacts.map((c) => ({
            contactId: c.id,
            params: resolveVariables(variables, c, index.get(c.id)),
          })),
        )
        const phoneById = new Map(contacts.map((c) => [c.id, c.phone]))
        return {
          broadcast,
          recipients: rows.map((r) => ({
            id: r.id,
            phone: (r.contact_id && phoneById.get(r.contact_id)) || null,
            template_params: Array.isArray(r.template_params) ? r.template_params : [],
          })),
        }
      },
      // Large audiences: resolution + thousands of recipient rows.
      { timeoutMs: 120_000 },
    )
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
