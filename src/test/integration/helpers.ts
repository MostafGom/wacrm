// Shared fixtures for *.int.test.ts files.

import { randomUUID } from "node:crypto";

import pg from "pg";
import { inject } from "vitest";

import { refreshCatalog } from "@/lib/db/catalog";
import { closePool } from "@/server/db/pool";
import { createServerDb } from "@/lib/db/server-client";
import type { DbClient } from "@/lib/db/types";

/** Point the app pool at the integration database (call in beforeAll). */
export function useIntegrationDb(): void {
  process.env.DATABASE_URL = inject("appDatabaseUrl");
  refreshCatalog();
}

export async function teardownIntegrationDb(): Promise<void> {
  await closePool();
}

/** Superuser client for seeding / assertions that must bypass everything. */
export async function withSuperuser<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: inject("adminDatabaseUrl") });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export interface SeededUser {
  id: string;
  email: string;
  accountId: string;
}

/** Insert an auth user; the handle_new_user trigger creates account + owner profile. */
export async function seedUser(name = "User"): Promise<SeededUser> {
  const id = randomUUID();
  const email = `${id.slice(0, 8)}@example.test`;
  return withSuperuser(async (c) => {
    await c.query(
      "INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES ($1, $2, $3, now())",
      [id, email, JSON.stringify({ full_name: name })],
    );
    const r = await c.query("SELECT account_id FROM public.profiles WHERE user_id = $1", [id]);
    return { id, email, accountId: r.rows[0].account_id };
  });
}

/** Move `user` into `accountId` with `role` (bypasses the RPC guard). */
export async function joinAccount(userId: string, accountId: string, role: string): Promise<void> {
  await withSuperuser(async (c) => {
    await c.query("SET session_replication_role = replica");
    await c.query("UPDATE public.profiles SET account_id = $1, account_role = $2 WHERE user_id = $3", [
      accountId,
      role,
      userId,
    ]);
  });
}

export function userDb(userId: string): DbClient {
  return createServerDb({ role: "authenticated", userId });
}

export function serviceDb(): DbClient {
  return createServerDb({ role: "service_role", userId: null });
}
