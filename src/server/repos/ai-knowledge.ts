// AI knowledge base: documents + their search chunks.
//
// RLS (migrations 030/032): members read, admins write. The match_*
// functions are SECURITY INVOKER (032) and filter by p_account_id, so
// they run under either role.

import { sql, type Db } from "@/server/db";

export function listKnowledgeDocuments(db: Db, accountId: string) {
  return db
    .selectFrom("ai_knowledge_documents")
    .select(["id", "title", "updated_at"])
    .where("account_id", "=", accountId)
    .orderBy("updated_at", "desc")
    .execute();
}

export function getKnowledgeDocument(db: Db, accountId: string, id: string) {
  return db
    .selectFrom("ai_knowledge_documents")
    .select(["id", "title", "content", "updated_at"])
    .where("account_id", "=", accountId)
    .where("id", "=", id)
    .executeTakeFirst();
}

/** Every document's id + content (reindex). */
export function listKnowledgeDocumentContents(db: Db, accountId: string) {
  return db
    .selectFrom("ai_knowledge_documents")
    .select(["id", "content"])
    .where("account_id", "=", accountId)
    .execute();
}

export function insertKnowledgeDocument(
  db: Db,
  values: { account_id: string; created_by: string; title: string; content: string },
) {
  return db.insertInto("ai_knowledge_documents").values(values).returning("id").executeTakeFirstOrThrow();
}

/** Returns `{ id }`, or undefined when no such document in the account. */
export function updateKnowledgeDocument(
  db: Db,
  accountId: string,
  id: string,
  patch: { title?: string; content?: string },
) {
  return db
    .updateTable("ai_knowledge_documents")
    .set(patch)
    .where("account_id", "=", accountId)
    .where("id", "=", id)
    .returning("id")
    .executeTakeFirst();
}

export async function deleteKnowledgeDocument(db: Db, accountId: string, id: string): Promise<void> {
  // Chunks cascade.
  await db.deleteFrom("ai_knowledge_documents").where("account_id", "=", accountId).where("id", "=", id).execute();
}

export interface KnowledgeChunkInput {
  chunk_index: number;
  content: string;
  /** pgvector text literal (`[0.1,0.2,...]`, see toVectorLiteral) or null. */
  embedding: string | null;
}

/**
 * Replace a document's chunks: delete the existing ones, insert `chunks`.
 * Call inside one transaction so a re-index is all-or-nothing.
 */
export async function replaceDocumentChunks(
  db: Db,
  accountId: string,
  documentId: string,
  chunks: KnowledgeChunkInput[],
): Promise<void> {
  await db
    .deleteFrom("ai_knowledge_chunks")
    .where("account_id", "=", accountId)
    .where("document_id", "=", documentId)
    .execute();
  if (chunks.length === 0) return;
  await db
    .insertInto("ai_knowledge_chunks")
    .values(chunks.map((c) => ({ ...c, account_id: accountId, document_id: documentId })))
    .execute();
}

export async function countKnowledgeChunks(db: Db, accountId: string): Promise<number> {
  const row = await db
    .selectFrom("ai_knowledge_chunks")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("account_id", "=", accountId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export interface KnowledgeMatch {
  id: string;
  content: string;
}

/** Lexical full-text matches, best first. */
export async function matchKnowledgeFts(
  db: Db,
  accountId: string,
  query: string,
  matchCount: number,
): Promise<KnowledgeMatch[]> {
  const r = await sql<KnowledgeMatch>`
    SELECT id, content
    FROM public.match_ai_knowledge_fts(${accountId}::uuid, ${query}::text, ${matchCount}::int)`.execute(db);
  return r.rows;
}

/** Cosine-nearest chunks to `queryEmbedding` (a pgvector text literal). */
export async function matchKnowledgeSemantic(
  db: Db,
  accountId: string,
  queryEmbedding: string,
  matchCount: number,
): Promise<KnowledgeMatch[]> {
  const r = await sql<KnowledgeMatch>`
    SELECT id, content
    FROM public.match_ai_knowledge_semantic(${accountId}::uuid, ${queryEmbedding}::text, ${matchCount}::int)`.execute(
    db,
  );
  return r.rows;
}
