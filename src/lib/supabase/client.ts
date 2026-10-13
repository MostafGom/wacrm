// Browser client. Same `createClient()` entry point as before, now
// backed by this app's own endpoints instead of Supabase:
//   .from() / .rpc()  → POST /api/db (runs under the user's RLS)
//   .auth             → /api/auth/*
//   .storage          → /api/storage/*
//   .channel()        → SSE stream at /api/realtime
import { QueryBuilder, makeRpc } from '@/lib/db/builder'
import { createAuthClient } from '@/lib/db/auth-client'
import { httpExecutor } from '@/lib/db/browser'
import type { DbClient } from '@/lib/db/types'
import { createChannel, removeChannel } from '@/lib/realtime/client'
import { createBrowserStorage } from '@/lib/storage/client'

// Singleton — one client (and one auth state) per browser tab.
let browserClient: DbClient | undefined

export function createClient(): DbClient {
  if (browserClient) return browserClient

  browserClient = {
    from: (table: string) => new QueryBuilder(table, httpExecutor),
    rpc: makeRpc(httpExecutor),
    auth: createAuthClient(),
    storage: createBrowserStorage(),
    channel: createChannel,
    removeChannel,
  }

  return browserClient
}
