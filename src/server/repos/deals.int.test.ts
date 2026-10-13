// Deals repository against real Postgres: the board's embed shape,
// tenancy checks on references, agent-level writes, the deal form's
// lookups and the admin-only default currency.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser } from "@/server/db";
import {
  dealRefsValid,
  deleteDeal,
  getDeal,
  insertDeal,
  latestConversationForContact,
  listAssigneeOptions,
  listContactOptions,
  listDeals,
  setAccountDefaultCurrency,
  updateDeal,
} from "@/server/repos/deals";
import { createPipelineWithStages, listStages } from "@/server/repos/pipelines";
import { joinAccount, seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let owner: SeededUser;
let agent: SeededUser;
let viewer: SeededUser;
let outsider: SeededUser;
let pipelineId: string;
let stageA: string;
let stageB: string;
let contactId: string;
let outsiderContactId: string;
let ownerProfileId: string;

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  agent = await seedUser("Agent");
  viewer = await seedUser("Viewer");
  outsider = await seedUser("Outsider");
  await joinAccount(agent.id, owner.accountId, "agent");
  await joinAccount(viewer.id, owner.accountId, "viewer");

  await asUser(owner.id, async (db) => {
    const p = await createPipelineWithStages(db, { account_id: owner.accountId, user_id: owner.id, name: "Sales" }, [
      { name: "A", color: "#111111", position: 0 },
      { name: "B", color: "#222222", position: 1 },
    ]);
    pipelineId = p.id;
    [stageA, stageB] = (await listStages(db, owner.accountId, p.id)).map((s) => s.id);
    const c = await db
      .insertInto("contacts")
      .values({ account_id: owner.accountId, user_id: owner.id, phone: "+15551110001", name: "Zed" })
      .returning("id")
      .executeTakeFirstOrThrow();
    contactId = c.id;
    await db
      .insertInto("contacts")
      .values({ account_id: owner.accountId, user_id: owner.id, phone: "+15551110002", name: "Amy" })
      .execute();
    await db
      .insertInto("conversations")
      .values({
        account_id: owner.accountId,
        user_id: owner.id,
        contact_id: contactId,
        status: "open",
        last_message_at: "2026-02-01T00:00:00Z",
      })
      .execute();
    ownerProfileId = (await db.selectFrom("profiles").select("id").where("user_id", "=", owner.id).executeTakeFirstOrThrow()).id;
  });
  outsiderContactId = await asUser(outsider.id, async (db) =>
    (
      await db
        .insertInto("contacts")
        .values({ account_id: outsider.accountId, user_id: outsider.id, phone: "+15552220001", name: "Out" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id,
  );
});

afterAll(teardownIntegrationDb);

describe("deals repo", () => {
  let dealId: string;

  it("agent creates a deal; the list embeds contact + assignee like the board expects", async () => {
    const deal = await asUser(agent.id, (db) =>
      insertDeal(db, {
        account_id: owner.accountId,
        user_id: agent.id,
        title: "Big one",
        value: 1234.5,
        currency: "EUR",
        pipeline_id: pipelineId,
        stage_id: stageA,
        contact_id: contactId,
        assigned_to: ownerProfileId,
        status: "open",
      }),
    );
    dealId = deal.id;
    expect(deal.value).toBe(1234.5);

    const [row] = await asUser(viewer.id, (db) => listDeals(db, owner.accountId, pipelineId));
    expect(row).toMatchObject({ id: dealId, title: "Big one", value: 1234.5, stage_id: stageA });
    expect(row.contact).toMatchObject({ id: contactId, name: "Zed", phone: "+15551110001" });
    expect(row.assignee).toMatchObject({ id: ownerProfileId, user_id: owner.id });
    expect(row.created_at).toMatch(/\+00:00$/);

    expect(await asUser(outsider.id, (db) => listDeals(db, owner.accountId, pipelineId))).toEqual([]);
    expect(await asUser(outsider.id, (db) => getDeal(db, outsider.accountId, dealId))).toBeUndefined();
  });

  it("embeds null contact / assignee when unset", async () => {
    const d = await asUser(agent.id, (db) =>
      insertDeal(db, {
        account_id: owner.accountId,
        user_id: agent.id,
        title: "Bare",
        pipeline_id: pipelineId,
        stage_id: stageA,
      }),
    );
    const got = await asUser(agent.id, (db) => getDeal(db, owner.accountId, d.id));
    expect(got).toMatchObject({ contact: null, assignee: null, status: "open" });
    await asUser(agent.id, (db) => deleteDeal(db, owner.accountId, d.id));
  });

  it("validates that references belong to the account", async () => {
    await asUser(agent.id, async (db) => {
      const base = { pipelineId, stageId: stageB };
      expect(await dealRefsValid(db, owner.accountId, { ...base, contactId, assignedTo: ownerProfileId })).toBe(true);
      expect(await dealRefsValid(db, owner.accountId, { ...base, contactId: outsiderContactId })).toBe(false);
      expect(await dealRefsValid(db, owner.accountId, { pipelineId, stageId: contactId })).toBe(false);
    });
    expect(await asUser(outsider.id, (db) => dealRefsValid(db, outsider.accountId, { pipelineId, stageId: stageA }))).toBe(
      false,
    );
  });

  it("moves a deal between stages (drag and drop) and changes status", async () => {
    const moved = await asUser(agent.id, (db) => updateDeal(db, owner.accountId, dealId, { stage_id: stageB }));
    expect(moved?.stage_id).toBe(stageB);
    const won = await asUser(agent.id, (db) => updateDeal(db, owner.accountId, dealId, { status: "won" }));
    expect(won?.status).toBe("won");
  });

  it("viewers and other accounts cannot write", async () => {
    expect(await asUser(viewer.id, (db) => updateDeal(db, owner.accountId, dealId, { title: "x" }))).toBeUndefined();
    expect(await asUser(viewer.id, (db) => deleteDeal(db, owner.accountId, dealId))).toBe(false);
    expect(await asUser(outsider.id, (db) => deleteDeal(db, outsider.accountId, dealId))).toBe(false);
  });

  it("serves the deal form lookups", async () => {
    await asUser(viewer.id, async (db) => {
      const contacts = await listContactOptions(db, owner.accountId);
      expect(contacts.map((c) => c.name)).toEqual(["Amy", "Zed"]);
      const profiles = await listAssigneeOptions(db, owner.accountId);
      expect(profiles.map((p) => p.full_name).sort()).toEqual(["Agent", "Owner", "Viewer"]);
      const conv = await latestConversationForContact(db, owner.accountId, contactId);
      expect(conv?.status).toBe("open");
    });
    expect(await asUser(outsider.id, (db) => latestConversationForContact(db, outsider.accountId, contactId))).toBeUndefined();
  });

  it("only admins change the account default currency", async () => {
    expect(await asUser(agent.id, (db) => setAccountDefaultCurrency(db, owner.accountId, "BRL"))).toBe(false);
    expect(await asUser(owner.id, (db) => setAccountDefaultCurrency(db, owner.accountId, "BRL"))).toBe(true);
    const acct = await asUser(viewer.id, (db) =>
      db.selectFrom("accounts").select("default_currency").where("id", "=", owner.accountId).executeTakeFirst(),
    );
    expect(acct?.default_currency).toBe("BRL");
  });

  it("deletes a deal", async () => {
    expect(await asUser(agent.id, (db) => deleteDeal(db, owner.accountId, dealId))).toBe(true);
    expect(await asUser(agent.id, (db) => listDeals(db, owner.accountId, pipelineId))).toEqual([]);
  });
});
