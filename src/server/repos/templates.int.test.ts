// Templates repository against real Postgres: upsert by (user_id, name,
// language), jsonb buttons / sample values, filters, the admin-only
// write policies and the WhatsApp config read.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser } from "@/server/db";
import {
  deleteTemplate,
  findTemplateId,
  getTemplateMeta,
  getWhatsappConfig,
  insertTemplate,
  listTemplates,
  listTemplatesByName,
  updateTemplate,
  upsertTemplateByUserNameLanguage,
} from "@/server/repos/templates";
import { joinAccount, seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let owner: SeededUser;
let agent: SeededUser;
let other: SeededUser;

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  agent = await seedUser("Agent");
  other = await seedUser("Other");
  await joinAccount(agent.id, owner.accountId, "agent");
});

afterAll(teardownIntegrationDb);

const BUTTONS = [{ type: "QUICK_REPLY", text: "Yes" }];

describe("templates repo", () => {
  it("upserts by (user_id, name, language), overwriting every supplied column", async () => {
    const first = await asUser(owner.id, (db) =>
      upsertTemplateByUserNameLanguage(db, {
        account_id: owner.accountId,
        user_id: owner.id,
        name: "order_update",
        language: "en_US",
        category: "Utility",
        body_text: "Hi {{1}}",
        buttons: BUTTONS,
        sample_values: { body: ["Ann"] },
        status: "DRAFT",
        submission_error: "meta down",
      }),
    );
    expect(first.buttons).toEqual(BUTTONS);
    expect(first.sample_values).toEqual({ body: ["Ann"] });

    const second = await asUser(owner.id, (db) =>
      upsertTemplateByUserNameLanguage(db, {
        account_id: owner.accountId,
        user_id: owner.id,
        name: "order_update",
        language: "en_US",
        category: "Utility",
        body_text: "Hello {{1}}",
        buttons: null,
        status: "PENDING",
        meta_template_id: "meta-1",
        submission_error: null,
      }),
    );
    expect(second.id).toBe(first.id);
    expect(second.body_text).toBe("Hello {{1}}");
    expect(second.buttons).toBeNull();
    expect(second.status).toBe("PENDING");
    expect(second.submission_error).toBeNull();
  });

  it("refuses writes from a non-admin (message_templates RLS)", async () => {
    await expect(
      asUser(agent.id, (db) =>
        insertTemplate(db, {
          account_id: owner.accountId,
          user_id: agent.id,
          name: "sneaky",
          language: "en",
          body_text: "x",
        }),
      ),
    ).rejects.toThrow();
    const id = await asUser(owner.id, (db) => findTemplateId(db, owner.accountId, "order_update", "en_US"));
    expect(await asUser(agent.id, (db) => updateTemplate(db, owner.accountId, id!, { body_text: "hacked" }))).toBeUndefined();
    expect(await asUser(agent.id, (db) => deleteTemplate(db, owner.accountId, id!))).toBe(false);
  });

  it("lists with status / author filters and by name, account-scoped", async () => {
    await asUser(owner.id, async (db) => {
      await insertTemplate(db, {
        account_id: owner.accountId,
        user_id: owner.id,
        name: "order_update",
        language: "en",
        body_text: "Hi",
        status: "APPROVED",
        buttons: BUTTONS,
      });
    });
    const approved = await asUser(agent.id, (db) => listTemplates(db, owner.accountId, { status: "APPROVED" }));
    expect(approved.map((t) => t.language)).toEqual(["en"]);
    expect(approved[0].buttons).toEqual(BUTTONS);

    expect(await asUser(agent.id, (db) => listTemplates(db, owner.accountId, { userId: agent.id }))).toEqual([]);
    expect(await asUser(owner.id, (db) => listTemplates(db, owner.accountId, { userId: owner.id }))).toHaveLength(2);

    const byName = await asUser(agent.id, (db) => listTemplatesByName(db, owner.accountId, "order_update"));
    expect(byName.map((t) => t.language).sort()).toEqual(["en", "en_US"]);
    expect(await asService((db) => listTemplatesByName(db, other.accountId, "order_update"))).toEqual([]);
  });

  it("reads lifecycle fields, updates and deletes within the account", async () => {
    const id = (await asUser(owner.id, (db) => findTemplateId(db, owner.accountId, "order_update", "en")))!;
    expect(await asUser(owner.id, (db) => getTemplateMeta(db, owner.accountId, id))).toEqual({
      id,
      name: "order_update",
      status: "APPROVED",
      meta_template_id: null,
      language: "en",
    });
    expect(await asService((db) => getTemplateMeta(db, other.accountId, id))).toBeUndefined();

    const updated = await asUser(owner.id, (db) =>
      updateTemplate(db, owner.accountId, id, { status: "PENDING", sample_values: { body: ["x"] } }),
    );
    expect(updated?.status).toBe("PENDING");
    expect(updated?.sample_values).toEqual({ body: ["x"] });

    expect(await asService((db) => deleteTemplate(db, other.accountId, id))).toBe(false);
    expect(await asUser(owner.id, (db) => deleteTemplate(db, owner.accountId, id))).toBe(true);
  });

  it("reads the WhatsApp config for the account only", async () => {
    await asService((db) =>
      db
        .insertInto("whatsapp_config")
        .values({
          account_id: owner.accountId,
          user_id: owner.id,
          phone_number_id: "PN-1",
          access_token: "enc",
          waba_id: "WABA-1",
        })
        .execute(),
    );
    expect(await asUser(agent.id, (db) => getWhatsappConfig(db, owner.accountId))).toEqual({
      phone_number_id: "PN-1",
      access_token: "enc",
      waba_id: "WABA-1",
    });
    expect(await asService((db) => getWhatsappConfig(db, other.accountId))).toBeUndefined();
  });
});
