// whatsapp_config repository + settings-overview counts against real Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser } from "@/server/db";
import { getSettingsOverviewCounts } from "@/server/repos/settings-overview";
import {
  deleteWhatsAppConfig,
  getExistingConfigForSave,
  getWhatsAppConfigForClient,
  getWhatsAppConfigRow,
  getWhatsAppCredentials,
  insertWhatsAppConfig,
  isPhoneNumberClaimedElsewhere,
  setMirrorInboundMedia,
  updateWhatsAppConfig,
  type WhatsAppConfigWrite,
} from "@/server/repos/whatsapp-config";
import {
  joinAccount,
  seedUser,
  teardownIntegrationDb,
  useIntegrationDb,
  type SeededUser,
} from "@/test/integration/helpers";

let owner: SeededUser;
let viewer: SeededUser;
let other: SeededUser;

const row = (overrides: Partial<WhatsAppConfigWrite> = {}): WhatsAppConfigWrite => ({
  phone_number_id: "1111",
  waba_id: "2222",
  access_token: "enc-access",
  verify_token: "enc-verify",
  status: "connected",
  connected_at: new Date().toISOString(),
  registered_at: null,
  subscribed_apps_at: null,
  last_registration_error: null,
  updated_at: new Date().toISOString(),
  ...overrides,
});

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  viewer = await seedUser("Viewer");
  other = await seedUser("Other");
  await joinAccount(viewer.id, owner.accountId, "viewer");
});

afterAll(teardownIntegrationDb);

describe("whatsapp-config repo", () => {
  it("admin inserts; members read; the client view hides the tokens", async () => {
    await asUser(owner.id, (db) =>
      insertWhatsAppConfig(db, { account_id: owner.accountId, user_id: owner.id, ...row() }),
    );
    expect(await asUser(viewer.id, (db) => getWhatsAppCredentials(db, owner.accountId))).toMatchObject({
      phone_number_id: "1111",
      access_token: "enc-access",
    });
    expect((await asUser(viewer.id, (db) => getWhatsAppConfigRow(db, owner.accountId)))?.verify_token).toBe("enc-verify");
    expect(await asUser(viewer.id, (db) => getExistingConfigForSave(db, owner.accountId))).toMatchObject({
      phone_number_id: "1111",
      verify_token: "enc-verify",
    });

    const view = await asUser(viewer.id, (db) => getWhatsAppConfigForClient(db, owner.accountId));
    expect(view).toMatchObject({ phone_number_id: "1111", has_verify_token: true, mirror_inbound_media: true });
    expect(view).not.toHaveProperty("access_token");
    expect(view).not.toHaveProperty("verify_token");
    expect(await asUser(other.id, (db) => getWhatsAppConfigForClient(db, owner.accountId))).toBeUndefined();
  });

  it("detects a number claimed by another account (service role)", async () => {
    expect(await asService((db) => isPhoneNumberClaimedElsewhere(db, "1111", other.accountId))).toBe(true);
    expect(await asService((db) => isPhoneNumberClaimedElsewhere(db, "1111", owner.accountId))).toBe(false);
  });

  it("update / mirror toggle are admin-only under RLS", async () => {
    await asUser(owner.id, (db) => updateWhatsAppConfig(db, owner.accountId, row({ verify_token: null, status: "disconnected" })));
    const view = await asUser(owner.id, (db) => getWhatsAppConfigForClient(db, owner.accountId));
    expect(view).toMatchObject({ has_verify_token: false, status: "disconnected" });

    expect(await asUser(viewer.id, (db) => setMirrorInboundMedia(db, owner.accountId, false))).toBe(false);
    expect(await asUser(owner.id, (db) => setMirrorInboundMedia(db, owner.accountId, false))).toBe(true);
    expect((await asUser(viewer.id, (db) => getWhatsAppConfigForClient(db, owner.accountId)))?.mirror_inbound_media).toBe(
      false,
    );
  });

  it("settings overview counts", async () => {
    await asUser(owner.id, async (db) => {
      await db.insertInto("tags").values({ account_id: owner.accountId, user_id: owner.id, name: "VIP" }).execute();
      await db
        .insertInto("custom_fields")
        .values({ account_id: owner.accountId, user_id: owner.id, field_name: "Plan" })
        .execute();
      await db
        .insertInto("message_templates")
        .values([
          { account_id: owner.accountId, user_id: owner.id, name: "a", body_text: "A", status: "APPROVED" },
          { account_id: owner.accountId, user_id: owner.id, name: "b", body_text: "B", status: "PENDING" },
        ])
        .execute();
    });
    expect(await asUser(owner.id, (db) => getSettingsOverviewCounts(db, owner.accountId))).toEqual({
      templates: 2,
      templates_pending: 1,
      tags: 1,
      custom_fields: 1,
      whatsapp_configured: true,
    });
    // Workspace-wide: every member sees the same numbers, whoever created the rows.
    expect(await asUser(viewer.id, (db) => getSettingsOverviewCounts(db, owner.accountId))).toEqual({
      templates: 2,
      templates_pending: 1,
      tags: 1,
      custom_fields: 1,
      whatsapp_configured: true,
    });
  });

  it("delete is admin-only and account-scoped", async () => {
    await asUser(viewer.id, (db) => deleteWhatsAppConfig(db, owner.accountId));
    expect(await asUser(owner.id, (db) => getWhatsAppConfigRow(db, owner.accountId))).toBeDefined();
    await asUser(owner.id, (db) => deleteWhatsAppConfig(db, owner.accountId));
    expect(await asUser(owner.id, (db) => getWhatsAppConfigRow(db, owner.accountId))).toBeUndefined();
  });
});
