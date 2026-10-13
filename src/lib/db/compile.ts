// ============================================================
// AST → parameterised SQL.
//
// Safety model:
//   * every table / column / function / FK name is looked up in the
//     catalog (public schema only) and emitted double-quoted from the
//     catalog's own spelling — never from the request;
//   * every value is a bind parameter;
//   * operators come from a fixed allowlist (ast.FILTER_OPS);
//   * JSON keys and casts are regex-validated in the parsers.
//
// Output mirrors PostgREST: Postgres itself serialises rows to JSON
// (json_agg / row_to_json), so numerics, bigint, timestamptz and
// nested embeds come back exactly as supabase-js callers expect.
// ============================================================

import {
  DbRequestError,
  type Filter,
  type Order,
  type QueryAst,
  type RpcAst,
} from "./ast";
import type { Catalog, ColumnInfo, ForeignKey, FunctionInfo, TableInfo } from "./catalog";
import { parseLogicTree } from "./or-parser";
import { parseColumnRef, parseSelect, type SelectItem } from "./select-parser";

export interface Compiled {
  text: string;
  values: unknown[];
}

export interface CompiledQuery {
  /** Returns one row with a `data` json column (or a plain write when `rowCountOnly`). */
  main: Compiled | null;
  count: Compiled | null;
  /** Write without `.select()` — data is null, count comes from rowCount. */
  rowCountOnly: boolean;
}

export interface CompileOptions {
  maxRows: number;
}

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------

class Params {
  readonly values: unknown[] = [];
  add(v: unknown, cast?: string): string {
    this.values.push(v);
    return cast ? `$${this.values.length}::${cast}` : `$${this.values.length}`;
  }
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function getTable(cat: Catalog, name: string): TableInfo {
  const t = cat.tables.get(name);
  if (!t) {
    throw new DbRequestError(
      `relation "public.${name}" does not exist`,
      "42P01",
      404,
    );
  }
  return t;
}

function getColumn(table: TableInfo, name: string): ColumnInfo {
  const c = table.columns.get(name);
  if (!c) {
    throw new DbRequestError(
      `column ${table.name}.${name} does not exist`,
      "42703",
      400,
    );
  }
  return c;
}

function intOrThrow(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new DbRequestError(`invalid ${what}`, "PGRST103");
  }
  return v;
}

/** Bind-ready value for a column. json/jsonb get stringified (node-pg would turn arrays into PG array literals). */
function bindValue(col: ColumnInfo | null, value: unknown): unknown {
  if (col?.isJson) return JSON.stringify(value);
  return value;
}

// ------------------------------------------------------------
// Select tree with resolved relationships
// ------------------------------------------------------------

interface Node {
  table: TableInfo;
  items: SelectItem[];
  embeds: EmbedNode[];
  filters: Filter[];
  orders: Order[];
}

interface EmbedNode extends Node {
  /** JSON key in the output (alias ?? table name). */
  key: string;
  inner: boolean;
  kind: "m2o" | "o2m";
  fk: ForeignKey;
}

function resolveRelation(
  cat: Catalog,
  parent: TableInfo,
  item: Extract<SelectItem, { type: "embed" }>,
): { target: TableInfo; kind: "m2o" | "o2m"; fk: ForeignKey } {
  const target = getTable(cat, item.name);
  type Cand = { kind: "m2o" | "o2m"; fk: ForeignKey };
  let cands: Cand[] = [];
  for (const fk of cat.foreignKeys) {
    if (fk.table === parent.name && fk.refTable === target.name) cands.push({ kind: "m2o", fk });
    else if (fk.table === target.name && fk.refTable === parent.name) cands.push({ kind: "o2m", fk });
  }
  if (item.hint) {
    const hint = item.hint;
    cands = cands.filter(
      (c) => c.fk.name === hint || (c.fk.columns.length === 1 && c.fk.columns[0] === hint),
    );
  }
  if (cands.length === 0) {
    throw new DbRequestError(
      `Could not find a relationship between '${parent.name}' and '${target.name}' in the schema cache`,
      "PGRST200",
      400,
    );
  }
  if (cands.length > 1) {
    throw new DbRequestError(
      `Could not embed because more than one relationship was found for '${parent.name}' and '${target.name}'`,
      "PGRST201",
      300,
      cands.map((c) => c.fk.name).join(", "),
    );
  }
  return { target, ...cands[0] };
}

