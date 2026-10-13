// Both engines end-to-end against real Postgres (Meta sends stubbed):
// the automation engine's log / wait / resume cycle and the flow
// runner's start → advance → end, through the real repositories.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/automations/meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "wamid.auto" })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "wamid.auto" })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: "wamid.auto" })),
}));
vi.mock("@/lib/flows/meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "wamid.flow" })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.flow" })),
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: "wamid.flow" })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "wamid.flow" })),
}));

import { insertSteps } from "@/lib/automations/steps-tree";
import { resumePendingExecution, runAutomationsForTrigger } from "@/lib/automations/engine";
import { engineSendText as flowSendText } from "@/lib/flows/meta-send";
import { dispatchInboundToFlows } from "@/lib/flows/engine";
import { asService } from "@/server/db";
import { insertAutomation } from "@/server/repos/automations";
import { claimPendingExecution, listDuePendingExecutions } from "@/server/repos/automation-runs";
import { insertFlow, insertFlowNodes } from "@/server/repos/flows";
import { seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let owner: SeededUser;
let stranger: SeededUser;
let contactId: string;
let conversationId: string;

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  stranger = await seedUser("Stranger");
  ({ contactId, conversationId } = await asService(async (db) => {
    const c = await db
      .insertInto("contacts")
      .values({ account_id: owner.accountId, user_id: owner.id, phone: "+15553330000" })
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

describe("automation engine", () => {
  it("runs, parks at a wait step, and finishes when the cron resumes it", async () => {
    const automationId = await asService(async (db) => {
      const a = await insertAutomation(db, {
        account_id: owner.accountId,
        user_id: owner.id,
        name: "Drip",
        description: null,
        trigger_type: "new_message_received",
        trigger_config: {},
        is_active: true,
      });
      await insertSteps(db, owner.accountId, a.id, [
        { step_type: "update_contact_field", step_config: { field: "company", value: "{{ message.text }}" } },
        { step_type: "wait", step_config: { amount: 1, unit: "minutes" } },
        { step_type: "send_message", step_config: { text: "follow-up" } },
      ]);
      return a.id;
    });

    // A foreign account's dispatch never reaches this contact.
    await runAutomationsForTrigger({
      accountId: stranger.accountId,
      triggerType: "new_message_received",
      contactId,
      context: { message_text: "pwned" },
    });

    await runAutomationsForTrigger({
      accountId: owner.accountId,
      triggerType: "new_message_received",
      contactId,
      context: { message_text: "Acme", conversation_id: conversationId },
    });

    const state = () =>
      asService(async (db) => ({
        log: await db
          .selectFrom("automation_logs")
          .selectAll()
          .where("automation_id", "=", automationId)
          .executeTakeFirstOrThrow(),
        pending: await db
          .selectFrom("automation_pending_executions")
          .selectAll()
          .where("automation_id", "=", automationId)
          .executeTakeFirstOrThrow(),
        contact: await db.selectFrom("contacts").select("company").where("id", "=", contactId).executeTakeFirstOrThrow(),
        automation: await db
          .selectFrom("automations")
          .select("execution_count")
          .where("id", "=", automationId)
          .executeTakeFirstOrThrow(),
      }));

    let s = await state();
    expect(s.contact.company).toBe("Acme");
    expect(s.log.status).toBe("partial");
    expect((s.log.steps_executed as { step_type: string }[]).map((x) => x.step_type)).toEqual([
      "update_contact_field",
      "wait",
    ]);
    expect(s.pending).toMatchObject({ status: "pending", next_step_position: 2, log_id: s.log.id });
    expect(s.automation.execution_count).toBe(1);

    // Cron: the row is due once its run_at passes.
    const later = new Date(Date.now() + 2 * 60_000);
    const due = await asService((db) => listDuePendingExecutions(db, later));
    const row = due.find((r) => r.id === s.pending.id)!;
    expect(await asService((db) => claimPendingExecution(db, row.id, "pending"))).toBe(true);
    await resumePendingExecution({
      ...row,
      branch: row.branch,
      context: (row.context ?? {}) as Record<string, unknown>,
    });

    s = await state();
    expect(s.pending.status).toBe("done");
    expect(s.log.status).toBe("success");
    expect((s.log.steps_executed as { step_type: string }[]).map((x) => x.step_type)).toEqual([
      "update_contact_field",
      "wait",
      "send_message",
    ]);
  });
});

describe("flow runner", () => {
  it("starts a keyword flow, sends, ends the run and logs every step", async () => {
    const flowId = await asService(async (db) => {
      const f = await insertFlow(db, {
        account_id: owner.accountId,
        user_id: owner.id,
        name: "Hello",
        description: null,
        status: "active",
        trigger_type: "keyword",
        trigger_config: { keywords: ["hello"] },
        entry_node_id: "start",
      });
      await insertFlowNodes(db, owner.accountId, f.id, [
        { node_key: "start", node_type: "start", config: { next_node_key: "say" } },
        { node_key: "say", node_type: "send_message", config: { text: "Hi!", next_node_key: "done" } },
        { node_key: "done", node_type: "end", config: {} },
      ]);
      return f.id;
    });

    const input = {
      accountId: owner.accountId,
      userId: owner.id,
      contactId,
      conversationId,
      message: { kind: "text" as const, text: "hello there", meta_message_id: "wamid.in1" },
      isFirstInboundMessage: false,
    };
    const result = await dispatchInboundToFlows(input);
    expect(result).toMatchObject({ consumed: true, outcome: "completed" });
    expect(flowSendText).toHaveBeenCalledTimes(1);

    const { run, events, flow } = await asService(async (db) => ({
      run: await db.selectFrom("flow_runs").selectAll().where("flow_id", "=", flowId).executeTakeFirstOrThrow(),
      events: await db
        .selectFrom("flow_run_events")
        .innerJoin("flow_runs", "flow_runs.id", "flow_run_events.flow_run_id")
        .select("flow_run_events.event_type")
        .where("flow_runs.flow_id", "=", flowId)
        .orderBy("flow_run_events.created_at")
        .execute(),
      flow: await db.selectFrom("flows").select("execution_count").where("id", "=", flowId).executeTakeFirstOrThrow(),
    }));
    expect(run).toMatchObject({ status: "completed", end_reason: "end_node" });
    expect(events.map((e) => e.event_type)).toContain("message_sent");
    expect(events.map((e) => e.event_type)).toContain("completed");
    expect(flow.execution_count).toBe(1);

    // Another account's inbound never starts this account's flow.
    const foreign = await dispatchInboundToFlows({ ...input, accountId: stranger.accountId });
    expect(foreign).toEqual({ consumed: false, outcome: "no_match" });
  });
});
