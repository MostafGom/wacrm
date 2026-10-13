// Profiles + account membership lookups.

import type { Db } from "@/server/db";

export const PROFILE_COLUMNS = [
  "id",
  "user_id",
  "full_name",
  "email",
  "avatar_url",
  "role",
  "beta_features",
  "account_id",
  "account_role",
] as const;

export function getProfileByUserId(db: Db, userId: string) {
  return db.selectFrom("profiles").select(PROFILE_COLUMNS).where("user_id", "=", userId).executeTakeFirst();
}

export function getAccountSummary(db: Db, accountId: string) {
  return db
    .selectFrom("accounts")
    .select(["id", "name", "default_currency"])
    .where("id", "=", accountId)
    .executeTakeFirst();
}

/** Members of an account (profiles), for pickers / rosters. */
export function listAccountProfiles(db: Db, accountId: string) {
  return db
    .selectFrom("profiles")
    .select(["id", "user_id", "full_name", "email", "avatar_url", "account_role", "created_at"])
    .where("account_id", "=", accountId)
    .orderBy("full_name")
    .execute();
}
