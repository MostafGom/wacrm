import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { asUser } from '@/server/db'
import { createQuickReply, listQuickReplies } from '@/server/repos/quick-replies'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

// Quick replies — reusable snippets (plain text or a saved interactive
// message) shared across the account. GET lists (any member); POST
// creates (agent+, same as the quick_replies_insert RLS policy).

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const quickReplies = await asUser(ctx.userId, (db) => listQuickReplies(db, ctx.accountId))
    return NextResponse.json({ quick_replies: quickReplies })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: t('common.invalidJson') }, { status: 400 })

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const kind = body.kind === 'interactive' ? 'interactive' : 'text'
  if (!title) {
    return NextResponse.json({ error: t('quickReplies.titleRequired') }, { status: 400 })
  }

  let content_text: string | null = null
  let interactive_payload: unknown = null

  if (kind === 'interactive') {
    const result = validateInteractivePayload(body.interactive_payload)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }
    interactive_payload = body.interactive_payload
  } else {
    const text = typeof body.content_text === 'string' ? body.content_text : ''
    if (!text.trim()) {
      return NextResponse.json(
        { error: t('quickReplies.contentTextRequired') },
        { status: 400 },
      )
    }
    content_text = text
  }

  try {
    const quickReply = await asUser(ctx.userId, (db) =>
      createQuickReply(db, {
        account_id: ctx.accountId,
        user_id: ctx.userId,
        title,
        kind,
        content_text,
        interactive_payload,
      }),
    )
    return NextResponse.json({ quick_reply: quickReply }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
