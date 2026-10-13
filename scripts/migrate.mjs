#!/usr/bin/env node
// ============================================================
// Migration runner — applies db/migrations/*.sql in filename order.
//
//   node scripts/migrate.mjs            apply pending migrations
//   node scripts/migrate.mjs status     list applied / pending
//   node scripts/migrate.mjs --dry-run  show what would run
//   node scripts/migrate.mjs --baseline 046
//                                       mark everything up to and
//                                       including 046 as applied
//                                       without running it (adopting
//                                       an imported database)
//
// Env:
//   MIGRATION_DATABASE_URL  superuser connection (required; falls back
//                           to DATABASE_URL for local hacking)
//   APP_DB_PASSWORD         if set, (re)sets the password of the
//                           `wacrm_app` login role the app uses
//
// Each file runs in its own transaction unless its first line is
// `-- migrate:no-transaction`. A pg advisory lock serialises
// concurrent runners (e.g. two app replicas booting at once).
// ============================================================

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? path.resolve(__dirname, "..", "db", "migrations");
const LOCK_KEY = 0x7761636d; // "wacm"

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--")) ?? "up";
const dryRun = args.includes("--dry-run");
const baselineIdx = args.indexOf("--baseline");
const baseline = baselineIdx >= 0 ? args[baselineIdx + 1] : null;

const connectionString =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  console.error("MIGRATION_DATABASE_URL is not set");
  process.exit(1);
}

function versionOf(file) {
  return file.replace(/\.sql$/, "");
}

async function loadMigrations() {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      return {
        version: versionOf(file),
        file,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
        noTransaction: /^--\s*migrate:no-transaction/.test(sql),
      };
    }),
  );
}

async function main() {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);

    await client.query(`
      CREATE SCHEMA IF NOT EXISTS _wacrm;
      CREATE TABLE IF NOT EXISTS _wacrm.schema_migrations (
        version     TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const migrations = await loadMigrations();
    const { rows } = await client.query(
      "SELECT version, checksum FROM _wacrm.schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const m of migrations) {
      const prev = applied.get(m.version);
      if (prev && prev !== m.checksum) {
        console.warn(`! ${m.file} changed since it was applied (checksum drift)`);
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.version));

    if (command === "status") {
      for (const m of migrations) {
        console.log(`${applied.has(m.version) ? "applied" : "pending"}  ${m.file}`);
      }
      return;
    }

    if (baseline) {
      const toMark = pending.filter((m) => m.version.split("_")[0] <= baseline);
      for (const m of toMark) {
        if (!dryRun) {
          await client.query(
            "INSERT INTO _wacrm.schema_migrations (version, checksum) VALUES ($1, $2)",
            [m.version, m.checksum],
          );
        }
        console.log(`baselined ${m.file}`);
      }
      return;
    }

    if (pending.length === 0) {
      console.log("Database is up to date.");
    }

    for (const m of pending) {
      if (dryRun) {
        console.log(`would apply ${m.file}`);
        continue;
      }
      process.stdout.write(`applying ${m.file} ... `);
      const started = Date.now();
      try {
        if (!m.noTransaction) await client.query("BEGIN");
        await client.query(m.sql);
        await client.query(
          "INSERT INTO _wacrm.schema_migrations (version, checksum) VALUES ($1, $2)",
          [m.version, m.checksum],
        );
        if (!m.noTransaction) await client.query("COMMIT");
      } catch (err) {
        if (!m.noTransaction) await client.query("ROLLBACK").catch(() => {});
        console.log("FAILED");
        throw err;
      }
      console.log(`ok (${Date.now() - started} ms)`);
    }

    if (!dryRun && process.env.APP_DB_PASSWORD) {
      // Identifiers/literals can't be bound as parameters in ALTER ROLE.
      const { rows: q } = await client.query(
        "SELECT format('ALTER ROLE wacrm_app WITH LOGIN PASSWORD %L', $1::text) AS sql",
        [process.env.APP_DB_PASSWORD],
      );
      await client.query(q[0].sql);
      console.log("wacrm_app password set.");
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  if (err.position) console.error(`  at position ${err.position}`);
  if (err.where) console.error(`  where: ${err.where}`);
  process.exit(1);
});
