/* eslint-disable @typescript-eslint/no-explicit-any -- results are untyped `any`, exactly like an untyped supabase-js client; callers cast to their own types. */
// ============================================================
// supabase-js compatible query builder.
//
// Records the call chain into a QueryAst / RpcAst and hands it to an
// executor when awaited. The executor is what differs between
// environments:
//   server  → compile + run in-process   (execute.ts)
//   browser → POST the AST to /api/db     (browser.ts)
//
// Only the subset of the PostgREST builder API the app uses is
// implemented; anything else is a type error rather than a silent
// no-op.
// ============================================================

import type { DbAst, DbResult, FilterOp, Order, QueryAst, RpcAst } from "./ast";
import { parseLogicTree } from "./or-parser";

export type Executor = (ast: DbAst) => Promise<DbResult>;

type CountOpt = { count?: "exact" | "planned" | "estimated" | null };

function parseFilterValue(op: FilterOp, value: unknown): unknown {
  // `.filter(col, 'in', '(a,b)')` / `.not(col, 'is', null)` take
  // PostgREST-syntax strings; reuse the logic-tree parser for those.
  if (typeof value === "string" && (op === "in" || op === "is")) {
    const f = parseLogicTree(`x.${op}.${value}`);
    if (f.kind !== "cond" && f.items[0]?.kind === "cond") return f.items[0].value;
  }
  return value;
}

/**
 * A pending query. Mutable, like supabase-js: every method returns
 * `this`, so both `q = q.eq(...)` and chained calls work.
 */
export class FilterBuilder<T = any[]> implements PromiseLike<DbResult<T>> {
  constructor(
    protected readonly ast: QueryAst,
    private readonly exec: Executor,
  ) {}

  // ---------------- filters ----------------
  private cond(column: string, op: FilterOp, value: unknown, negate = false): this {
    this.ast.filters.push({ kind: "cond", column, op, value, negate: negate || undefined });
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.cond(column, "eq", value);
  }
  neq(column: string, value: unknown): this {
    return this.cond(column, "neq", value);
  }
  gt(column: string, value: unknown): this {
    return this.cond(column, "gt", value);
  }
  gte(column: string, value: unknown): this {
    return this.cond(column, "gte", value);
  }
  lt(column: string, value: unknown): this {
    return this.cond(column, "lt", value);
  }
  lte(column: string, value: unknown): this {
    return this.cond(column, "lte", value);
  }
  like(column: string, pattern: string): this {
    return this.cond(column, "like", pattern);
  }
  ilike(column: string, pattern: string): this {
    return this.cond(column, "ilike", pattern);
  }
  is(column: string, value: null | boolean): this {
    return this.cond(column, "is", value);
  }
  in(column: string, values: readonly unknown[]): this {
    return this.cond(column, "in", [...values]);
  }
  contains(column: string, value: unknown): this {
    return this.cond(column, "contains", value);
  }
  containedBy(column: string, value: unknown): this {
    return this.cond(column, "containedBy", value);
  }
  overlaps(column: string, value: unknown): this {
    return this.cond(column, "overlaps", value);
  }
  match(query: Record<string, unknown>): this {
    for (const [k, v] of Object.entries(query)) this.cond(k, "eq", v);
    return this;
  }
  not(column: string, operator: string, value: unknown): this {
    const op = operator as FilterOp;
    return this.cond(column, op, parseFilterValue(op, value), true);
  }
  filter(column: string, operator: string, value: unknown): this {
    if (operator.startsWith("not.")) return this.not(column, operator.slice(4), value);
    const op = operator as FilterOp;
    return this.cond(column, op, parseFilterValue(op, value));
  }
  or(filters: string, opts: { referencedTable?: string; foreignTable?: string } = {}): this {
    const group = parseLogicTree(filters, "or");
    const path = opts.referencedTable ?? opts.foreignTable;
    if (path && group.kind !== "cond") group.path = path;
    this.ast.filters.push(group);
    return this;
  }

