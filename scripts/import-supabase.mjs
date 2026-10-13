#!/usr/bin/env node
// ============================================================
// One-shot import of an existing Supabase-hosted wacrm into a
// self-hosted Postgres.
//
// Copies, in one target transaction:
//   * auth.users       (bcrypt password hashes are kept — people log
//                       in with their existing passwords; the hash is
//                       upgraded to scrypt on first login)
//   * every public.*   table (columns present on both sides)
//   * storage.buckets / storage.objects metadata
// then downloads every stored file through the Supabase Storage API
// and rewrites stored Supabase public URLs to this deployment.
//
// Usage (from a source checkout, after `npm ci`):
//
//   SOURCE_DATABASE_URL=postgres://postgres.<ref>:<pw>@<host>:5432/postgres \
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   MIGRATION_DATABASE_URL=postgres://postgres:<pw>@localhost:5432/wacrm \
//   PUBLIC_URL=https://crm.example.com \
//   STORAGE_DIR=./storage            # or STORAGE_DRIVER=s3 + S3_* vars
//   node scripts/import-supabase.mjs [--force] [--skip-files] [--dry-run]
//
//   --force       wipe existing data in the target first
//   --skip-files  copy rows only (files can be fetched later by re-running
//                 with --files-only)
//   --files-only  only download storage objects + rewrite URLs
//
// The target must already be migrated (`npm run db:migrate`). Use the
// SAME ENCRYPTION_KEY as the old deployment — WhatsApp tokens, AI keys
// and webhook secrets are stored encrypted with it.
// ============================================================

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import pg from "pg";
import copyStreams from "pg-copy-streams";

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const SKIP_FILES = args.has("--skip-files");
const FILES_ONLY = args.has("--files-only");
const DRY = args.has("--dry-run");

const env = (k, required = true) => {
  const v = process.env[k];
  if (required && !v) {
    console.error(`missing env ${k}`);
    process.exit(1);
  }
  return v;
};

const SOURCE = env("SOURCE_DATABASE_URL", !FILES_ONLY);
const TARGET = env("MIGRATION_DATABASE_URL");
const SUPABASE_URL = env("SUPABASE_URL", !SKIP_FILES)?.replace(/\/+$/, "");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY", !SKIP_FILES);
const PUBLIC_URL = env("PUBLIC_URL")?.replace(/\/+$/, "");

const log = (...a) => console.log("[import]", ...a);

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------

async function columns(client, schema, table) {
  const r = await client.query(
    `SELECT a.attname AS name, a.attgenerated <> '' AS generated
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, table],
  );
  return r.rows;
}

/** public tables of the target in FK dependency order (parents first). */
async function tablesInOrder(client) {
  const t = await client.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY c.relname`,
  );
  const names = t.rows.map((r) => r.relname);
  const deps = new Map(names.map((n) => [n, new Set()]));
  const fk = await client.query(
    `SELECT c.relname AS child, p.relname AS parent
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace cn ON cn.oid = c.relnamespace
       JOIN pg_class p ON p.oid = con.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
      WHERE con.contype = 'f' AND cn.nspname = 'public' AND pn.nspname = 'public' AND c.relname <> p.relname`,
  );
  for (const { child, parent } of fk.rows) deps.get(child)?.add(parent);
  const out = [];
  const seen = new Set();
  const visit = (n, stack = new Set()) => {
    if (seen.has(n)) return;
    if (stack.has(n)) return; // cycle — order doesn't matter with triggers off
    stack.add(n);
    for (const d of deps.get(n) ?? []) visit(d, stack);
    seen.add(n);
    out.push(n);
  };
  names.forEach((n) => visit(n));
  return out;
}

const q = (s) => `"${s.replace(/"/g, '""')}"`;

async function copyTable(src, dst, schema, table, cols, where = "") {
  const list = cols.map(q).join(", ");
  const from = src.query(copyStreams.to(`COPY (SELECT ${list} FROM ${q(schema)}.${q(table)} ${where}) TO STDOUT`));
  const into = dst.query(copyStreams.from(`COPY ${q(schema)}.${q(table)} (${list}) FROM STDIN`));
  await pipeline(from, into);
  return into.rowCount;
}

