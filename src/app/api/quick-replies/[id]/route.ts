import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { deleteQuickReply, updateQuickReply, type QuickReplyUpdate } from '@/server/repos/quick-replies'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

// Update / delete a single quick reply. Quick replies are account-
// shared, so every mutation is scoped by `account_id`; agent+ is
// enforced here and by the quick_replies RLS policies.

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: t('common.invalidJson') }, { status: 400 })

  const update: QuickReplyUpdate = {}
  if (typeof body.title === 'string') {
    const title = body.title.trim()
    if (!title) return NextResponse.json({ error: t('common.titleEmpty') }, { status: 400 })
    update.title = title
  }

  // When `kind` is supplied (e.g. the editor flips Text ↔ Interactive), it
  // drives which content column is authoritative and the other is cleared —
  // otherwise a switched row keeps a stale payload the picker mis-routes on.
  if ('kind' in body) {
    if (body.kind !== 'text' && body.kind !== 'interactive') {
      return NextResponse.json({ error: t('quickReplies.kindInvalid') }, { status: 400 })
    }
    update.kind = body.kind
    if (body.kind === 'interactive') {
      const result = validateInteractivePayload(body.interactive_payload)
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
      update.interactive_payload = body.interactive_payload
      update.content_text = null
    } else {
      const text = typeof body.content_text === 'string' ? body.content_text : ''
      if (!text.trim()) {
        return NextResponse.json(
          { error: t('quickReplies.contentTextRequired') },
          { status: 400 },
        )
      }
      update.content_text = text
      update.interactive_payload = null
    }
  } else {
    // No kind change — allow partial edits of whichever field the row uses.
    if ('content_text' in body) update.content_text = body.content_text ?? null
    if ('interactive_payload' in body) {
      if (body.interactive_payload != null) {
        const result = validateInteractivePayload(body.interactive_payload)
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 400 })
        }
      }
      update.interactive_payload = body.interactive_payload ?? null
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true })
  }

  try {
    await asUser(ctx.userId, (db) => updateQuickReply(db, ctx.accountId, id, update))
  } catch (err) {
    return toErrorResponse(err)
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  try {
    await asUser(ctx.userId, (db) => deleteQuickReply(db, ctx.accountId, id))
  } catch (err) {
    return toErrorResponse(err)
  }
  return NextResponse.json({ ok: true })
}
