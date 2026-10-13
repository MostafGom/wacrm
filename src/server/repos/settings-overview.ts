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
 * Templates and tags are counted for rows the caller authored
 * (`user_id`), custom fields for the whole account — the same numbers
 * the overview tiles have always shown.
 */
export async function getSettingsOverviewCounts(
  db: Db,
  accountId: string,
  userId: string,
): Promise<SettingsOverviewCounts> {
  const [templates, tags, fields, wa] = await Promise.all([
    db
      .selectFrom("message_templates")
      .select((eb) => [
        eb.fn.countAll<string>().as("total"),
        eb.fn.countAll<string>().filterWhere("status", "=", "PENDING").as("pending"),
      ])
      .where("account_id", "=", accountId)
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("tags")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("account_id", "=", accountId)
      .where("user_id", "=", userId)
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
