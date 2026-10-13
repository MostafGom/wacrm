// Flows, flow nodes and flow runs against real Postgres: account
// scoping, the one-active-run partial unique index, optimistic advance
// and the stale-run sweep.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser } from "@/server/db";
import {
  advanceRunNodeKey,
  endRun,
  getActiveRunForContact,
  hasReplyForMetaMessage,
  insertActiveRun,
  insertRunEvent,
  listActiveRunsForSweep,
  listRunEvents,
  listRunsForFlow,
  timeOutRun,
  updateRun,
} from "@/server/repos/flow-runs";
import {
  deleteFlow,
  getFlow,
  incrementFlowExecutionCount,
  insertFlow,
  insertFlowNodes,
  listActiveFlows,
  listFlowNodes,
  listFlows,
  replaceFlowNodes,
  updateFlow,
} from "@/server/repos/flows";
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
let flowId: string;
let contactId: string;
let conversationId: string;

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  viewer = await seedUser("Viewer");
  stranger = await seedUser("Stranger");
  await joinAccount(viewer.id, owner.accountId, "viewer");
  const flow = await asUser(owner.id, async (db) => {
    const f = await insertFlow(db, {
      account_id: owner.accountId,
      user_id: owner.id,
      name: "Order status",
      description: null,
      status: "draft",
      trigger_type: "keyword",
      trigger_config: { keywords: ["order"] },
      entry_node_id: "start",
    });
    await insertFlowNodes(db, owner.accountId, f.id, [
      { node_key: "start", node_type: "start", config: { next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ]);
    return f;
  });
  flowId = flow.id;
  ({ contactId, conversationId } = await asService(async (db) => {
    const c = await db
      .insertInto("contacts")
      .values({ account_id: owner.accountId, user_id: owner.id, phone: "+15557770000", name: "Ann" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const cv = await db
      .insertInto("conversations")
      .values({ account_id: owner.accountId, user_id: owner.id, contact_id: c.id })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { contactId: c.id, conversationId: cv.id };
  }));
});

afterAll(teardownIntegrationDb);

describe("flows repo", () => {
  it("lists and reads flows + nodes inside the account only", async () => {
    const flows = await asUser(viewer.id, (db) => listFlows(db, owner.accountId));
    expect(flows.map((f) => f.id)).toEqual([flowId]);
    expect(flows[0].trigger_config).toEqual({ keywords: ["order"] });
    const nodes = await asUser(viewer.id, (db) => listFlowNodes(db, owner.accountId, flowId));
    expect(nodes.map((n) => n.node_key)).toEqual(["start", "end"]);
    expect(nodes[0].config).toEqual({ next_node_key: "end" });

    expect(await asService((db) => getFlow(db, stranger.accountId, flowId))).toBeUndefined();
    expect(await asService((db) => listFlowNodes(db, stranger.accountId, flowId))).toEqual([]);
  });

  it("updates, replaces nodes and refuses foreign writes", async () => {
    expect(await asService((db) => updateFlow(db, stranger.accountId, flowId, { name: "x" }))).toBeUndefined();
    await expect(
      asService((db) => insertFlowNodes(db, stranger.accountId, flowId, [{ node_key: "x", node_type: "end", config: {} }])),
    ).rejects.toThrow(/not in account/);
    await asService((db) => replaceFlowNodes(db, stranger.accountId, flowId, []));
    expect(await asService((db) => listFlowNodes(db, owner.accountId, flowId))).toHaveLength(2);

    const updated = await asUser(owner.id, async (db) => {
      const f = await updateFlow(db, owner.accountId, flowId, {
        status: "active",
        fallback_policy: { on_unknown_reply: "ignore", max_reprompts: 1, on_timeout_hours: 1, on_exhaust: "end" },
      });
      await replaceFlowNodes(db, owner.accountId, flowId, [
        { node_key: "start", node_type: "start", config: { next_node_key: "end" }, position_x: 10 },
        { node_key: "end", node_type: "end", config: {} },
      ]);
      return f;
    });
    expect(updated?.status).toBe("active");
    expect(updated?.fallback_policy).toMatchObject({ on_unknown_reply: "ignore" });
    const nodes = await asService((db) => listFlowNodes(db, owner.accountId, flowId));
    expect(nodes.find((n) => n.node_key === "start")?.position_x).toBe(10);
    expect((await asService((db) => listActiveFlows(db, owner.accountId))).map((f) => f.id)).toEqual([flowId]);
  });

  it("RLS refuses a viewer's write", async () => {
    await expect(
      asUser(viewer.id, (db) => updateFlow(db, owner.accountId, flowId, { name: "viewer edit" })),
    ).resolves.toBeUndefined();
    expect((await asService((db) => getFlow(db, owner.accountId, flowId)))?.name).toBe("Order status");
  });

  it("bumps execution_count through the RPC", async () => {
    await asService((db) => incrementFlowExecutionCount(db, flowId));
    expect((await asService((db) => getFlow(db, owner.accountId, flowId)))?.execution_count).toBe(1);
  });
});

describe("flow runs repo", () => {
  let runId: string;

  it("allows one active run per contact — a racing start inserts nothing", async () => {
    const values = {
      flow_id: flowId,
      account_id: owner.accountId,
      user_id: owner.id,
      contact_id: contactId,
      conversation_id: conversationId,
      current_node_key: null,
    };
    const [a, b] = await Promise.all([
      asService((db) => insertActiveRun(db, values)),
      asService((db) => insertActiveRun(db, values)),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    runId = winners[0]!.id;
    expect(winners[0]).toMatchObject({ status: "active", vars: {}, reprompt_count: 0 });
    expect((await asService((db) => getActiveRunForContact(db, owner.accountId, contactId)))?.id).toBe(runId);
    expect(await asService((db) => getActiveRunForContact(db, stranger.accountId, contactId))).toBeUndefined();
  });

  it("advances optimistically (IS NULL for a null expected key)", async () => {
    expect(await asService((db) => advanceRunNodeKey(db, owner.accountId, runId, "start", "x"))).toBe(false);
    expect(await asService((db) => advanceRunNodeKey(db, stranger.accountId, runId, null, "x"))).toBe(false);
    expect(await asService((db) => advanceRunNodeKey(db, owner.accountId, runId, null, "start"))).toBe(true);
    // Two deliveries racing from the same key: one wins.
    const results = await Promise.all([
      asService((db) => advanceRunNodeKey(db, owner.accountId, runId, "start", "a")),
      asService((db) => advanceRunNodeKey(db, owner.accountId, runId, "start", "b")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("stores vars and dedupes replies by Meta message id", async () => {
    await asService((db) => updateRun(db, owner.accountId, runId, { vars: { name: "Ann", tags: ["a"] }, reprompt_count: 2 }));
    await asService((db) =>
      insertRunEvent(db, {
        flow_run_id: runId,
        event_type: "reply_received",
        node_key: "a",
        payload: { meta_message_id: "wamid.X" },
      }),
    );
    const run = await asService((db) => getActiveRunForContact(db, owner.accountId, contactId));
    expect(run?.vars).toEqual({ name: "Ann", tags: ["a"] });
    expect(run?.reprompt_count).toBe(2);
    expect(await asService((db) => hasReplyForMetaMessage(db, owner.accountId, contactId, "wamid.X"))).toBe(true);
    expect(await asService((db) => hasReplyForMetaMessage(db, owner.accountId, contactId, "wamid.Y"))).toBe(false);
    expect(await asService((db) => hasReplyForMetaMessage(db, stranger.accountId, contactId, "wamid.X"))).toBe(false);
  });

  it("lists runs with contact + events for the history page", async () => {
    const runs = await asUser(viewer.id, (db) => listRunsForFlow(db, owner.accountId, flowId));
    expect(runs).toHaveLength(1);
    expect(runs[0].contact).toMatchObject({ id: contactId, name: "Ann" });
    const events = await asUser(viewer.id, (db) => listRunEvents(db, owner.accountId, [runId]));
    expect(events.map((e) => e.event_type)).toEqual(["reply_received"]);
    expect(await asUser(stranger.id, (db) => listRunsForFlow(db, stranger.accountId, flowId))).toEqual([]);
    expect(await asService((db) => listRunEvents(db, stranger.accountId, [runId]))).toEqual([]);
  });

  it("sweep: times out an active run once, with its event", async () => {
    const sweep = await asService((db) => listActiveRunsForSweep(db));
    const mine = sweep.find((r) => r.id === runId);
    expect(mine?.fallback_policy).toMatchObject({ on_timeout_hours: 1 });
    const now = new Date();
    expect(await asService((db) => timeOutRun(db, runId, now, { age_hours: 2, policy_hours: 1 }))).toBe(true);
    expect(await asService((db) => timeOutRun(db, runId, now, { age_hours: 2, policy_hours: 1 }))).toBe(false);
    const events = await asService((db) => listRunEvents(db, owner.accountId, [runId]));
    expect(events.filter((e) => e.event_type === "timeout")).toHaveLength(1);
    expect(await asService((db) => getActiveRunForContact(db, owner.accountId, contactId))).toBeUndefined();
  });

  it("ends runs inside the account only, and cascades on flow delete", async () => {
    const run = await asService((db) =>
      insertActiveRun(db, {
        flow_id: flowId,
        account_id: owner.accountId,
        user_id: owner.id,
        contact_id: contactId,
        conversation_id: conversationId,
        current_node_key: "start",
      }),
    );
    expect(run).toBeDefined();
    await asService((db) => endRun(db, stranger.accountId, run!.id, "failed", "x"));
    expect(await asService((db) => getActiveRunForContact(db, owner.accountId, contactId))).toBeDefined();
    await asService((db) => endRun(db, owner.accountId, run!.id, "completed", "end_node"));
    expect(await asService((db) => getActiveRunForContact(db, owner.accountId, contactId))).toBeUndefined();

    expect(await asService((db) => deleteFlow(db, stranger.accountId, flowId))).toBe(false);
    expect(await asUser(owner.id, (db) => deleteFlow(db, owner.accountId, flowId))).toBe(true);
    expect(await asService((db) => listRunsForFlow(db, owner.accountId, flowId))).toEqual([]);
  });
});
