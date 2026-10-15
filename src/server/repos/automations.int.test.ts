// Automations + step-tree repository against real Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildStepRows, insertSteps, loadStepsTree, replaceSteps } from "@/lib/automations/steps-tree";
import { asService, asUser } from "@/server/db";
import {
  deleteAutomation,
  getAutomation,
  getBuilderResources,
  getStepPlacement,
  incrementAutomationExecutionCount,
  insertAutomation,
  insertAutomationSteps,
  listActiveAutomationsForTrigger,
  listAutomationLogs,
  listAutomations,
  listScopeSteps,
  listTemplateBodies,
  updateAutomation,
} from "@/server/repos/automations";
import { insertAutomationLog } from "@/server/repos/automation-runs";
import {
  joinAccount,
  seedUser,
  teardownIntegrationDb,
  useIntegrationDb,
  type SeededUser,
} from "@/test/integration/helpers";

let owner: SeededUser;
let viewer: SeededUser;
let stranger: SeededUser;
let automationId: string;

const TREE = [
  { step_type: "send_message", step_config: { text: "hi" } },
  {
    step_type: "condition",
    step_config: { subject: "message_content", operand: "contains", value: "yes" },
    branches: {
      yes: [
        { step_type: "add_tag", step_config: { tag_id: "t1" } },
        { step_type: "send_message", step_config: { text: "great" } },
      ],
      no: [{ step_type: "send_message", step_config: { text: "ok" } }],
    },
  },
  { step_type: "close_conversation", step_config: {} },
];

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  viewer = await seedUser("Viewer");
  stranger = await seedUser("Stranger");
  await joinAccount(viewer.id, owner.accountId, "viewer");
  const created = await asUser(owner.id, async (db) => {
    const a = await insertAutomation(db, {
      account_id: owner.accountId,
      user_id: owner.id,
      name: "Welcome",
      description: null,
      trigger_type: "new_message_received",
      trigger_config: { keywords: ["a", "b"] },
      is_active: true,
    });
    await insertSteps(db, owner.accountId, a.id, TREE);
    return a;
  });
  automationId = created.id;
});

afterAll(teardownIntegrationDb);

describe("automations repo", () => {
  it("creates, lists and reads within the account only", async () => {
    const mine = await asUser(owner.id, (db) => listAutomations(db, owner.accountId));
    expect(mine.map((a) => a.id)).toEqual([automationId]);
    expect(mine[0].trigger_config).toEqual({ keywords: ["a", "b"] });
    expect(mine[0].created_at).toMatch(/\+00:00$/);

    // A teammate (viewer) reads it; another account never does.
    expect(await asUser(viewer.id, (db) => getAutomation(db, owner.accountId, automationId))).toBeDefined();
    expect(await asUser(stranger.id, (db) => getAutomation(db, stranger.accountId, automationId))).toBeUndefined();
    expect(await asService((db) => getAutomation(db, stranger.accountId, automationId))).toBeUndefined();
  });

  it("updates and deletes only inside the account", async () => {
    expect(
      await asService((db) => updateAutomation(db, stranger.accountId, automationId, { name: "pwned" })),
    ).toBe(false);
    expect(await asService((db) => deleteAutomation(db, stranger.accountId, automationId))).toBe(false);
    expect(
      await asUser(owner.id, (db) => updateAutomation(db, owner.accountId, automationId, { description: "d" })),
    ).toBe(true);
    const row = await asUser(owner.id, (db) => getAutomation(db, owner.accountId, automationId));
    expect(row?.name).toBe("Welcome");
    expect(row?.description).toBe("d");
  });

  it("RLS refuses a viewer's write even with the right account", async () => {
    await expect(
      asUser(viewer.id, (db) =>
        insertAutomation(db, {
          account_id: owner.accountId,
          user_id: viewer.id,
          name: "nope",
          description: null,
          trigger_type: "manual",
          trigger_config: {},
          is_active: false,
        }),
      ),
    ).rejects.toThrow();
  });

  it("filters active automations by trigger for the engine", async () => {
    const hit = await asService((db) =>
      listActiveAutomationsForTrigger(db, owner.accountId, "new_message_received"),
    );
    expect(hit.map((a) => a.id)).toEqual([automationId]);
    expect(await asService((db) => listActiveAutomationsForTrigger(db, owner.accountId, "tag_added"))).toEqual([]);
    expect(
      await asService((db) => listActiveAutomationsForTrigger(db, stranger.accountId, "new_message_received")),
    ).toEqual([]);
  });

  it("bumps execution_count through the SECURITY DEFINER RPC", async () => {
    await asService((db) => incrementAutomationExecutionCount(db, automationId));
    await asService((db) => incrementAutomationExecutionCount(db, automationId));
    const row = await asService((db) => getAutomation(db, owner.accountId, automationId));
    expect(row?.execution_count).toBe(2);
  });
});