function buildNode(cat: Catalog, table: TableInfo, items: SelectItem[]): Node {
  const node: Node = { table, items, embeds: [], filters: [], orders: [] };
  for (const item of items) {
    if (item.type !== "embed") continue;
    const rel = resolveRelation(cat, table, item);
    const child = buildNode(cat, rel.target, item.children);
    node.embeds.push({
      ...child,
      key: item.alias ?? item.name,
      inner: item.inner,
      kind: rel.kind,
      fk: rel.fk,
    });
  }
  return node;
}

function findEmbed(node: Node, key: string): EmbedNode {
  const e = node.embeds.find((x) => x.key === key);
  if (!e) {
    throw new DbRequestError(
      `'${key}' is not an embedded resource in this request`,
      "PGRST108",
      400,
    );
  }
  return e;
}

/** Route a filter on `a.b.col` down to the embed it targets. */
function routeFilter(root: Node, f: Filter): void {
  if (f.kind === "cond") {
    const parts = f.column.split(".");
    let node = root;
    for (const seg of parts.slice(0, -1)) node = findEmbed(node, seg);
    node.filters.push({ ...f, column: parts[parts.length - 1] });
    return;
  }
  let node = root;
  if (f.path) for (const seg of f.path.split(".")) node = findEmbed(node, seg);
  node.filters.push({ ...f, path: undefined });
}

function routeOrder(root: Node, o: Order): void {
  let node = root;
  if (o.referencedTable) for (const seg of o.referencedTable.split(".")) node = findEmbed(node, seg);
  node.orders.push({ ...o, referencedTable: undefined });
}

// ------------------------------------------------------------
// Expressions
// ------------------------------------------------------------

interface Ctx {
  cat: Catalog;
  params: Params;
  aliasSeq: number;
}

function nextAlias(ctx: Ctx, prefix: string): string {
  ctx.aliasSeq++;
  return `${prefix}${ctx.aliasSeq}`;
}

function columnExpr(
  table: TableInfo,
  alias: string,
  ref: string,
): { expr: string; col: ColumnInfo; jsonOut: "json" | "text" | null } {
  const { name, path } = parseColumnRef(ref);
  const col = getColumn(table, name);
  let expr = `${alias}.${q(name)}`;
  let jsonOut: "json" | "text" | null = null;
  if (path) {
    if (!col.isJson) {
      throw new DbRequestError(`column ${table.name}.${name} is not json`, "42883");
    }
    for (const [op, key] of path) {
      expr += /^\d+$/.test(key) ? `${op}${key}` : `${op}${lit(key)}`;
      jsonOut = op === "->>" ? "text" : "json";
    }
  }
  return { expr, col, jsonOut };
}

const CMP: Record<string, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

function condSql(ctx: Ctx, table: TableInfo, alias: string, f: Extract<Filter, { kind: "cond" }>): string {
  const { expr, col, jsonOut } = columnExpr(table, alias, f.column);
  const p = ctx.params;
  // json-typed comparands: whole json column, or a `->` path.
  const isJsonCmp = jsonOut === "json" || (jsonOut === null && col.isJson);
  const asParam = (v: unknown) =>
    isJsonCmp ? p.add(JSON.stringify(v), "jsonb") : jsonOut === "text" ? p.add(v == null ? v : String(v), "text") : p.add(v);
  const jsonbExpr = isJsonCmp ? `(${expr})::jsonb` : expr;

  let sql: string;
  switch (f.op) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      if (f.value === null && (f.op === "eq" || f.op === "neq")) {
        sql = `${expr} IS ${f.op === "eq" ? "" : "NOT "}NULL`;
      } else {
        sql = `${jsonbExpr} ${CMP[f.op]} ${asParam(f.value)}`;
      }
      break;
    case "like":
    case "ilike": {
      const pattern = String(f.value).replace(/\*/g, "%");
      sql = `${expr}${jsonOut || col.category !== "S" ? "::text" : ""} ${f.op === "like" ? "LIKE" : "ILIKE"} ${p.add(pattern)}`;
      break;
    }
    case "is":
      if (f.value === null || f.value === "null") sql = `${expr} IS NULL`;
      else if (f.value === true || f.value === "true") sql = `${expr} IS TRUE`;
      else if (f.value === false || f.value === "false") sql = `${expr} IS FALSE`;
      else throw new DbRequestError(`invalid value for is: ${String(f.value)}`, "PGRST100");
      break;
    case "in": {
      if (!Array.isArray(f.value)) throw new DbRequestError("in expects an array", "PGRST100");
      if (f.value.length === 0) {
        sql = "FALSE";
        break;
      }
      const elemType = jsonOut ? "text" : col.isJson ? "jsonb" : col.type;
      const vals = jsonOut
        ? f.value.map((v) => (v == null ? v : String(v)))
        : col.isJson
          ? f.value.map((v) => JSON.stringify(v))
          : f.value;
      sql = `${jsonbExpr} = ANY(${p.add(vals, `${elemType}[]`)})`;
      break;
    }
    case "contains":
    case "containedBy":
    case "overlaps": {
      const sym = f.op === "contains" ? "@>" : f.op === "containedBy" ? "<@" : "&&";
      if (isJsonCmp) sql = `${jsonbExpr} ${sym} ${p.add(JSON.stringify(f.value), "jsonb")}`;
      else if (col.isArray) sql = `${expr} ${sym} ${p.add(f.value, col.type)}`;
      else throw new DbRequestError(`operator ${f.op} needs an array or json column`, "42883");
      break;
    }
    default:
      throw new DbRequestError(`unknown operator ${String((f as { op: string }).op)}`, "PGRST100");
  }
  return f.negate ? `NOT (${sql})` : sql;
}

