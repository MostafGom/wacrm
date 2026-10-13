// In-app notifications. Rows belong to one recipient (user_id); the
// RLS policies from migration 027 enforce the same, these filters
// just make it explicit.

import { sql, type Db } from "@/server/db";

export function listNotifications(db: Db, accountId: string, userId: string, limit = 100) {
  return db
    .selectFrom("notifications")
    .selectAll()
    .where("account_id", "=", accountId)
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}

export async function countUnreadNotifications(db: Db, userId: string): Promise<number> {
  const row = await db
    .selectFrom("notifications")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** Mark one notification read. Returns false when it isn't the caller's / already read. */
export async function markNotificationRead(db: Db, userId: string, id: string): Promise<boolean> {
  const r = await db
    .updateTable("notifications")
    .set({ read_at: sql<string>`now()` })
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

export async function markAllNotificationsRead(db: Db, userId: string): Promise<number> {
  const r = await db
    .updateTable("notifications")
    .set({ read_at: sql<string>`now()` })
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}
