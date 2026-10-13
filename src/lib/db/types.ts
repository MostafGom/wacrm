/* eslint-disable @typescript-eslint/no-explicit-any -- results are untyped `any`, exactly like an untyped supabase-js client; callers cast to their own types. */
// ============================================================
// Public client surface — the shape the app codes against.
//
// It intentionally mirrors the subset of supabase-js the codebase
// uses, so `SupabaseClient` is exported as an alias: existing call
// sites (`supabase.from(...)`, `.rpc(...)`, `.auth.getUser()`,
// `.storage.from(...)`, `.channel(...)`) keep compiling and working.
// ============================================================

import type { DbError, DbResult } from "./ast";
import type { QueryBuilder, makeRpc } from "./builder";

import type { AuthApi, AuthChangeEvent, AuthError, Session, User } from "@/lib/auth/types";
import type { StorageApi } from "@/lib/storage/types";

export type { AuthApi, AuthChangeEvent, AuthError, Session, User };
export type { FileOptions, StorageApi, StorageBucketApi, StorageError } from "@/lib/storage/types";


import type { RealtimeChannel } from "@/lib/realtime/types";
export type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
  RealtimeStatus,
} from "@/lib/realtime/types";

// ---------------- client ----------------

export interface DbClient {
  from(table: string): QueryBuilder;
  rpc: ReturnType<typeof makeRpc>;
  auth: AuthApi;
  storage: StorageApi;
  channel(name: string): RealtimeChannel;
  removeChannel(channel: RealtimeChannel): Promise<"ok" | "error">;
}

/** Drop-in name for code that used `import type { SupabaseClient } from '@/lib/db'`. */
export type SupabaseClient = DbClient;
export type PostgrestError = DbError;
export type { DbError, DbResult };