function filterSql(ctx: Ctx, table: TableInfo, alias: string, f: Filter): string {
  if (f.kind === "cond") return condSql(ctx, table, alias, f);
  if (f.items.length === 0) return f.kind === "and" ? "TRUE" : "FALSE";
  const parts = f.items.map((i) => {
    if (i.kind === "cond" && i.column.includes(".")) {
      throw new DbRequestError(
        "filters on embedded resources inside or()/and() need the referencedTable option",
        "PGRST100",
      );
    }
    return `(${filterSql(ctx, table, alias, i)})`;
  });
  const sql = parts.join(f.kind === "and" ? " AND " : " OR ");
  return f.negate ? `NOT (${sql})` : sql;
}

function joinSql(e: EmbedNode, parentAlias: string, childAlias: string): string {
  return e.fk.columns
    .map((c, i) =>
      e.kind === "m2o"
        ? `${childAlias}.${q(e.fk.refColumns[i])} = ${parentAlias}.${q(c)}`
        : `${childAlias}.${q(c)} = ${parentAlias}.${q(e.fk.refColumns[i])}`,
    )
    .join(" AND ");
}

/** WHERE conditions for a node: its own filters + EXISTS for !inner embeds. */
function whereParts(ctx: Ctx, node: Node, alias: string): string[] {
  const parts = node.filters.map((f) => filterSql(ctx, node.table, alias, f));
  for (const e of node.embeds) {
    if (!e.inner) continue;
    const ea = nextAlias(ctx, "_x");
    const inner = [joinSql(e, alias, ea), ...whereParts(ctx, e, ea)];
    parts.push(`EXISTS (SELECT 1 FROM public.${q(e.table.name)} ${ea} WHERE ${inner.join(" AND ")})`);
  }
  return parts;
}

function orderSql(node: Node, alias: string): string {
  if (node.orders.length === 0) return "";
  return (
    " ORDER BY " +
    node.orders
      .map((o) => {
        const { expr } = columnExpr(node.table, alias, o.column);
        let s = `${expr} ${o.ascending ? "ASC" : "DESC"}`;
        if (o.nullsFirst !== undefined) s += o.nullsFirst ? " NULLS FIRST" : " NULLS LAST";
        return s;
      })
      .join(", ")
  );
}

function projection(ctx: Ctx, node: Node, alias: string): string {
  const out: string[] = [];
  let embedIdx = 0;
  for (const item of node.items) {
    if (item.type === "star") {
      out.push(`${alias}.*`);
    } else if (item.type === "column") {
      const col = getColumn(node.table, item.name);
      let expr = `${alias}.${q(col.name)}`;
      let key = item.alias ?? item.name;
      if (item.path) {
        if (!col.isJson) throw new DbRequestError(`column ${node.table.name}.${col.name} is not json`, "42883");
        for (const [op, k] of item.path) expr += /^\d+$/.test(k) ? `${op}${k}` : `${op}${lit(k)}`;
        if (!item.alias) key = item.path[item.path.length - 1][1];
      }
      if (item.cast) expr = `(${expr})::${item.cast}`;
      out.push(`${expr} AS ${q(key)}`);
    } else {
      const e = node.embeds[embedIdx++];
      out.push(`${embedSql(ctx, e, alias)} AS ${q(e.key)}`);
    }
  }
  return out.join(", ") || `${alias}.*`;
}

