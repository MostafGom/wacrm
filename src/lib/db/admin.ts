// ============================================================
// Service-role client — bypasses RLS (role `service_role` is
// BYPASSRLS, see db/migrations/000). Replaces the
// `createClient(SUPABASE_URL, SERVICE_ROLE_KEY)` copies that used to
// live in each engine module.
//
// Use only for trusted server work: webhooks, engines, crons, API-key
// routes (which scope by account_id by hand).
// ============================================================

import { createServerDb } from "./server-client";
import type { DbClient } from "./types";
import { adminStorage } from "@/lib/storage/server";

let _admin: DbClient | null = null;

export function supabaseAdmin(): DbClient {
  if (!_admin) {
    _admin = createServerDb({
      role: "service_role",
      userId: null,
      storage: adminStorage(),
      timeoutMs: 60_000,
    });
  }
  return _admin;
}
