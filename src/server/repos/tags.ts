// Account tag definitions.

import type { Db } from "@/server/db";

export function listTags(db: Db, accountId: string) {
  return db
    .selectFrom("tags")
    .selectAll()
    .where("account_id", "=", accountId)
    .orderBy("name")
    .execute();
}

export function createTag(db: Db, values: { account_id: string; user_id: string; name: string; color: string }) {
  return db.insertInto("tags").values(values).returningAll().executeTakeFirstOrThrow();
}

export async function deleteTag(db: Db, accountId: string, tagId: string): Promise<boolean> {
  const r = await db.deleteFrom("tags").where("id", "=", tagId).where("account_id", "=", accountId).executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}
