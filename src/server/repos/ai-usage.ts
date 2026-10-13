// AI token-spend log (`ai_usage_log`, migration 033).
//
// There is no `authenticated` INSERT policy — writes go through
// asService. Reads are admin-only by RLS (spend is billing-class).

import type { Db } from "@/server/db";

export interface AiUsageLogInsert {
  account_id: string;
  conversation_id: string | null;
  mode: "auto_reply" | "draft";
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export async function insertAiUsageLog(db: Db, row: AiUsageLogInsert): Promise<void> {
  await db.insertInto("ai_usage_log").values(row).execute();
}

export interface AiUsageRow {
  created_at: string;
  mode: "auto_reply" | "draft";
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Usage rows since `sinceIso`, newest first, at most `limit`. */
export async function listAiUsageSince(
  db: Db,
  accountId: string,
  sinceIso: string,
  limit: number,
): Promise<AiUsageRow[]> {
  const rows = await db
    .selectFrom("ai_usage_log")
    .select(["created_at", "mode", "provider", "model", "prompt_tokens", "completion_tokens", "total_tokens"])
    .where("account_id", "=", accountId)
    .where("created_at", ">=", sinceIso)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  // `mode` is DB-CHECK-constrained to these two values.
  return rows as AiUsageRow[];
}
