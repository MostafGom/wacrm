// Creates a fresh database, replays every migration, and exposes
// connection strings to the test workers via `inject()`.

import { execFileSync } from "node:child_process";
import path from "node:path";

import pg from "pg";
import type { TestProject } from "vitest/node";

const DB_NAME = "wacrm_it";
const APP_PASSWORD = "wacrm-it-app";

declare module "vitest" {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
    appDatabaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) {
    throw new Error(
      "TEST_DATABASE_URL is not set (superuser connection to a Postgres 17 + pgvector server)",
    );
  }

  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  const url = new URL(base);
  url.pathname = `/${DB_NAME}`;
  const adminDatabaseUrl = url.toString();

  execFileSync(process.execPath, [path.resolve("scripts/migrate.mjs")], {
    env: { ...process.env, MIGRATION_DATABASE_URL: adminDatabaseUrl, APP_DB_PASSWORD: APP_PASSWORD },
    stdio: "pipe",
  });

  const appUrl = new URL(adminDatabaseUrl);
  appUrl.username = "wacrm_app";
  appUrl.password = APP_PASSWORD;

  project.provide("adminDatabaseUrl", adminDatabaseUrl);
  project.provide("appDatabaseUrl", appUrl.toString());
}
