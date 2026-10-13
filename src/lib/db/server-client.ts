// ============================================================
// Server-side DbClient factory. Queries compile and run in-process
// over the shared pool under the given role.
//
// Server-only: imports pg via execute.ts.
// ============================================================

import type { DbAst } from "./ast";
import { QueryBuilder, makeRpc } from "./builder";
import { execute } from "./execute";
import type { DbRole } from "./tx";
import type { AuthApi, AuthError, DbClient, RealtimeChannel, StorageApi, User } from "./types";

export interface ServerDbOptions {
  role: DbRole;
  userId: string | null;
  /** The session user, surfaced through `.auth.getUser()`. */
  user?: User | null;
  storage?: StorageApi;
  timeoutMs?: number;
}

const unsupported = (what: string): AuthError => ({
  message: `${what} is not available on a server client`,
  code: "not_supported",
  status: 400,
});

function serverAuth(user: User | null): AuthApi {
  return {
    async getUser() {
      return user
        ? { data: { user }, error: null }
        : { data: { user: null }, error: { message: "Auth session missing!", code: "session_missing", status: 401 } };
    },
    async getSession() {
      return { data: { session: user ? { user } : null }, error: null };
    },
    onAuthStateChange() {
      return { data: { subscription: { unsubscribe() {} } } };
    },
    async signInWithPassword() {
      return { data: { user: null, session: null }, error: unsupported("signInWithPassword") };
    },
    async signUp() {
      return { data: { user: null, session: null }, error: unsupported("signUp") };
    },
    async signOut() {
      return { error: unsupported("signOut") };
    },
    async updateUser() {
      return { data: { user: null }, error: unsupported("updateUser") };
    },
    async resetPasswordForEmail() {
      return { data: null, error: unsupported("resetPasswordForEmail") };
    },
  };
}

const noStorage: StorageApi = {
  from() {
    throw new Error("storage is not configured on this client");
  },
};

export function createServerDb(opts: ServerDbOptions): DbClient {
  const exec = (ast: DbAst) =>
    execute(ast, { role: opts.role, userId: opts.userId, timeoutMs: opts.timeoutMs });
  return {
    from: (table: string) => new QueryBuilder(table, exec),
    rpc: makeRpc(exec),
    auth: serverAuth(opts.user ?? null),
    storage: opts.storage ?? noStorage,
    channel(): RealtimeChannel {
      throw new Error("realtime channels are browser-only");
    },
    async removeChannel() {
      return "ok";
    },
  };
}
