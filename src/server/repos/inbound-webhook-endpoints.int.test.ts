import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService } from "@/server/db";
import {
  listActiveEndpointsForEvent,
  markEndpointDelivered,
  recordWebhookFailure,
} from "@/server/repos/inbound-webhook-endpoints";
import { seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let a: SeededUser;
let b: SeededUser;
let endpointId: string;

beforeAll(async () => {
  useIntegrationDb();
  a = await seedUser("A");
  b = await seedUser("B");
  endpointId = await asService(async (db) => {
    const rows = await db
      .insertInto("webhook_endpoints")
      .values([
        { account_id: a.accountId, url: "https://a.test/1", secret: "s", events: ["message.received"] },
        { account_id: a.accountId, url: "https://a.test/2", secret: "s", events: ["conversation.created"] },
        {
          account_id: a.accountId,
          url: "https://a.test/off",
          secret: "s",
          events: ["message.received"],
          is_active: false,
        },
        { account_id: b.accountId, url: "https://b.test/1", secret: "s", events: ["message.received"] },
      ])
      .returning(["id", "url"])
      .execute();
    return rows.find((r) => r.url === "https://a.test/1")!.id;
  });
});

afterAll(teardownIntegrationDb);

const state = () =>
  asService((db) =>
    db
      .selectFrom("webhook_endpoints")
      .select(["failure_count", "is_active", "last_delivery_at"])
      .where("id", "=", endpointId)
      .executeTakeFirstOrThrow(),
  );

describe("inbound-webhook-endpoints repo", () => {
  it("lists the account's active endpoints subscribed to the event", async () => {
    const rows = await asService((db) => listActiveEndpointsForEvent(db, a.accountId, "message.received"));
    expect(rows).toEqual([{ id: endpointId, url: "https://a.test/1", secret: "s" }]);
  });

  it("counts failures atomically, auto-disables at the threshold, and a success resets", async () => {
    await asService((db) => recordWebhookFailure(db, endpointId, 3));
    expect(await state()).toMatchObject({ failure_count: 1, is_active: true });

    // markEndpointDelivered is account-scoped.
    await asService((db) => markEndpointDelivered(db, b.accountId, endpointId));
    expect((await state()).failure_count).toBe(1);
    await asService((db) => markEndpointDelivered(db, a.accountId, endpointId));
    const ok = await state();
    expect(ok.failure_count).toBe(0);
    expect(ok.last_delivery_at).not.toBeNull();

    for (let i = 0; i < 3; i++) await asService((db) => recordWebhookFailure(db, endpointId, 3));
    expect(await state()).toMatchObject({ failure_count: 3, is_active: false });
  });
});
