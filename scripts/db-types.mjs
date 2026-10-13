#!/usr/bin/env node
// Regenerate src/server/db/schema.gen.ts from a migrated database.
//   MIGRATION_DATABASE_URL=postgres://postgres:...@localhost:5432/wacrm npm run db:types
// Pass --verify to fail (exit 1) when the committed file is stale (CI).
//
// A superuser URL is required: information_schema only shows columns
// the connecting role has privileges on, and `wacrm_app` has none.

import { spawnSync } from "node:child_process";

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL is not set");
  process.exit(1);
}

const args = [
  "kysely-codegen",
  "--dialect", "postgres",
  "--url", url,
  "--default-schema", "public",
  "--include-pattern", "{public,auth,storage}.*",
  // Match the runtime type parsers in src/server/db/pool.ts.
  "--date-parser", "string",
  "--numeric-parser", "number",
  "--type-mapping", JSON.stringify({ int8: "number", timestamptz: "string", timestamp: "string", date: "string" }),
  "--out-file", "src/server/db/schema.gen.ts",
  ...process.argv.slice(2),
];

const r = spawnSync("npx", args, { stdio: "inherit" });
process.exit(r.status ?? 1);
