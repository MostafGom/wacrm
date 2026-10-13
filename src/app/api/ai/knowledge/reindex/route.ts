import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'
import { getT } from '@/lib/i18n/translate'
import { userRunner } from '@/server/db'
import { listKnowledgeDocumentContents } from '@/server/repos/ai-knowledge'

const t = getT('Api')

/**
 * POST /api/ai/knowledge/reindex  (admin+)
 *
 * Re-chunk and re-embed every document in the account. The main use is
 * after adding an embeddings key: existing documents were stored
 * lexical-only, and this backfills their vectors so semantic search
 * turns on. Also recovers documents whose indexing failed earlier.
 */
export async function POST() {
  try {
    const { accountId, userId } = await requireRole('admin')
    const run = userRunner(userId)
    const limit = checkRateLimit(`ai-kb-reindex:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    let docs: { id: string; content: string }[]
    try {
      docs = await run((db) => listKnowledgeDocumentContents(db, accountId))
    } catch (error) {
      console.error('[ai/knowledge/reindex] fetch error:', error)
      return NextResponse.json(
        { error: t('ai.knowledge.loadDocsFailed') },
        { status: 500 },
      )
    }

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      run,
      accountId,
    )
    // The whole point of Reindex is usually to backfill embeddings — so
    // if a key is configured but can't be decrypted, don't quietly do a
    // lexical-only pass and report success. Stop and tell the admin.
    if (corrupt) {
      return NextResponse.json(
        {
          success: false,
          reindexed: 0,
          error:
            t('ai.knowledge.reindexKeyCorrupt'),
        },
        { status: 200 },
      )
    }

    let reindexed = 0
    for (const doc of docs) {
      try {
        await ingestDocument(run, accountId, { embeddingsApiKey }, doc.id, doc.content)
        reindexed += 1
      } catch (err) {
        // One bad document (e.g. a mid-run embeddings rate-limit) should
        // not abort the whole batch.
        const message = err instanceof AiError ? err.message : String(err)
        console.error(`[ai/knowledge/reindex] doc ${doc.id} failed:`, message)
        return NextResponse.json(
          {
            success: false,
            reindexed,
            total: docs.length,
            error: t('ai.knowledge.reindexPartial', { reindexed, message }),
          },
          { status: 200 },
        )
      }
    }

    return NextResponse.json({ success: true, reindexed })
  } catch (err) {
    return toErrorResponse(err)
  }
}
