// ============================================================
// Execute a query/RPC AST under a role and shape the result like
// supabase-js: `{ data, error, count, status, statusText }`. Never
// throws for database errors — callers check `error`, as before.
// ============================================================

import { DbRequestError, type DbAst, type DbResult, type QueryAst, type RpcAst } from "./ast";
import { getCatalog } from "./catalog";
import { compileQuery, compileRpc } from "./compile";
import { getPool } from "@/server/db/pool";
import { mapPgError, statusForPgCode, withRole, type DbRole } from "./tx";

export interface ExecOptions {
  role: DbRole;
  userId: string | null;
  timeoutMs?: number;
}

const MAX_ROWS = () => Number(process.env.DB_MAX_ROWS ?? 1000);

function ok(data: unknown, count: number | null, status = 200): DbResult {
  return { data, error: null, count, status, statusText: status === 201 ? "Created" : "OK" };
}

function fail(
  error: { message: string; code: string; details?: string | null; hint?: string | null },
  status: number,
): DbResult {
  return {
    data: null,
    error: {
      message: error.message,
      code: error.code,
      details: error.details ?? null,
      hint: error.hint ?? null,
    },
    count: null,
    status,
    statusText: "Error",
  };
}

function applySingle(rows: unknown, mode: "single" | "maybe" | undefined, count: number | null): DbResult {
  if (!mode) return ok(rows, count);
  const arr = Array.isArray(rows) ? rows : rows == null ? [] : [rows];
  if (arr.length === 1) return ok(arr[0], count);
  if (arr.length === 0 && mode === "maybe") return ok(null, count);
  return fail(
    {
      message: "JSON object requested, multiple (or no) rows returned",
      code: "PGRST116",
      details: `The result contains ${arr.length} rows`,
    },
    406,
  );
}

async function runQuery(ast: QueryAst, opts: ExecOptions): Promise<DbResult> {
  const catalog = await getCatalog(getPool());
  const compiled = compileQuery(catalog, ast, { maxRows: MAX_ROWS() });

  return withRole(
    opts.role,
    opts.userId,
    async (client) => {
      let count: number | null = null;
      if (compiled.count) {
        const r = await client.query(compiled.count.text, compiled.count.values);
        count = Number(r.rows[0].count);
      }

      if (!compiled.main) {
        // head:true select, or an empty bulk insert.
        if (compiled.rowCountOnly) return ok(null, ast.count ? 0 : null, 201);
        return ok(null, count);
      }

      const r = await client.query(compiled.main.text, compiled.main.values);

      if (compiled.rowCountOnly) {
        const status = ast.op === "insert" || ast.op === "upsert" ? 201 : 204;
        return { ...ok(null, ast.count ? (r.rowCount ?? 0) : null, status), status };
      }

      const data = r.rows[0]?.data ?? [];
      if (ast.op !== "select" && ast.count) count = Number(r.rows[0]?.count ?? 0);
      return applySingle(data, ast.single, count);
    },
    { timeoutMs: opts.timeoutMs },
  );
}

async function runRpc(ast: RpcAst, opts: ExecOptions): Promise<DbResult> {
  const catalog = await getCatalog(getPool());
  const compiled = compileRpc(catalog, ast);
  return withRole(
    opts.role,
    opts.userId,
    async (client) => {
      const r = await client.query(compiled.text, compiled.values);
      if (compiled.returnsVoid) return ok(null, null, 200);
      const data = r.rows[0]?.data ?? null;
      const count = ast.count ? (Array.isArray(data) ? data.length : data == null ? 0 : 1) : null;
      if (ast.head) return ok(null, count);
      return applySingle(data, ast.single, count);
    },
    { timeoutMs: opts.timeoutMs },
  );
}

export async function execute(ast: DbAst, opts: ExecOptions): Promise<DbResult> {
  try {
    return ast.kind === "rpc" ? await runRpc(ast, opts) : await runQuery(ast, opts);
  } catch (err) {
    if (err instanceof DbRequestError) {
      return fail({ message: err.message, code: err.code, details: err.details }, err.status);
    }
    const e = mapPgError(err);
    if (!e.code) {
      // Not a Postgres error — connection refused, bug, etc.
      console.error("[db] execute failed:", err);
      return fail({ message: e.message, code: "PGRST000" }, 503);
    }
    return fail(e, statusForPgCode(e.code, opts.role));
  }
}
