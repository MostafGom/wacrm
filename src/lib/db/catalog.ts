// ============================================================
// Schema catalog — the allowlist the SQL compiler validates every
// identifier against. Loaded once per process from pg_catalog and
// cached; `refreshCatalog()` reloads it (tests, after migrations).
//
// Only schema `public` is exposed. auth / storage / _wacrm are never
// reachable through the query builder.
// ============================================================

import type { Pool, PoolClient } from "pg";

export interface ColumnInfo {
  name: string;
  /** format_type() output, e.g. `uuid`, `text[]`, `jsonb`, `vector(1536)`. */
  type: string;
  /** pg_type.typcategory: A=array, U=user (json/jsonb), E=enum, ... */
  category: string;
  isJson: boolean;
  isArray: boolean;
  generated: boolean;
}

export interface ForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface TableInfo {
  name: string;
  columns: Map<string, ColumnInfo>;
  primaryKey: string[];
}

export interface FunctionInfo {
  name: string;
  /** Input argument names, in order. */
  argNames: string[];
  /** Input argument types (format_type), aligned with argNames. */
  argTypes: string[];
  /** Number of trailing args that have defaults. */
  nDefaults: number;
  returnsSet: boolean;
  returnType: string;
}

export interface Catalog {
  tables: Map<string, TableInfo>;
  foreignKeys: ForeignKey[];
  functions: Map<string, FunctionInfo[]>;
}

let cached: Promise<Catalog> | null = null;

export function getCatalog(pool: Pool): Promise<Catalog> {
  if (!cached) {
    cached = loadCatalog(pool).catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

export function refreshCatalog(): void {
  cached = null;
}

async function loadCatalog(pool: Pool): Promise<Catalog> {
  const client: PoolClient = await pool.connect();
  try {
    // Catalog reads need no privileges beyond CONNECT; run them as the
    // login role without switching.
    const cols = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      typcategory: string;
      typname: string;
      generated: boolean;
    }>(`
      SELECT c.relname AS table_name,
             a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS data_type,
             t.typcategory,
             t.typname,
             (a.attgenerated <> '') AS generated
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm')
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum
    `);

    const pks = await client.query<{ table_name: string; columns: string[] }>(`
      SELECT c.relname AS table_name,
             array_agg(a.attname ORDER BY k.ord)::text[] AS columns
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE n.nspname = 'public' AND con.contype = 'p'
      GROUP BY c.relname
    `);

    const fks = await client.query<{
      name: string;
      table_name: string;
      columns: string[];
      ref_table: string;
      ref_columns: string[];
    }>(`
      SELECT con.conname AS name,
             c.relname AS table_name,
             (SELECT array_agg(a.attname ORDER BY k.ord)::text[]
                FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
             rc.relname AS ref_table,
             (SELECT array_agg(a.attname ORDER BY k.ord)::text[]
                FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_columns
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class rc ON rc.oid = con.confrelid
      JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public' AND rn.nspname = 'public'
    `);

    const fns = await client.query<{
      proname: string;
      arg_types: string[];
      arg_names: string[] | null;
      arg_modes: string[] | null;
      pronargs: number;
      pronargdefaults: number;
      proretset: boolean;
      ret_type: string;
    }>(`
      SELECT p.proname,
             ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t)::text[] AS arg_types,
             p.proargnames::text[] AS arg_names,
             p.proargmodes::text[] AS arg_modes,
             p.pronargs,
             p.pronargdefaults,
             p.proretset,
             format_type(p.prorettype, NULL) AS ret_type
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'
        AND format_type(p.prorettype, NULL) <> 'trigger'
    `);

    const tables = new Map<string, TableInfo>();
    for (const r of cols.rows) {
      let t = tables.get(r.table_name);
      if (!t) {
        t = { name: r.table_name, columns: new Map(), primaryKey: [] };
        tables.set(r.table_name, t);
      }
      t.columns.set(r.column_name, {
        name: r.column_name,
        type: r.data_type,
        category: r.typcategory,
        isJson: r.typname === "json" || r.typname === "jsonb",
        isArray: r.typcategory === "A",
        generated: r.generated,
      });
    }
    for (const r of pks.rows) {
      const t = tables.get(r.table_name);
      if (t) t.primaryKey = r.columns;
    }

    const functions = new Map<string, FunctionInfo[]>();
    for (const r of fns.rows) {
      // proargnames covers all args (incl. OUT) when proargmodes is set;
      // keep only the input ones (i = IN, b = INOUT, v = VARIADIC).
      let names: string[];
      if (r.arg_modes) {
        names = (r.arg_names ?? []).filter((_, i) => ["i", "b", "v"].includes(r.arg_modes![i]));
      } else {
        names = (r.arg_names ?? []).slice(0, r.pronargs);
      }
      const info: FunctionInfo = {
        name: r.proname,
        argNames: names,
        argTypes: r.arg_types,
        nDefaults: r.pronargdefaults,
        returnsSet: r.proretset,
        returnType: r.ret_type,
      };
      const list = functions.get(r.proname) ?? [];
      list.push(info);
      functions.set(r.proname, list);
    }

    return {
      tables,
      foreignKeys: fks.rows.map((r) => ({
        name: r.name,
        table: r.table_name,
        columns: r.columns,
        refTable: r.ref_table,
        refColumns: r.ref_columns,
      })),
      functions,
    };
  } finally {
    client.release();
  }
}
