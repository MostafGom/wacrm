// ============================================================
// Role-scoped transactions.
//
// Every query the app runs goes through `withRole`, which binds the
// Postgres role and the caller's user id for the duration of ONE
// transaction — the same mechanism PostgREST uses:
//
//   BEGIN;
//   SELECT set_config('role', 'authenticated', true),
//          set_config('request.jwt.claim.sub', '<uuid>', true);
//   ...
//   COMMIT;
//
// `true` = transaction-local, so the settings vanish on COMMIT and a
// pooled connection can never leak one user's identity to the next.
// RLS policies read the user via auth.uid() (db/migrations/000).
// ============================================================

import type { PoolClient } from "pg";

import type { DbError } from "./ast";
import { getPool } from "@/server/db/pool";

export type DbRole = "anon" | "authenticated" | "service_role";

const ROLES: ReadonlySet<string> = new Set(["anon", "authenticated", "service_role"]);

export interface RoleOptions {
  /** statement_timeout in ms. */
  timeoutMs?: number;
}

export async function withRole<T>(
  role: DbRole,
  userId: string | null,
  fn: (client: PoolClient) => Promise<T>,
  opts: RoleOptions = {},
): Promise<T> {
  if (!ROLES.has(role)) throw new Error(`invalid db role ${role}`);
  const client = await getPool().connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('role', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('statement_timeout', $3, true)",
      [role, userId ?? "", String(opts.timeoutMs ?? 30_000)],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

interface PgErrorLike {
  message?: string;
  code?: string;
  detail?: string;
  hint?: string;
}

/** Shape a node-pg error like a PostgrestError. */
export function mapPgError(err: unknown): DbError {
  const e = (err ?? {}) as PgErrorLike;
  return {
    message: e.message ?? String(err),
    code: e.code ?? "",
    details: e.detail ?? null,
    hint: e.hint ?? null,
  };
}

/** HTTP-ish status PostgREST would have used for a Postgres error. */
export function statusForPgCode(code: string, role: DbRole): number {
  if (code === "42501") return role === "anon" ? 401 : 403;
  if (code === "23505" || code === "23503") return 409;
  if (code === "42P01" || code === "42883") return 404;
  if (code.startsWith("23") || code.startsWith("22")) return 400;
  return 400;
}
