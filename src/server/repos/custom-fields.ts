// Account-wide custom contact field definitions.

import type { Db } from "@/server/db";

export function listCustomFields(db: Db, accountId: string) {
  return db
    .selectFrom("custom_fields")
    .selectAll()
    .where("account_id", "=", accountId)
    .orderBy("field_name")
    .execute();
}

export function createCustomField(
  db: Db,
  values: { account_id: string; user_id: string; field_name: string; field_type?: string },
) {
  return db.insertInto("custom_fields").values(values).returningAll().executeTakeFirstOrThrow();
}

export function renameCustomField(db: Db, accountId: string, id: string, fieldName: string) {
  return db
    .updateTable("custom_fields")
    .set({ field_name: fieldName })
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .returningAll()
    .executeTakeFirst();
}

export async function deleteCustomField(db: Db, accountId: string, id: string): Promise<boolean> {
  const r = await db.deleteFrom("custom_fields").where("id", "=", id).where("account_id", "=", accountId).executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}
