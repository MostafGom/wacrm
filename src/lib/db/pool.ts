// ============================================================
// Shared pg.Pool — one per server process.
//
// Pinned on globalThis so Next.js dev-mode HMR doesn't leak a new
// pool (and its connections) on every edit.
//
// DATABASE_URL must point at the unprivileged `wacrm_app` login role
// (created by db/migrations/000). Queries switch to anon /
// authenticated / service_role per transaction in tx.ts.
// ============================================================

import pg from "pg";

const globalForPool = globalThis as unknown as { __wacrmPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!globalForPool.__wacrmPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    globalForPool.__wacrmPool = new pg.Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      // Timestamps serialise as `+00:00`, exactly like Supabase.
      options: "-c timezone=UTC",
      application_name: "wacrm",
    });
    globalForPool.__wacrmPool.on("error", (err) => {
      // An idle client errored (e.g. DB restart). The pool discards it;
      // just make it visible instead of crashing the process.
      console.error("[db] idle client error:", err.message);
    });
  }
  return globalForPool.__wacrmPool;
}

/** Test helper — close and forget the pool. */
export async function closePool(): Promise<void> {
  const pool = globalForPool.__wacrmPool;
  globalForPool.__wacrmPool = undefined;
  if (pool) await pool.end();
}
