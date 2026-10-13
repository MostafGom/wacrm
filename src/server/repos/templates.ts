// WhatsApp message templates (local copies of Meta templates).

import type { Db } from "@/server/db";

/** All local rows of a template name (one per language) — feed to pickTemplateRow. */
export function listTemplatesByName(db: Db, accountId: string, name: string) {
  return db
    .selectFrom("message_templates")
    .selectAll()
    .where("account_id", "=", accountId)
    .where("name", "=", name)
    .execute();
}
