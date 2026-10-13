// The caller's account row and their own profile (self-service fields).

import type { Db } from "@/server/db";

/** Rename an account. Returns the updated `{ id, name }`, or undefined when no row matched / RLS hid it. */
export function renameAccount(db: Db, accountId: string, name: string) {
  return db
    .updateTable("accounts")
    .set({ name })
    .where("id", "=", accountId)
    .returning(["id", "name"])
    .executeTakeFirst();
}

/**
 * Update the caller's own profile (display name + avatar). Only the
 * self-service columns are written; account_id / account_role are
 * guarded by the enforce_profile_privilege_columns trigger anyway.
 */
export async function updateOwnProfile(
  db: Db,
  userId: string,
  values: { full_name: string; avatar_url: string | null },
): Promise<boolean> {
  const r = await db
    .updateTable("profiles")
    .set({ full_name: values.full_name, avatar_url: values.avatar_url })
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}