function embedSql(ctx: Ctx, e: EmbedNode, parentAlias: string): string {
  const ca = nextAlias(ctx, "_t");
  const wa = nextAlias(ctx, "_e");
  const where = [joinSql(e, parentAlias, ca), ...whereParts(ctx, e, ca)].join(" AND ");
  const inner = `SELECT ${projection(ctx, e, ca)} FROM public.${q(e.table.name)} ${ca} WHERE ${where}`;
  if (e.kind === "m2o") {
    return `(SELECT row_to_json(${wa}) FROM (${inner} LIMIT 1) ${wa})`;
  }
  return `(SELECT coalesce(json_agg(${wa}), '[]'::json) FROM (${inner}${orderSql(e, ca)}) ${wa})`;
}

// ------------------------------------------------------------
// Public: compile a table query
// ------------------------------------------------------------

export function compileQuery(cat: Catalog, ast: QueryAst, opts: CompileOptions): CompiledQuery {
  const table = getTable(cat, ast.table);
  const ctx: Ctx = { cat, params: new Params(), aliasSeq: 0 };
  const root = buildNode(cat, table, parseSelect(ast.select));
  const rootAlias = "_t0";

  if (ast.op === "select") {
    for (const f of ast.filters) routeFilter(root, f);
    for (const o of ast.orders) routeOrder(root, o);
    const where = whereParts(ctx, root, rootAlias);
    const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";

    let count: Compiled | null = null;
    if (ast.count) {
      // Separate param list: count shares the filters but not the projection.
      const cctx: Ctx = { cat, params: new Params(), aliasSeq: 1000 };
      const cwhere = whereParts(cctx, root, rootAlias);
      count = {
        text: `SELECT count(*)::bigint AS count FROM public.${q(table.name)} ${rootAlias}${
          cwhere.length ? ` WHERE ${cwhere.join(" AND ")}` : ""
        }`,
        values: cctx.params.values,
      };
    }
    if (ast.head) return { main: null, count, rowCountOnly: false };

    const limit = Math.min(
      ast.limit !== undefined ? intOrThrow(ast.limit, "limit") : opts.maxRows,
      opts.maxRows,
    );
    const offset = ast.offset !== undefined ? intOrThrow(ast.offset, "offset") : 0;
    const inner =
      `SELECT ${projection(ctx, root, rootAlias)} FROM public.${q(table.name)} ${rootAlias}` +
      whereSql +
      orderSql(root, rootAlias) +
      ` LIMIT ${limit}` +
      (offset ? ` OFFSET ${offset}` : "");
    return {
      main: {
        text: `SELECT coalesce(json_agg(_r), '[]'::json) AS data FROM (${inner}) _r`,
        values: ctx.params.values,
      },
      count,
      rowCountOnly: false,
    };
  }

  // ---------------- writes ----------------
  for (const f of ast.filters) {
    if (f.kind === "cond" && f.column.includes(".")) {
      throw new DbRequestError("filters on embedded resources are not allowed on writes", "PGRST100");
    }
    root.filters.push(f);
  }

  let writeSql: string;
  if (ast.op === "insert" || ast.op === "upsert") {
    const rows = (Array.isArray(ast.values) ? ast.values : [ast.values]) as Record<string, unknown>[];
    if (rows.length === 0) {
      return { main: null, count: null, rowCountOnly: true };
    }
    if (rows.some((r) => r === null || typeof r !== "object" || Array.isArray(r))) {
      throw new DbRequestError("insert expects an object or an array of objects", "PGRST102");
    }
    const keys =
      rows.length === 1
        ? Object.keys(rows[0]).filter((k) => rows[0][k] !== undefined)
        : [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const cols = keys.map((k) => {
      const c = getColumn(table, k);
      if (c.generated) throw new DbRequestError(`cannot insert into generated column "${k}"`, "428C9");
      return c.name;
    });
    if (cols.length === 0) {
      writeSql = `INSERT INTO public.${q(table.name)} AS ${rootAlias} DEFAULT VALUES`;
      if (rows.length > 1) {
        throw new DbRequestError("bulk insert of empty objects is not supported", "PGRST102");
      }
    } else {
      const colList = cols.map(q).join(", ");
      const payload = ctx.params.add(JSON.stringify(rows), "json");
      writeSql =
        `INSERT INTO public.${q(table.name)} AS ${rootAlias} (${colList}) ` +
        `SELECT ${colList} FROM json_populate_recordset(NULL::public.${q(table.name)}, ${payload})`;
    }
    if (ast.op === "upsert") {
      const target = ast.onConflict
        ? ast.onConflict.split(",").map((s) => getColumn(table, s.trim()).name)
        : table.primaryKey;
      if (target.length === 0) {
        throw new DbRequestError(`table ${table.name} has no primary key; pass onConflict`, "PGRST102");
      }
      const updatable = cols.filter((c) => !target.includes(c));
      writeSql += ` ON CONFLICT (${target.map(q).join(", ")}) `;
      writeSql +=
        ast.ignoreDuplicates || updatable.length === 0
          ? "DO NOTHING"
          : `DO UPDATE SET ${updatable.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(", ")}`;
    }
  } else if (ast.op === "update") {
    const patch = ast.values as Record<string, unknown>;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new DbRequestError("update expects an object", "PGRST102");
    }
    const cols = Object.keys(patch)
      .filter((k) => patch[k] !== undefined)
      .map((k) => getColumn(table, k).name);
    if (cols.length === 0) throw new DbRequestError("update has no columns", "PGRST102");
    if (root.filters.length === 0) {
      throw new DbRequestError("UPDATE requires a WHERE clause", "21000");
    }
    const where = whereParts(ctx, root, rootAlias);
    const payload = ctx.params.add(JSON.stringify(patch), "json");
    writeSql =
      `UPDATE public.${q(table.name)} AS ${rootAlias} SET ` +
      cols.map((c) => `${q(c)} = _v.${q(c)}`).join(", ") +
      ` FROM json_populate_record(NULL::public.${q(table.name)}, ${payload}) _v` +
      ` WHERE ${where.join(" AND ")}`;
  } else if (ast.op === "delete") {
    if (root.filters.length === 0) {
      throw new DbRequestError("DELETE requires a WHERE clause", "21000");
    }
    const where = whereParts(ctx, root, rootAlias);
    writeSql = `DELETE FROM public.${q(table.name)} AS ${rootAlias} WHERE ${where.join(" AND ")}`;
  } else {
    throw new DbRequestError(`unknown operation ${String(ast.op)}`, "PGRST100");
  }

  if (!ast.returning) {
    return { main: { text: writeSql, values: ctx.params.values }, count: null, rowCountOnly: true };
  }

  for (const o of ast.orders) routeOrder(root, o);
  const proj = projection(ctx, root, rootAlias);
  return {
    main: {
      text:
        `WITH _w AS (${writeSql} RETURNING ${rootAlias}.*) ` +
        `SELECT coalesce((SELECT json_agg(_r) FROM (SELECT ${proj} FROM _w ${rootAlias}${orderSql(root, rootAlias)}) _r), '[]'::json) AS data, ` +
        `(SELECT count(*) FROM _w)::bigint AS count`,
      values: ctx.params.values,
    },
    count: null,
    rowCountOnly: false,
  };
}

