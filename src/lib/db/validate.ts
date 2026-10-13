// ============================================================
// Shape validation for ASTs arriving over HTTP (/api/db).
//
// The compiler re-validates every identifier against the catalog; this
// layer rejects malformed / oversized / unexpected input before it
// gets that far, and enforces the browser-only policy (RPC allowlist,
// optional table denylist).
// ============================================================

import { DbRequestError, FILTER_OPS, type DbAst, type Filter, type Order, type QueryAst, type RpcAst } from "./ast";

/** RPCs the browser may call directly. Everything else is server-only. */
export const BROWSER_RPC_ALLOWLIST: ReadonlySet<string> = new Set(["touch_presence", "filter_contacts_by_tags"]);

const OPS = new Set(["select", "insert", "update", "upsert", "delete"]);
const IDENT_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const COLUMN_REF = /^[A-Za-z_][A-Za-z0-9_.]*((->>?)[A-Za-z0-9_-]+)*$/;
const MAX_FILTERS = 100;
const MAX_DEPTH = 4;
const MAX_IN = 5000;

function fail(why: string): never {
  throw new DbRequestError(`invalid request: ${why}`, "PGRST100", 400);
}

function deniedTables(): Set<string> {
  return new Set(
    (process.env.DB_HTTP_DENY_TABLES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function checkFilter(f: unknown, depth: number, count: { n: number }): Filter {
  if (++count.n > MAX_FILTERS) fail("too many filters");
  if (depth > MAX_DEPTH) fail("filters nested too deeply");
  if (!f || typeof f !== "object") fail("filter");
  const x = f as Record<string, unknown>;
  if (x.kind === "cond") {
    if (typeof x.column !== "string" || !COLUMN_REF.test(x.column)) fail("filter column");
    if (typeof x.op !== "string" || !FILTER_OPS.has(x.op)) fail("filter operator");
    if (Array.isArray(x.value) && x.value.length > MAX_IN) fail("filter list too long");
    return {
      kind: "cond",
      column: x.column,
      op: x.op as Filter extends { op: infer O } ? O : never,
      value: x.value,
      negate: x.negate === true || undefined,
    } as Filter;
  }
  if (x.kind === "or" || x.kind === "and") {
    if (!Array.isArray(x.items)) fail("filter group");
    if (x.path !== undefined && (typeof x.path !== "string" || !IDENT_PATH.test(x.path))) fail("filter path");
    return {
      kind: x.kind,
      items: x.items.map((i) => checkFilter(i, depth + 1, count)),
      negate: x.negate === true || undefined,
      path: x.path as string | undefined,
    };
  }
  fail("filter kind");
}

function checkOrder(o: unknown): Order {
  if (!o || typeof o !== "object") fail("order");
  const x = o as Record<string, unknown>;
  if (typeof x.column !== "string" || !COLUMN_REF.test(x.column)) fail("order column");
  if (x.referencedTable !== undefined && (typeof x.referencedTable !== "string" || !IDENT_PATH.test(x.referencedTable))) {
    fail("order referencedTable");
  }
  return {
    column: x.column,
    ascending: x.ascending !== false,
    nullsFirst: typeof x.nullsFirst === "boolean" ? x.nullsFirst : undefined,
    referencedTable: x.referencedTable as string | undefined,
  };
}

const optInt = (v: unknown, what: string): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1_000_000) fail(what);
  return v;
};

const optSingle = (v: unknown) => (v === "single" || v === "maybe" ? v : undefined);

export function validateBrowserAst(input: unknown): DbAst {
  if (!input || typeof input !== "object") fail("body");
  const x = input as Record<string, unknown>;

  if (x.kind === "rpc") {
    if (typeof x.fn !== "string" || !BROWSER_RPC_ALLOWLIST.has(x.fn)) {
      throw new DbRequestError(`function ${String(x.fn)} is not callable from the browser`, "42501", 403);
    }
    if (x.args !== undefined && (typeof x.args !== "object" || x.args === null || Array.isArray(x.args))) fail("args");
    const ast: RpcAst = {
      kind: "rpc",
      fn: x.fn,
      args: (x.args as Record<string, unknown>) ?? {},
      single: optSingle(x.single),
      count: x.count === "exact" ? "exact" : undefined,
      head: x.head === true || undefined,
    };
    return ast;
  }

  if (x.kind !== "query") fail("kind");
  if (typeof x.table !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(x.table)) fail("table");
  if (deniedTables().has(x.table)) {
    throw new DbRequestError(`table ${x.table} is not accessible from the browser`, "42501", 403);
  }
  if (typeof x.op !== "string" || !OPS.has(x.op)) fail("op");
  if (typeof x.select !== "string" || x.select.length > 4000) fail("select");
  if (!Array.isArray(x.filters) || !Array.isArray(x.orders) || x.orders.length > 10) fail("filters/orders");
  const count = { n: 0 };
  const ast: QueryAst = {
    kind: "query",
    table: x.table,
    op: x.op as QueryAst["op"],
    select: x.select,
    returning: x.returning === true,
    filters: x.filters.map((f) => checkFilter(f, 0, count)),
    orders: x.orders.map(checkOrder),
    limit: optInt(x.limit, "limit"),
    offset: optInt(x.offset, "offset"),
    single: optSingle(x.single),
    count: x.count === "exact" ? "exact" : undefined,
    head: x.head === true || undefined,
    values: x.values,
    onConflict: typeof x.onConflict === "string" ? x.onConflict : undefined,
    ignoreDuplicates: x.ignoreDuplicates === true || undefined,
  };
  if (ast.onConflict !== undefined && !/^[A-Za-z0-9_, ]{1,200}$/.test(ast.onConflict)) fail("onConflict");
  return ast;
}