// ------------------------------------------------------------
// storage writer (local disk or S3, same layout as src/lib/storage)
// ------------------------------------------------------------

async function makeWriter() {
  if ((process.env.STORAGE_DRIVER ?? "local") === "s3") {
    const s3 = await import("@aws-sdk/client-s3");
    const client = new s3.S3Client({
      region: process.env.S3_REGION ?? "us-east-1",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: process.env.S3_ACCESS_KEY_ID
        ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
        : undefined,
    });
    const Bucket = env("S3_BUCKET");
    return {
      async exists(bucket, key, size) {
        try {
          const h = await client.send(new s3.HeadObjectCommand({ Bucket, Key: `${bucket}/${key}` }));
          return Number(h.ContentLength) === size;
        } catch {
          return false;
        }
      },
      async put(bucket, key, body, contentType) {
        await client.send(new s3.PutObjectCommand({ Bucket, Key: `${bucket}/${key}`, Body: body, ContentType: contentType }));
      },
    };
  }
  const root = path.resolve(process.env.STORAGE_DIR ?? ".data/storage");
  const file = (bucket, key) => {
    const full = path.resolve(root, bucket, ...key.split("/"));
    if (!full.startsWith(root + path.sep)) throw new Error(`unsafe object path ${bucket}/${key}`);
    return full;
  };
  return {
    async exists(bucket, key, size) {
      try {
        return (await stat(file(bucket, key))).size === size;
      } catch {
        return false;
      }
    },
    async put(bucket, key, body) {
      const f = file(bucket, key);
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(`${f}.part`, body);
      await rename(`${f}.part`, f);
    },
  };
}

// ------------------------------------------------------------
// main
// ------------------------------------------------------------

async function importRows(src, dst) {
  const migrated = await dst.query(
    "SELECT 1 FROM _wacrm.schema_migrations WHERE version LIKE '048_%'",
  ).catch(() => ({ rowCount: 0 }));
  if (!migrated.rowCount) throw new Error("target is not migrated — run `npm run db:migrate` first");

  const existing = await dst.query("SELECT count(*)::int AS n FROM auth.users");
  if (existing.rows[0].n > 0 && !FORCE) {
    throw new Error(`target already has ${existing.rows[0].n} users — re-run with --force to wipe it`);
  }

  const tables = await tablesInOrder(dst);
  const report = [];

  await dst.query("BEGIN");
  try {
    // Disables triggers (signup bootstrap, realtime NOTIFY, updated_at)
    // and FK checks for the bulk copy. Superuser only.
    await dst.query("SET LOCAL session_replication_role = replica");

    if (FORCE) {
      log("wiping target data");
      await dst.query(`TRUNCATE ${tables.map((t) => `public.${q(t)}`).join(", ")}, storage.objects, auth.sessions, auth.one_time_tokens, auth.users CASCADE`);
    }

    // --- auth.users ---------------------------------------------
    const targetUserCols = (await columns(dst, "auth", "users")).map((c) => c.name);
    const sourceUserCols = new Set((await columns(src, "auth", "users")).map((c) => c.name));
    const userCols = targetUserCols.filter((c) => sourceUserCols.has(c));
    const anon = sourceUserCols.has("is_anonymous") ? "WHERE NOT coalesce(is_anonymous, false)" : "";
    const nUsers = await copyTable(src, dst, "auth", "users", userCols, anon);
    report.push(["auth.users", nUsers]);

    // --- public tables ------------------------------------------
    for (const t of tables) {
      const tgt = (await columns(dst, "public", t)).filter((c) => !c.generated).map((c) => c.name);
      const srcCols = new Set((await columns(src, "public", t)).map((c) => c.name));
      if (srcCols.size === 0) {
        report.push([`public.${t}`, "absent in source"]);
        continue;
      }
      const common = tgt.filter((c) => srcCols.has(c));
      const n = await copyTable(src, dst, "public", t, common);
      report.push([`public.${t}`, n]);
    }

    // --- storage metadata ---------------------------------------
    const b = await src.query(
      "SELECT id, name, public, file_size_limit, allowed_mime_types FROM storage.buckets",
    );
    for (const row of b.rows) {
      await dst.query(
        `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public,
           file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types`,
        [row.id, row.name, row.public, row.file_size_limit, row.allowed_mime_types],
      );
    }
    const n = await copyTable(src, dst, "storage", "objects", ["id", "bucket_id", "name", "owner", "metadata", "created_at", "updated_at"]);
    report.push(["storage.objects", n]);

    if (DRY) {
      await dst.query("ROLLBACK");
      log("dry run — rolled back");
    } else {
      await dst.query("COMMIT");
    }
  } catch (err) {
    await dst.query("ROLLBACK").catch(() => {});
    throw err;
  }
  console.table(report.map(([table, rows]) => ({ table, rows })));
}

