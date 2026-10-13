// Public API keys.
//
// Management (list / create / revoke) runs as the dashboard caller
// (asUser; RLS: any member reads, admin writes). The auth-path lookups
// (findApiKeyByHash, getAccountNameById, touchApiKeyLastUsed) run under
// asService: an API caller has no session, and the key hash is the
// credential that establishes the account.

import type { Db } from "@/server/db";

/** Columns safe to expose. `key_hash` never leaves the server. */
export const API_KEY_SAFE_COLUMNS = [
  "id",
  "name",
  "key_prefix",
  "scopes",
  "last_used_at",
  "expires_at",
  "revoked_at",
  "created_at",
] as const;

export function listApiKeys(db: Db, accountId: string) {
  return db
    .selectFrom("api_keys")
    .select(API_KEY_SAFE_COLUMNS)
    .where("account_id", "=", accountId)
    .orderBy("created_at", "desc")
    .execute();
}

export function createApiKey(
  db: Db,
  values: {
    account_id: string;
    created_by: string;
    name: string;
    key_prefix: string;
    key_hash: string;
    scopes: string[];
    expires_at: string | null;
  },
) {
  return db.insertInto("api_keys").values(values).returning(API_KEY_SAFE_COLUMNS).executeTakeFirstOrThrow();
}

/** Soft-revoke a live key. False when no unrevoked key with that id exists in the account. */
export async function revokeApiKey(db: Db, accountId: string, id: string): Promise<boolean> {
  const row = await db
    .updateTable("api_keys")
    .set({ revoked_at: new Date().toISOString() })
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .where("revoked_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  return !!row;
}

/**
 * Auth path (asService): the key row for a SHA-256 hash, live or not.
 * Not account-scoped by design: the hash is what identifies the account.
 */
export function findApiKeyByHash(db: Db, hash: string) {
  return db
    .selectFrom("api_keys")
    .select(["id", "account_id", "created_by", "name", "scopes", "expires_at", "revoked_at"])
    .where("key_hash", "=", hash)
    .executeTakeFirst();
}

export async function getAccountNameById(db: Db, accountId: string): Promise<string | null> {
  const row = await db.selectFrom("accounts").select("name").where("id", "=", accountId).executeTakeFirst();
  return row?.name ?? null;
}

export async function touchApiKeyLastUsed(db: Db, accountId: string, id: string): Promise<void> {
  await db
    .updateTable("api_keys")
    .set({ last_used_at: new Date().toISOString() })
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .execute();
}
