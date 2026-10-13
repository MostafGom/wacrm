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
  insertKnowledgeDocument,
  listKnowledgeDocuments,
} from '@/server/repos/ai-knowledge'

const t = getT('Api')

/**
 * GET /api/ai/knowledge
 *
 * List the account's knowledge-base documents (any member).
 */
export async function GET() {
  try {
    const { userId, accountId } = await getCurrentAccount()
    let documents: Awaited<ReturnType<typeof listKnowledgeDocuments>>
    try {
      documents = await asUser(userId, (db) =>
        listKnowledgeDocuments(db, accountId),
      )
    } catch (error) {
      console.error('[ai/knowledge GET] error:', error)
      return NextResponse.json(
        { error: t('ai.knowledge.loadKbFailed') },
        { status: 500 },
      )
    }
    return NextResponse.json({ documents })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/knowledge  (admin+)
 *
 * Create a document, then chunk + (optionally) embed it. If indexing
 * fails the document is still saved so the admin can retry via reindex.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const run = userRunner(userId)
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!title || !content) {
      return NextResponse.json(
        { error: t('ai.knowledge.titleContentRequired') },
        { status: 400 },
      )
    }

    let doc: { id: string }
    try {
      doc = await run((db) =>
        insertKnowledgeDocument(db, {
          account_id: accountId,
          created_by: userId,
          title,
          content,
        }),
      )
    } catch (error) {
      console.error('[ai/knowledge POST] insert error:', error)
      return NextResponse.json(
        { error: t('ai.knowledge.saveDocFailed') },
        { status: 500 },
      )
    }

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      run,
      accountId,
    )
    try {
      await ingestDocument(
        run,
        accountId,
        { embeddingsApiKey },
        doc.id,
        content,
      )
    } catch (err) {
      const message = err instanceof AiError ? err.message : t('ai.knowledge.indexingFailed')
      console.error('[ai/knowledge POST] ingest error:', err)
      return NextResponse.json(
        {
          success: true,
          id: doc.id,
          warning: t('ai.knowledge.savedIndexFailed', { message }),
        },
        { status: 200 },
      )
    }

    if (corrupt) {
      return NextResponse.json({
        success: true,
        id: doc.id,
        warning:
          t('ai.knowledge.savedKeywordOnly'),
      })
    }
    return NextResponse.json({ success: true, id: doc.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
