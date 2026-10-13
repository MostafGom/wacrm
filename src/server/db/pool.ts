// ============================================================
// Shared pg.Pool — one per server process.
//
// Pinned on globalThis so Next.js dev-mode HMR doesn't leak a new
// pool (and its connections) on every edit.
//
// DATABASE_URL must point at the unprivileged `wacrm_app` login role
// (created by db/migrations/000). Queries switch to anon /
// authenticated / service_role per transaction (src/server/db).
//
// Type parsing matches what the app has always received over the
// wire (PostgREST JSON): timestamps as ISO strings with a `+00:00`
// offset, `date` as `YYYY-MM-DD`, numeric / bigint as numbers.
// ============================================================

import pg from "pg";

const { types } = pg;

/** `2024-01-02 03:04:05.12+00` → `2024-01-02T03:04:05.12+00:00` */
export function isoTimestamp(value: string): string {
  const t = value.replace(" ", "T");
  return /[+-]\d\d$/.test(t) ? `${t}:00` : t;
}

const PARSERS: Record<number, (value: string) => unknown> = {
  [types.builtins.TIMESTAMPTZ]: isoTimestamp,
  [types.builtins.TIMESTAMP]: (v) => v.replace(" ", "T"),
  [types.builtins.DATE]: (v) => v,
  [types.builtins.NUMERIC]: (v) => Number(v),
  [types.builtins.INT8]: (v) => Number(v),
};

const customTypes = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    const parser = PARSERS[oid];
    if (parser && format !== "binary") return parser;
    return types.getTypeParser(oid, format);
  },
};

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
      options: "-c timezone=UTC",
      application_name: "wacrm",
      types: customTypes as pg.CustomTypesConfig,
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
