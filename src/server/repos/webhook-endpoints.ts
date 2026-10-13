// Outbound webhook endpoints — management side (public /api/v1/webhooks).
// Runs under asService (API-key callers have no session), so every
// query is scoped by account_id explicitly. The encrypted `secret` is
// never selected here.

import type { Db } from "@/server/db";

/** Everything except the (encrypted) `secret`. */
export const WEBHOOK_ENDPOINT_PUBLIC_COLUMNS = [
  "id",
  "url",
  "events",
  "is_active",
  "last_delivery_at",
  "failure_count",
  "created_at",
] as const;

export function listWebhookEndpoints(db: Db, accountId: string) {
  return db
    .selectFrom("webhook_endpoints")
    .select(WEBHOOK_ENDPOINT_PUBLIC_COLUMNS)
    .where("account_id", "=", accountId)
    .orderBy("created_at", "desc")
    .execute();
}

export function getWebhookEndpoint(db: Db, accountId: string, id: string) {
  return db
    .selectFrom("webhook_endpoints")
    .select(WEBHOOK_ENDPOINT_PUBLIC_COLUMNS)
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}

export function createWebhookEndpoint(
  db: Db,
  values: { account_id: string; created_by: string | null; url: string; secret: string; events: string[] },
) {
  return db
    .insertInto("webhook_endpoints")
    .values(values)
    .returning(WEBHOOK_ENDPOINT_PUBLIC_COLUMNS)
    .executeTakeFirstOrThrow();
}

export interface WebhookEndpointUpdate {
  url?: string;
  events?: string[];
  is_active?: boolean;
  failure_count?: number;
}

/** Returns the updated row, or undefined when the id isn't in the account. */
export function updateWebhookEndpoint(db: Db, accountId: string, id: string, update: WebhookEndpointUpdate) {
  return db
    .updateTable("webhook_endpoints")
    .set(update)
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .returning(WEBHOOK_ENDPOINT_PUBLIC_COLUMNS)
    .executeTakeFirst();
}

/** Returns the deleted id, or undefined when the id isn't in the account. */
export async function deleteWebhookEndpoint(db: Db, accountId: string, id: string): Promise<string | undefined> {
  const row = await db
    .deleteFrom("webhook_endpoints")
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .returning("id")
    .executeTakeFirst();
  return row?.id;
}