async function importFiles(dst) {
  const writer = await makeWriter();
  const objects = (await dst.query("SELECT bucket_id, name, metadata FROM storage.objects ORDER BY bucket_id, name")).rows;
  log(`downloading ${objects.length} objects`);
  let done = 0;
  let skipped = 0;
  const failed = [];
  const queue = [...objects];
  const worker = async () => {
    for (let o = queue.shift(); o; o = queue.shift()) {
      const size = Number(o.metadata?.size ?? -1);
      try {
        if (size >= 0 && (await writer.exists(o.bucket_id, o.name, size))) {
          skipped++;
          continue;
        }
        const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(o.bucket_id)}/${o.name.split("/").map(encodeURIComponent).join("/")}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        if (!DRY) await writer.put(o.bucket_id, o.name, body, o.metadata?.mimetype ?? res.headers.get("content-type"));
        if (size < 0 && !DRY) {
          await dst.query(
            "UPDATE storage.objects SET metadata = metadata || jsonb_build_object('size', $3::bigint) WHERE bucket_id = $1 AND name = $2",
            [o.bucket_id, o.name, body.length],
          );
        }
        done++;
      } catch (err) {
        failed.push(`${o.bucket_id}/${o.name}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  log(`files: ${done} downloaded, ${skipped} already present, ${failed.length} failed`);
  for (const f of failed.slice(0, 20)) log(`  failed ${f}`);
}

async function rewriteUrls(dst) {
  if (!SUPABASE_URL || !PUBLIC_URL) return;
  const from = `${SUPABASE_URL}/storage/v1/object/public/`;
  const to = `${PUBLIC_URL}/api/storage/public/`;
  const cols = await dst.query(
    `SELECT c.relname AS t, a.attname AS col, format_type(a.atttypid, NULL) AS type
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attgenerated = '' AND format_type(a.atttypid, NULL) IN ('text', 'character varying', 'jsonb', 'json')`,
  );
  await dst.query("BEGIN");
  await dst.query("SET LOCAL session_replication_role = replica");
  let total = 0;
  for (const { t, col, type } of cols.rows) {
    const isJson = type === "jsonb" || type === "json";
    const expr = isJson ? `replace(${q(col)}::text, $1, $2)::${type}` : `replace(${q(col)}, $1, $2)`;
    const where = isJson ? `${q(col)}::text LIKE '%' || $1 || '%'` : `${q(col)} LIKE '%' || $1 || '%'`;
    const r = await dst.query(`UPDATE public.${q(t)} SET ${q(col)} = ${expr} WHERE ${where}`, [from, to]);
    if (r.rowCount) log(`rewrote ${r.rowCount} URL(s) in ${t}.${col}`);
    total += r.rowCount;
  }
  await dst.query(DRY ? "ROLLBACK" : "COMMIT");
  log(`URL rewrite: ${total} row(s) updated`);
}

const dst = new pg.Client({ connectionString: TARGET });
const src = SOURCE ? new pg.Client({ connectionString: SOURCE }) : null;

try {
  await dst.connect();
  if (!FILES_ONLY) {
    await src.connect();
    log("copying rows");
    await importRows(src, dst);
  }
  if (!SKIP_FILES) await importFiles(dst);
  await rewriteUrls(dst);
  log("done.");
  log("Reminders: keep the same ENCRYPTION_KEY; users must sign in again (sessions are not migrated);");
  log("update the WhatsApp webhook URL in Meta if the domain changed.");
} catch (err) {
  console.error("[import] failed:", err.message ?? err);
  process.exitCode = 1;
} finally {
  await src?.end().catch(() => {});
  await dst.end().catch(() => {});
}