describe("automation step tree", () => {
  it("round-trips the nested builder tree", async () => {
    const tree = await asUser(owner.id, (db) => loadStepsTree(db, owner.accountId, automationId));
    const shape = (nodes: typeof tree): unknown =>
      nodes.map((n) => ({
        step_type: n.step_type,
        step_config: n.step_config,
        ...(n.step_type === "condition" ? { branches: { yes: shape(n.branches.yes), no: shape(n.branches.no) } } : {}),
      }));
    expect(shape(tree)).toEqual(TREE);
    // Another account sees no steps.
    expect(await asService((db) => loadStepsTree(db, stranger.accountId, automationId))).toEqual([]);
  });

  it("serves one scope at a time to the engine and resolves placements", async () => {
    const root = await asService((db) =>
      listScopeSteps(db, automationId, { parentStepId: null, branch: null, startPosition: 1 }),
    );
    expect(root.map((s) => s.step_type)).toEqual(["condition", "close_conversation"]);
    const cond = root[0];
    const yes = await asService((db) =>
      listScopeSteps(db, automationId, { parentStepId: cond.id, branch: "yes", startPosition: 0 }),
    );
    expect(yes.map((s) => s.step_type)).toEqual(["add_tag", "send_message"]);
    const placement = await asService((db) => getStepPlacement(db, automationId, yes[1].id));
    expect(placement).toMatchObject({ parent_step_id: cond.id, branch: "yes", position: 1 });
  });

  it("replaces the tree in one go and refuses rows for a foreign automation", async () => {
    await asUser(owner.id, (db) =>
      replaceSteps(db, owner.accountId, automationId, [{ step_type: "send_message", step_config: { text: "only" } }]),
    );
    const tree = await asUser(owner.id, (db) => loadStepsTree(db, owner.accountId, automationId));
    expect(tree.map((n) => n.step_config)).toEqual([{ text: "only" }]);

    await expect(
      asService((db) =>
        insertAutomationSteps(
          db,
          stranger.accountId,
          buildStepRows(automationId, [{ step_type: "send_message", step_config: {} }]),
        ),
      ),
    ).rejects.toThrow(/not in account/);
  });
});

describe("logs + builder resources", () => {
  it("lists logs newest first with the contact embedded", async () => {
    await asService(async (db) => {
      const contact = await db
        .insertInto("contacts")
        .values({ account_id: owner.accountId, user_id: owner.id, phone: "+15551230000", name: "Zed" })
        .returning("id")
        .executeTakeFirstOrThrow();
      await insertAutomationLog(db, {
        automation_id: automationId,
        account_id: owner.accountId,
        user_id: owner.id,
        contact_id: contact.id,
        trigger_event: "new_message_received",
        status: "failed",
      });
      await insertAutomationLog(db, {
        automation_id: automationId,
        account_id: owner.accountId,
        user_id: owner.id,
        contact_id: null,
        trigger_event: "manual",
        status: "success",
      });
    });
    const logs = await asUser(viewer.id, (db) => listAutomationLogs(db, owner.accountId, automationId));
    expect(logs).toHaveLength(2);
    const withContact = logs.find((l) => l.contact_id);
    expect(withContact?.contact).toMatchObject({ name: "Zed", phone: "+15551230000" });
    expect(withContact?.steps_executed).toEqual([]);
    expect(logs.find((l) => !l.contact_id)?.contact).toBeNull();
    expect(await asUser(stranger.id, (db) => listAutomationLogs(db, stranger.accountId, automationId))).toEqual([]);
  });

  it("returns only APPROVED templates and the account's pipelines", async () => {
    await asService(async (db) => {
      await db
        .insertInto("message_templates")
        .values([
          { account_id: owner.accountId, user_id: owner.id, name: "ok", body_text: "b", status: "APPROVED" },
          { account_id: owner.accountId, user_id: owner.id, name: "draft", body_text: "b", status: "PENDING" },
        ])
        .execute();
      const p = await db
        .insertInto("pipelines")
        .values({ account_id: owner.accountId, user_id: owner.id, name: "Sales" })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db.insertInto("pipeline_stages").values({ pipeline_id: p.id, name: "New", position: 0 }).execute();
    });
    const res = await asUser(owner.id, (db) => getBuilderResources(db, owner.accountId));
    expect(res.templates.map((t) => t.name)).toEqual(["ok"]);
    expect(res.pipelines.map((p) => p.name)).toContain("Sales");
    expect(res.stages.map((s) => s.name)).toContain("New");
    const theirs = await asUser(stranger.id, (db) => getBuilderResources(db, stranger.accountId));
    expect(theirs.templates).toEqual([]);
    expect(theirs.stages.map((s) => s.name)).not.toContain("New");
  });

  it("lists template bodies by name for activation checks, inside the account only", async () => {
    await asService(async (db) => {
      await db
        .insertInto("message_templates")
        .values([
          { account_id: owner.accountId, user_id: owner.id, name: "vars", language: "en_US", body_text: "Hi {{1}}" },
          { account_id: stranger.accountId, user_id: stranger.id, name: "vars", language: "en_US", body_text: "x" },
        ])
        .execute();
    });
    const rows = await asUser(owner.id, (db) => listTemplateBodies(db, owner.accountId, ["vars", "missing"]));
    expect(rows).toEqual([{ name: "vars", language: "en_US", body_text: "Hi {{1}}" }]);
    expect(await asUser(owner.id, (db) => listTemplateBodies(db, owner.accountId, []))).toEqual([]);
  });
});
