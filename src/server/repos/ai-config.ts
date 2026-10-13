// AI assistant configuration (one row per account in `ai_configs`).
//
// `api_key` / `embeddings_api_key` hold AES-256-GCM ciphertext. The
// `*Secrets` readers return it for server-side decryption only — never
// hand those rows to the browser. `getAiConfigSummary` is the
// browser-safe shape (has_* flags instead of ciphertext).
//
// RLS (migration 029): members read, admins write.

import { sql, type Db } from "@/server/db";
import type { AiProvider } from "@/lib/ai/types";

/** Full config row for *use* (draft / auto-reply), ciphertext included. */
export async function getAiConfigSecrets(db: Db, accountId: string) {
  const row = await db
    .selectFrom("ai_configs")
    .select([
      "provider",
      "model",
      "base_url",
      "api_key",
      "system_prompt",
      "is_active",
      "auto_reply_enabled",
      "auto_reply_max_per_conversation",
      "handoff_agent_id",
      "embeddings_api_key",
    ])
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return row ? { ...row, provider: row.provider as AiProvider } : undefined;
}

/** The stored chat credentials (ciphertext) — for "reuse the stored key" flows. */
export async function getAiConfigCredentials(db: Db, accountId: string) {
  const row = await db
    .selectFrom("ai_configs")
    .select(["id", "provider", "model", "base_url", "api_key"])
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return row ? { ...row, provider: row.provider as AiProvider } : undefined;
}

/** Just the embeddings key ciphertext (null when unset / no row). */
export async function getEmbeddingsKeyCipher(db: Db, accountId: string): Promise<string | null> {
  const row = await db
    .selectFrom("ai_configs")
    .select("embeddings_api_key")
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return row?.embeddings_api_key ?? null;
}

/**
 * Browser-safe view of the config: every setting plus `has_key` /
 * `has_embeddings_key` flags. The ciphertext never leaves Postgres.
 */
export function getAiConfigSummary(db: Db, accountId: string) {
  return db
    .selectFrom("ai_configs")
    .select([
      "provider",
      "model",
      "base_url",
      "system_prompt",
      "is_active",
      "auto_reply_enabled",
      "auto_reply_max_per_conversation",
      "handoff_agent_id",
      sql<boolean>`coalesce(api_key, '') <> ''`.as("has_key"),
      sql<boolean>`coalesce(embeddings_api_key, '') <> ''`.as("has_embeddings_key"),
    ])
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}

export interface AiConfigWrite {
  provider: AiProvider;
  model: string;
  base_url: string | null;
  system_prompt: string | null;
  is_active: boolean;
  auto_reply_enabled: boolean;
  auto_reply_max_per_conversation: number;
  handoff_agent_id?: string | null;
  embeddings_api_key?: string | null;
  api_key?: string;
}

export async function insertAiConfig(
  db: Db,
  values: AiConfigWrite & { account_id: string; created_by: string; api_key: string },
): Promise<void> {
  await db.insertInto("ai_configs").values(values).execute();
}

export async function updateAiConfig(db: Db, accountId: string, patch: AiConfigWrite): Promise<void> {
  await db.updateTable("ai_configs").set(patch).where("account_id", "=", accountId).execute();
}

export async function deleteAiConfig(db: Db, accountId: string): Promise<void> {
  await db.deleteFrom("ai_configs").where("account_id", "=", accountId).execute();
}

/** Is `userId` a member of `accountId`? (handoff-target validation) */
export async function isAccountMember(db: Db, accountId: string, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom("profiles")
    .select("user_id")
    .where("account_id", "=", accountId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return !!row;
}
