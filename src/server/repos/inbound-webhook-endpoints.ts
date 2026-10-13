// Outbound customer webhook endpoints — the delivery side
// (src/lib/webhooks/deliver.ts). Service role: delivery is triggered by
// the inbound Meta webhook, which has no session. The settings CRUD for
// these rows lives with the webhook-endpoints routes.

import { sql, type Db } from "@/server/db";

export interface DeliverableEndpoint {
  id: string;
  url: string;
  /** Encrypted HMAC secret — server-side only, never returned to a browser. */
  secret: string;
}

/** Active endpoints of `accountId` subscribed to `event`. */
export function listActiveEndpointsForEvent(db: Db, accountId: string, event: string): Promise<DeliverableEndpoint[]> {
  return db
    .selectFrom("webhook_endpoints")
    .select(["id", "url", "secret"])
    .where("account_id", "=", accountId)
    .where("is_active", "=", true)
    .where("events", "@>", sql<string[]>`ARRAY[${event}]::text[]`)
    .execute();
}

/** Successful delivery: clear the failure streak and stamp last_delivery_at. */
export async function markEndpointDelivered(db: Db, accountId: string, endpointId: string): Promise<void> {
  await db
    .updateTable("webhook_endpoints")
    .set({ failure_count: 0, last_delivery_at: new Date().toISOString() })
    .where("id", "=", endpointId)
    .where("account_id", "=", accountId)
    .execute();
}

/**
 * Atomic `failure_count + 1` (+ auto-disable at the threshold) via the
 * SECURITY DEFINER function from migration 028 — a read-modify-write
 * would lose increments when two deliveries to the same endpoint run
 * concurrently. The endpoint id comes from an account-scoped read.
 */
export async function recordWebhookFailure(db: Db, endpointId: string, maxFailures: number): Promise<void> {
  await sql`SELECT public.record_webhook_failure(${endpointId}::uuid, ${maxFailures}::int)`.execute(db);
}
