// ============================================================
// Data access entry point (server only).
//
// Every database operation runs inside `asUser` or `asService`, which
// open a transaction and bind the Postgres role + user for its
// duration — the same mechanism PostgREST used:
//
//   asUser(userId, (db) => ...)   role `authenticated`, auth.uid() =
//                                 userId → every RLS policy applies.
//                                 Repositories ALSO filter by account
//                                 explicitly; RLS is the backstop.
//   asService((db) => ...)        role `service_role` (BYPASSRLS) for
//                                 webhooks, engines, crons and API-key
//                                 routes — scope by account_id by hand.
//
// The underlying connection (`wacrm_app`) has no table privileges of
// its own, so a query that bypasses these helpers fails loudly.
//
// Keep transactions short: never await network calls (Meta, AI
// providers) inside one — do the I/O first, then write.
//
// Server-only by construction: it pulls in `pg`, so importing it from a
// client component fails the build (same boundary as lib/auth/account).
// ============================================================

import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";

import { getPool } from "@/server/db/pool";
import type { DB } from "./schema.gen";

export type { DB };
export type Db = Transaction<DB>;

export type DbRole = "anon" | "authenticated" | "service_role";

const g = globalThis as unknown as { __wacrmKysely?: Kysely<DB> };

function kysely(): Kysely<DB> {
  g.__wacrmKysely ??= new Kysely<DB>({ dialect: new PostgresDialect({ pool: () => Promise.resolve(getPool()) }) });
  return g.__wacrmKysely;
}

export interface RunOptions {
  /** statement_timeout in ms (default 30 s). */
  timeoutMs?: number;
}

export async function withRole<T>(
  role: DbRole,
  userId: string | null,
  fn: (db: Db) => Promise<T>,
  opts: RunOptions = {},
): Promise<T> {
  return kysely()
    .transaction()
    .execute(async (trx) => {
      await sql`SELECT set_config('role', ${role}, true),
                       set_config('request.jwt.claim.sub', ${userId ?? ""}, true),
                       set_config('statement_timeout', ${String(opts.timeoutMs ?? 30_000)}, true)`.execute(trx);
      return fn(trx);
    });
}

/** Run as the signed-in user (RLS enforced). */
export function asUser<T>(userId: string, fn: (db: Db) => Promise<T>, opts?: RunOptions): Promise<T> {
  return withRole("authenticated", userId, fn, opts);
}

/** Run as the service role (RLS bypassed — scope every query by account). */
export function asService<T>(fn: (db: Db) => Promise<T>, opts?: RunOptions): Promise<T> {
  return withRole("service_role", null, fn, { timeoutMs: 60_000, ...opts });
}

/** Run as an anonymous caller (only anon-granted functions/policies). */
export function asAnon<T>(fn: (db: Db) => Promise<T>, opts?: RunOptions): Promise<T> {
  return withRole("anon", null, fn, opts);
}

/**
 * "How to run DB work" — handed to services that interleave database
 * steps with side effects (Meta calls, automation dispatch) and so
 * can't live inside one caller-owned transaction. Each call is its own
 * short transaction under the caller's role.
 */
export type Runner = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;

export const userRunner = (userId: string): Runner => (fn) => asUser(userId, fn);
export const serviceRunner: Runner = (fn) => asService(fn);

export { sql };
