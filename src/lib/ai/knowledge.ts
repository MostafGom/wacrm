import type { Runner } from '@/server/db'
import {
  countKnowledgeChunks,
  matchKnowledgeFts,
  matchKnowledgeSemantic,
  replaceDocumentChunks,
} from '@/server/repos/ai-knowledge'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search).
//
// Both take a `Runner` rather than a `Db`: the embeddings call is
// network I/O and must happen outside any transaction.
// ============================================================

/**
 * (Re)build the chunks for one document. Re-chunks the content and —
 * when the account has an embeddings key — embeds each chunk, then
 * replaces the document's existing chunks in one transaction. Runs
 * under whatever runner the caller passes (the admin's user role for
 * the ingest routes).
 *
 * Throws on embedding failure so the ingest route can report it; the
 * embedding (if attempted) happens before anything is written, so a
 * failed embed never leaves half-indexed rows.
 */
export async function ingestDocument(
  run: Runner,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  documentId: string,
  content: string,
): Promise<void> {
  const chunks = chunkText(content)

  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically. We record the error and rethrow it
  // AFTER inserting (embedding-less) rows, so the route can warn
  // "semantic indexing failed" — which is now truthful, because lexical
  // search really does still work.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddingsApiKey && chunks.length > 0) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks)
    } catch (err) {
      embedError = err
    }
  }

  const rows = chunks.map((chunk, i) => ({
    chunk_index: i,
    content: chunk,
    embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
  }))

  // Replace, don't append — re-ingest must be idempotent.
  await run((db) => replaceDocumentChunks(db, accountId, documentId, rows))

  if (embedError) throw embedError
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`.
 *
 * Semantic-primary when an embeddings key is configured (embed the
 * query → cosine-nearest chunks), then topped up with lexical full-text
 * matches to fill `k`. Lexical-only when there's no key. Best-effort:
 * any failure (no KB, embedding error, query error) degrades to fewer
 * or zero results and never throws into the draft / auto-reply path.
 */
export async function retrieveKnowledge(
  run: Runner,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5,
): Promise<string[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []

  // Skip everything when the account has no knowledge base — otherwise
  // every draft / auto-reply would pay for a query embedding + two
  // searches just to get []. One cheap indexed COUNT instead of a paid
  // embeddings call on the hot path.
  try {
    const count = await run((db) => countKnowledgeChunks(db, accountId))
    if (!count) return []
  } catch {
    return []
  }

  const picked = new Map<string, string>() // id → content, preserves order

  // Semantic path.
  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [query])
      if (queryEmbedding) {
        const rows = await run((db) =>
          matchKnowledgeSemantic(db, accountId, toVectorLiteral(queryEmbedding), k),
        )
        for (const row of rows) picked.set(row.id, row.content)
      }
    } catch (err) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', err)
    }
  }

  // Lexical top-up (also the sole path when there's no embeddings key).
  if (picked.size < k) {
    try {
      const rows = await run((db) => matchKnowledgeFts(db, accountId, query, k))
      for (const row of rows) {
        if (picked.size >= k) break
        if (!picked.has(row.id)) picked.set(row.id, row.content)
      }
    } catch (err) {
      console.error('[ai knowledge] lexical retrieval failed:', err)
    }
  }

  return Array.from(picked.values()).slice(0, k)
}
