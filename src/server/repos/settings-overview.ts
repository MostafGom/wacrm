// Cheap counts for the settings landing page (SettingsOverview).

import type { Db } from "@/server/db";

export interface SettingsOverviewCounts {
  templates: number;
  templates_pending: number;
  tags: number;
  custom_fields: number;
  whatsapp_configured: boolean;
}

/**
 * Workspace-wide counts: every member sees the same numbers as the
 * Templates / Fields & tags pages, whoever created the rows.
 */
export async function getSettingsOverviewCounts(db: Db, accountId: string): Promise<SettingsOverviewCounts> {
  const [templates, tags, fields, wa] = await Promise.all([
    db
      .selectFrom("message_templates")
      .select((eb) => [
        eb.fn.countAll<string>().as("total"),
        eb.fn.countAll<string>().filterWhere("status", "=", "PENDING").as("pending"),
      ])
      .where("account_id", "=", accountId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("tags")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("account_id", "=", accountId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("custom_fields")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("account_id", "=", accountId)
      .executeTakeFirstOrThrow(),
    db.selectFrom("whatsapp_config").select("phone_number_id").where("account_id", "=", accountId).executeTakeFirst(),
  ]);
  return {
    templates: Number(templates.total),
    templates_pending: Number(templates.pending),
    tags: Number(tags.n),
    custom_fields: Number(fields.n),
    whatsapp_configured: !!wa?.phone_number_id,
  };
}