// ------------------------------------------------------------
// Public: compile an RPC
// ------------------------------------------------------------

function pickOverload(fns: FunctionInfo[], args: Record<string, unknown>): FunctionInfo | null {
  const provided = Object.keys(args).filter((k) => args[k] !== undefined);
  const fits = fns.filter((f) => {
    if (!provided.every((k) => f.argNames.includes(k))) return false;
    const required = f.argNames.slice(0, f.argNames.length - f.nDefaults);
    return required.every((k) => provided.includes(k));
  });
  fits.sort((a, b) => a.argNames.length - b.argNames.length);
  return fits[0] ?? null;
}

export function compileRpc(cat: Catalog, ast: RpcAst): Compiled & { returnsVoid: boolean; returnsSet: boolean } {
  const fns = cat.functions.get(ast.fn);
  const args = ast.args ?? {};
  const fn = fns ? pickOverload(fns, args) : null;
  if (!fn) {
    throw new DbRequestError(
      `Could not find the function public.${ast.fn}(${Object.keys(args).join(", ")}) in the schema cache`,
      "PGRST202",
      404,
    );
  }
  const params = new Params();
  const argSql = fn.argNames
    .map((name, i) => {
      if (!(name in args) || args[name] === undefined) return null;
      const type = fn.argTypes[i];
      const v = /^jsonb?$/.test(type) ? JSON.stringify(args[name]) : args[name];
      return `${q(name)} => ${params.add(v, type)}`;
    })
    .filter(Boolean)
    .join(", ");
  const call = `public.${q(fn.name)}(${argSql})`;
  if (fn.returnType === "void") {
    return { text: `SELECT ${call}`, values: params.values, returnsVoid: true, returnsSet: false };
  }
  if (fn.returnsSet) {
    return {
      text: `SELECT coalesce(json_agg(_r), '[]'::json) AS data FROM ${call} _r`,
      values: params.values,
      returnsVoid: false,
      returnsSet: true,
    };
  }
  return {
    text: `SELECT to_json(_r) AS data FROM ${call} _r`,
    values: params.values,
    returnsVoid: false,
    returnsSet: false,
  };
}

export { parseLogicTree };