  // ---------------- shaping ----------------
  order(
    column: string,
    opts: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string } = {},
  ): this {
    const o: Order = { column, ascending: opts.ascending ?? true };
    if (opts.nullsFirst !== undefined) o.nullsFirst = opts.nullsFirst;
    const ref = opts.referencedTable ?? opts.foreignTable;
    if (ref) o.referencedTable = ref;
    this.ast.orders.push(o);
    return this;
  }
  limit(count: number): this {
    this.ast.limit = count;
    return this;
  }
  range(from: number, to: number): this {
    this.ast.offset = from;
    this.ast.limit = to - from + 1;
    return this;
  }
  single(): FilterBuilder<any> {
    this.ast.single = "single";
    return this;
  }
  maybeSingle(): FilterBuilder<any> {
    this.ast.single = "maybe";
    return this;
  }
  /** After insert/update/upsert/delete: return the affected rows. */
  select(columns = "*"): this {
    this.ast.returning = true;
    this.ast.select = columns;
    return this;
  }
  /** Type-only in supabase-js. */
  returns<U>(): FilterBuilder<U> {
    return this as unknown as FilterBuilder<U>;
  }
  /** Accepted for API compatibility; queries are not cancellable. */
  abortSignal(): this {
    return this;
  }

  /** The recorded AST (used by the browser transport and tests). */
  toAst(): QueryAst {
    return this.ast;
  }

  then<R1 = DbResult<T>, R2 = never>(
    onfulfilled?: ((value: DbResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return (this.exec(this.ast) as Promise<DbResult<T>>).then(onfulfilled, onrejected);
  }
}

export class QueryBuilder {
  constructor(
    private readonly table: string,
    private readonly exec: Executor,
  ) {}

  private base(op: QueryAst["op"]): QueryAst {
    return { kind: "query", table: this.table, op, select: "*", returning: false, filters: [], orders: [] };
  }

  select(columns = "*", opts: CountOpt & { head?: boolean } = {}): FilterBuilder {
    const ast = this.base("select");
    ast.select = columns;
    if (opts.count) ast.count = "exact";
    if (opts.head) ast.head = true;
    return new FilterBuilder(ast, this.exec);
  }

  insert(values: unknown, opts: CountOpt & { defaultToNull?: boolean } = {}): FilterBuilder {
    const ast = this.base("insert");
    ast.values = values;
    if (opts.count) ast.count = "exact";
    if (opts.defaultToNull === false) ast.defaultToNull = false;
    return new FilterBuilder(ast, this.exec);
  }

  upsert(
    values: unknown,
    opts: CountOpt & { onConflict?: string; ignoreDuplicates?: boolean; defaultToNull?: boolean } = {},
  ): FilterBuilder {
    const ast = this.base("upsert");
    ast.values = values;
    if (opts.onConflict) ast.onConflict = opts.onConflict;
    if (opts.ignoreDuplicates) ast.ignoreDuplicates = true;
    if (opts.count) ast.count = "exact";
    return new FilterBuilder(ast, this.exec);
  }

  update(values: unknown, opts: CountOpt = {}): FilterBuilder {
    const ast = this.base("update");
    ast.values = values;
    if (opts.count) ast.count = "exact";
    return new FilterBuilder(ast, this.exec);
  }

  delete(opts: CountOpt = {}): FilterBuilder {
    const ast = this.base("delete");
    if (opts.count) ast.count = "exact";
    return new FilterBuilder(ast, this.exec);
  }
}

export class RpcBuilder<T = any> implements PromiseLike<DbResult<T>> {
  constructor(
    private readonly ast: RpcAst,
    private readonly exec: Executor,
  ) {}

  single(): RpcBuilder<any> {
    this.ast.single = "single";
    return this;
  }
  maybeSingle(): RpcBuilder<any> {
    this.ast.single = "maybe";
    return this;
  }
  returns<U>(): RpcBuilder<U> {
    return this as unknown as RpcBuilder<U>;
  }
  /** Accepted for API compatibility; queries are not cancellable. */
  abortSignal(): this {
    return this;
  }
  toAst(): RpcAst {
    return this.ast;
  }

  then<R1 = DbResult<T>, R2 = never>(
    onfulfilled?: ((value: DbResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return (this.exec(this.ast) as Promise<DbResult<T>>).then(onfulfilled, onrejected);
  }
}

export function makeRpc(exec: Executor) {
  return (fn: string, args: Record<string, unknown> = {}, opts: CountOpt & { head?: boolean } = {}) => {
    const ast: RpcAst = { kind: "rpc", fn, args };
    if (opts.count) ast.count = "exact";
    if (opts.head) ast.head = true;
    return new RpcBuilder(ast, exec);
  };
}
