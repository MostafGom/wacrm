// Member presence (online / away heartbeats, migration 024).

import { sql, type Db } from "@/server/db";

export type StoredPresence = "online" | "away";

export function listPresence(db: Db, accountId: string) {
  return db
    .selectFrom("member_presence")
    .select(["user_id", "status", "last_seen_at"])
    .where("account_id", "=", accountId)
    .execute();
}

/** Heartbeat via the SECURITY DEFINER RPC, which stamps the caller (auth.uid()). */
export async function touchPresence(db: Db, status: StoredPresence): Promise<void> {
  await sql`SELECT public.touch_presence(${status})`.execute(db);
}
