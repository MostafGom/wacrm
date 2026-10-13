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

// ---------------- auth ----------------

export interface User {
  id: string;
  email: string | null;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
  email_confirmed_at: string | null;
  created_at: string;
  last_sign_in_at: string | null;
}

export interface Session {
  user: User;
}

export interface AuthError {
  message: string;
  code: string;
  status: number;
}

export type AuthChangeEvent =
  | "INITIAL_SESSION"
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "USER_UPDATED"
  | "PASSWORD_RECOVERY"
  | "TOKEN_REFRESHED";

export interface AuthApi {
  getUser(): Promise<{ data: { user: User | null }; error: AuthError | null }>;
  getSession(): Promise<{ data: { session: Session | null }; error: AuthError | null }>;
  onAuthStateChange(cb: (event: AuthChangeEvent, session: Session | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
  signInWithPassword(creds: { email: string; password: string }): Promise<{
    data: { user: User | null; session: Session | null };
    error: AuthError | null;
  }>;
  signUp(input: {
    email: string;
    password: string;
    options?: { data?: Record<string, unknown>; emailRedirectTo?: string };
  }): Promise<{ data: { user: User | null; session: Session | null }; error: AuthError | null }>;
  signOut(opts?: { scope?: "global" | "local" | "others" }): Promise<{ error: AuthError | null }>;
  updateUser(attrs: { email?: string; password?: string; data?: Record<string, unknown> }): Promise<{
    data: { user: User | null };
    error: AuthError | null;
  }>;
  resetPasswordForEmail(
    email: string,
    opts?: { redirectTo?: string },
  ): Promise<{ data: Record<string, never> | null; error: AuthError | null }>;
}

// ---------------- storage ----------------

export interface StorageError {
  message: string;
  statusCode?: string;
}

export interface FileOptions {
  contentType?: string;
  cacheControl?: string;
  upsert?: boolean;
}

export interface StorageBucketApi {
  upload(
    path: string,
    body: Blob | ArrayBuffer | ArrayBufferView | Buffer,
    opts?: FileOptions,
  ): Promise<{ data: { path: string; fullPath: string } | null; error: StorageError | null }>;
  getPublicUrl(path: string): { data: { publicUrl: string } };
  remove(paths: string[]): Promise<{ data: { name: string }[] | null; error: StorageError | null }>;
}

export interface StorageApi {
  from(bucket: string): StorageBucketApi;
}

// ---------------- realtime ----------------

export interface RealtimePostgresChangesPayload<T = Record<string, any>> {
  schema: string;
  table: string;
  commit_timestamp: string;
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
  errors: null;
}

export type RealtimeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

export interface RealtimeChannel {
  on(
    type: "postgres_changes",
    filter: { event: "*" | "INSERT" | "UPDATE" | "DELETE"; schema?: string; table: string; filter?: string },
    callback: (payload: RealtimePostgresChangesPayload<any>) => void,
  ): RealtimeChannel;
  subscribe(cb?: (status: RealtimeStatus, err?: Error) => void): RealtimeChannel;
  unsubscribe(): Promise<"ok">;
}

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
