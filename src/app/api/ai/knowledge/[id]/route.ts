import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'
import { getT } from '@/lib/i18n/translate'
import { asUser, userRunner } from '@/server/db'
import {
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  updateKnowledgeDocument,
} from '@/server/repos/ai-knowledge'

const t = getT('Api')

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/ai/knowledge/[id] — full document (any member).
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { userId, accountId } = await getCurrentAccount()
    const { id } = await params
    let data: Awaited<ReturnType<typeof getKnowledgeDocument>>
    try {
      data = await asUser(userId, (db) => getKnowledgeDocument(db, accountId, id))
    } catch (error) {
      console.error('[ai/knowledge/[id] GET] error:', error)
      return NextResponse.json({ error: t('ai.knowledge.loadDocFailed') }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: t('common.notFound') }, { status: 404 })
    return NextResponse.json(data)
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/ai/knowledge/[id]  (admin+) — update title/content and
 * re-index when the content changed.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const run = userRunner(userId)
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined
    const content = typeof body?.content === 'string' ? body.content.trim() : undefined
    if (title === undefined && content === undefined) {
      return NextResponse.json({ error: t('ai.knowledge.nothingToUpdate') }, { status: 400 })
    }
    if (title !== undefined && !title) {
      return NextResponse.json({ error: t('common.titleEmpty') }, { status: 400 })
    }
    if (content !== undefined && !content) {
      return NextResponse.json({ error: t('ai.knowledge.contentEmpty') }, { status: 400 })
    }

    const update: { title?: string; content?: string } = {}
    if (title !== undefined) update.title = title
    if (content !== undefined) update.content = content

    let updated: { id: string } | undefined
    try {
      updated = await run((db) =>
        updateKnowledgeDocument(db, accountId, id, update),
      )
    } catch (error) {
      console.error('[ai/knowledge/[id] PATCH] error:', error)
      return NextResponse.json({ error: t('ai.knowledge.updateDocFailed') }, { status: 500 })
    }
    if (!updated) return NextResponse.json({ error: t('common.notFound') }, { status: 404 })

    if (content !== undefined) {
      const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
        run,
        accountId,
      )
      try {
        await ingestDocument(run, accountId, { embeddingsApiKey }, id, content)
      } catch (err) {
        const message = err instanceof AiError ? err.message : t('ai.knowledge.indexingFailed')
        console.error('[ai/knowledge/[id] PATCH] ingest error:', err)
        return NextResponse.json(
          {
            success: true,
            warning: t('ai.knowledge.updatedIndexFailed', { message }),
          },
          { status: 200 },
        )
      }
      if (corrupt) {
        return NextResponse.json({
          success: true,
          warning:
            t('ai.knowledge.updatedKeywordOnly'),
        })
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/knowledge/[id]  (admin+) — chunks cascade.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { userId, accountId } = await requireRole('admin')
    const { id } = await params
    try {
      await asUser(userId, (db) => deleteKnowledgeDocument(db, accountId, id))
    } catch (error) {
      console.error('[ai/knowledge/[id] DELETE] error:', error)
      return NextResponse.json({ error: t('ai.knowledge.deleteDocFailed') }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
