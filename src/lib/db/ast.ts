// ============================================================
// Serializable query description.
//
// The query builder (builder.ts) records a supabase-js style call
// chain into this shape. On the server it is compiled to SQL directly
// (compile.ts); in the browser it is POSTed as JSON to /api/db and
// compiled there. It never contains SQL — only identifiers that the
// compiler validates against the live catalog, and values that are
// always sent as bind parameters.
// ============================================================

export type FilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "is"
  | "in"
  | "contains"
  | "containedBy"
  | "overlaps";

export const FILTER_OPS: ReadonlySet<string> = new Set<FilterOp>([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "contains",
  "containedBy",
  "overlaps",
]);

export type Filter =
  | {
      kind: "cond";
      /** `col`, `embed.col`, or `col->>key` / `col->key`. */
      column: string;
      op: FilterOp;
      value: unknown;
      negate?: boolean;
    }
  | {
      kind: "or" | "and";
      items: Filter[];
      negate?: boolean;
      /** Embed path the group applies to (PostgREST `referencedTable`). */
      path?: string;
    };

export interface Order {
  column: string;
  ascending: boolean;
  nullsFirst?: boolean;
  /** Embed alias the ordering applies to. */
  referencedTable?: string;
}

export type QueryOp = "select" | "insert" | "update" | "upsert" | "delete";

export interface QueryAst {
  kind: "query";
  table: string;
  op: QueryOp;
  /** Select list. For writes: only meaningful when `returning` is true. */
  select: string;
  returning: boolean;
  filters: Filter[];
  orders: Order[];
  limit?: number;
  offset?: number;
  single?: "single" | "maybe";
  count?: "exact";
  head?: boolean;
  /** Insert/upsert: row or rows. Update: patch object. */
  values?: unknown;
  onConflict?: string;
  ignoreDuplicates?: boolean;
  /** supabase-js insert option: missing keys in bulk rows → NULL (default) or DEFAULT. */
  defaultToNull?: boolean;
}

export interface RpcAst {
  kind: "rpc";
  fn: string;
  args: Record<string, unknown>;
  single?: "single" | "maybe";
  count?: "exact";
  head?: boolean;
}

export type DbAst = QueryAst | RpcAst;

export interface DbError {
  message: string;
  code: string;
  details: string | null;
  hint: string | null;
}

export interface DbResult<T = any> {
  data: T;
  error: DbError | null;
  count: number | null;
  status: number;
  statusText: string;
}

/** Thrown inside the compiler for request-shape problems (→ 400). */
export class DbRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly details: string | null = null,
  ) {
    super(message);
    this.name = "DbRequestError";
  }
}
