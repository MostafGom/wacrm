// Webhook endpoints repository (public /api/v1/webhooks) against real Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { serializeWebhookEndpoint } from "@/lib/webhooks/endpoints";
import { asService } from "@/server/db";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookEndpoints,
  updateWebhookEndpoint,
} from "@/server/repos/webhook-endpoints";
import { seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let owner: SeededUser;
let other: SeededUser;

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  other = await seedUser("Other");
});

afterAll(teardownIntegrationDb);

describe("webhook-endpoints repo", () => {
  it("creates and reads endpoints without ever selecting the secret", async () => {
    const created = await asService((db) =>
      createWebhookEndpoint(db, {
        account_id: owner.accountId,
        created_by: owner.id,
        url: "https://hooks.example.test/a",
        secret: "encrypted-secret",
        events: ["message.received"],
      }),
    );
    expect(created).not.toHaveProperty("secret");
    expect(Object.keys(serializeWebhookEndpoint(created)).sort()).toEqual(Object.keys(created).sort());
    expect(serializeWebhookEndpoint(created)).toMatchObject({
      url: "https://hooks.example.test/a",
      events: ["message.received"],
      is_active: true,
      last_delivery_at: null,
      failure_count: 0,
    });
    expect(created.created_at).toMatch(/^\d{4}-\d\d-\d\dT.*\+00:00$/);

    expect((await asService((db) => listWebhookEndpoints(db, owner.accountId))).map((r) => r.id)).toEqual([
      created.id,
    ]);
    expect(await asService((db) => listWebhookEndpoints(db, other.accountId))).toEqual([]);
    expect(await asService((db) => getWebhookEndpoint(db, other.accountId, created.id))).toBeUndefined();
  });

  it("update / delete only touch the key's own account", async () => {
    const [ep] = await asService((db) => listWebhookEndpoints(db, owner.accountId));
    expect(await asService((db) => updateWebhookEndpoint(db, other.accountId, ep.id, { is_active: false }))).toBeUndefined();

    const updated = await asService((db) =>
      updateWebhookEndpoint(db, owner.accountId, ep.id, { is_active: false, events: ["message.sent"] }),
    );
    expect(updated).toMatchObject({ is_active: false, events: ["message.sent"] });
    expect(updated).not.toHaveProperty("secret");

    expect(await asService((db) => deleteWebhookEndpoint(db, other.accountId, ep.id))).toBeUndefined();
    expect(await asService((db) => deleteWebhookEndpoint(db, owner.accountId, ep.id))).toBe(ep.id);
    expect(await asService((db) => getWebhookEndpoint(db, owner.accountId, ep.id))).toBeUndefined();
  });
});
