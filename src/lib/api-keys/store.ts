// ============================================================
// API key store — the *auth-path* data access for public API keys.
//
// Only the read side lives here, and deliberately so: it runs under
// asService because a public-API caller has no session, so RLS (which
// keys off `auth.uid()`) can't scope the lookup. The management side
// (list / create / revoke) runs in the dashboard as the signed-in
// caller (asUser) in the route handlers — same pattern as
// `/api/account/invitations`. Keeping the RLS-bypassing surface tiny
// and read-only here makes it easy to audit.
// ============================================================

import { asService } from '@/server/db';
import { findApiKeyByHash, getAccountNameById, touchApiKeyLastUsed } from '@/server/repos/api-keys';

/** Shape of an `api_keys` row as the auth path consumes it. */
export interface ApiKeyRow {
  id: string;
  account_id: string;
  created_by: string | null;
  name: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * Look up an *active* key by its SHA-256 hash. Returns null if no
 * row matches, or if the matching row is revoked or expired — so
 * callers never have to re-check liveness. Runs as the service role
 * (RLS-bypassing); the hash is the only credential, so this is the
 * moment that establishes the caller's account.
 */
export async function findActiveKeyByHash(
  hash: string
): Promise<ApiKeyRow | null> {
  let data: ApiKeyRow | undefined;
  try {
    data = await asService((db) => findApiKeyByHash(db, hash));
  } catch (error) {
    console.error('[api-keys/store] lookup error:', error instanceof Error ? error.message : error);
    return null;
  }
  if (!data) return null;

  // Liveness checks in JS rather than SQL so the failure modes are
  // explicit and the index stays a simple equality lookup.
  if (data.revoked_at) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return data;
}

/**
 * Fetch the account name for a resolved key, so `/api/v1/me` and any
 * future endpoint can echo it without a second round trip in the
 * route. Service role; the key already proved account membership.
 */
export async function getAccountName(
  accountId: string
): Promise<string | null> {
  try {
    return await asService((db) => getAccountNameById(db, accountId));
  } catch {
    return null;
  }
}

/**
 * Best-effort `last_used_at` bump. Fire-and-forget from the auth
 * path — a failed update just means the "last used" column lags;
 * it must never fail the request the caller is actually making.
 */
export function touchLastUsed(id: string, accountId: string): void {
  void asService((db) => touchApiKeyLastUsed(db, accountId, id)).catch((error: unknown) => {
    console.warn(
      '[api-keys/store] last_used_at bump failed:',
      error instanceof Error ? error.message : error
    );
  });
}
