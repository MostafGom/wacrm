// Type-only entry point — safe to import from client components.
// Runtime factories live in:
//   @/lib/supabase/server   (session-scoped, server)
//   @/lib/supabase/client   (browser)
//   @/lib/db/admin          (service role, server)
export type {
  AuthApi,
  AuthChangeEvent,
  AuthError,
  DbClient,
  DbError,
  DbResult,
  PostgrestError,
  RealtimeChannel,
  RealtimePostgresChangesPayload,
  Session,
  StorageApi,
  SupabaseClient,
  User,
} from "./types";
