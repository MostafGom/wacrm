// Automation run state (logs + pending executions) against real Postgres:
// atomic log appends, the claim lock, reply-wait supersede / expiry and
// the cron's due scan.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { asService } from "@/server/db";
import { insertAutomation } from "@/server/repos/automations";
import {
  claimPendingExecution,
  expireAwaitingReplyRows,
  findAwaitingReply,
  insertAutomationLog,
  insertPendingExecution,
  listDuePendingExecutions,
  setPendingExecutionStatus,
  supersedeAwaitingReplies,
  updateAutomationLog,
  type PendingExecutionInsert,
} from "@/server/repos/automation-runs";
import { seedUser, teardownIntegrationDb, useIntegrationDb, withSuperuser, type SeededUser } from "@/test/integration/helpers";

let owner: SeededUser;
let stranger: SeededUser;
let automationId: string;
let contactId: string;

const HOUR = 3_600_000;

function pending(overrides: Partial<PendingExecutionInsert> = {}): PendingExecutionInsert {
  return {
    automation_id: automationId,
    account_id: owner.accountId,
    user_id: owner.id,
    contact_id: contactId,
    log_id: null,
    parent_step_id: null,
    branch: null,
    next_step_position: 1,
    context: { message_text: "hi", vars: { list: [1, 2] } },
    run_at: new Date(Date.now() + HOUR).toISOString(),
    status: "awaiting_reply",
    ...overrides,
  };
}

const statusOf = (id: string) =>
  asService((db) =>
    db.selectFrom("automation_pending_executions").select("status").where("id", "=", id).executeTakeFirstOrThrow(),
  ).then((r) => r.status);

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  stranger = await seedUser("Stranger");
  ({ automationId, contactId } = await asService(async (db) => {
    const a = await insertAutomation(db, {
      account_id: owner.accountId,
      user_id: owner.id,
      name: "Menu",
      description: null,
      trigger_type: "new_message_received",
      trigger_config: {},
      is_active: true,
    });
    const c = await db
      .insertInto("contacts")
      .values({ account_id: owner.accountId, user_id: owner.id, phone: "+15559990000" })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { automationId: a.id, contactId: c.id };
  }));
});

beforeEach(async () => {
  await withSuperuser((c) => c.query("DELETE FROM public.automation_pending_executions"));
});

afterAll(teardownIntegrationDb);

describe("automation_logs", () => {
  it("appends step results atomically and only inside the account", async () => {
    const log = await asService((db) =>
      insertAutomationLog(db, {
        automation_id: automationId,
        account_id: owner.accountId,
        user_id: owner.id,
        contact_id: contactId,
        trigger_event: "new_message_received",
        status: "failed",
      }),
    );
    const step = (id: string) => ({ step_id: id, step_type: "send_message" as const, status: "success" as const });
    // Two scopes finishing at once must not drop each other's results.
    await Promise.all([
      asService((db) => updateAutomationLog(db, owner.accountId, log.id, { appendSteps: [step("a")] })),
      asService((db) => updateAutomationLog(db, owner.accountId, log.id, { appendSteps: [step("b")] })),
    ]);
    await asService((db) =>
      updateAutomationLog(db, owner.accountId, log.id, { appendSteps: [step("c")], status: "success" }),
    );
    // A foreign account's write is a no-op.
    await asService((db) => updateAutomationLog(db, stranger.accountId, log.id, { status: "failed", error_message: "x" }));

    const row = await asService((db) =>
      db.selectFrom("automation_logs").selectAll().where("id", "=", log.id).executeTakeFirstOrThrow(),
    );
    expect(row.status).toBe("success");
    expect(row.error_message).toBeNull();
    expect((row.steps_executed as { step_id: string }[]).map((s) => s.step_id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("automation_pending_executions", () => {
  it("stores context jsonb as-is and finds only an unexpired wait", async () => {
    const live = await asService((db) => insertPendingExecution(db, pending()));
    await asService((db) =>
      insertPendingExecution(db, pending({ run_at: new Date(Date.now() - HOUR).toISOString() })),
    );
    const found = await asService((db) => findAwaitingReply(db, owner.accountId, contactId, new Date()));
    expect(found?.id).toBe(live.id);
    expect(found?.context).toEqual({ message_text: "hi", vars: { list: [1, 2] } });
    expect(await asService((db) => findAwaitingReply(db, stranger.accountId, contactId, new Date()))).toBeUndefined();
  });

  it("lets exactly one of two racing claims win", async () => {
    const row = await asService((db) => insertPendingExecution(db, pending()));
    const results = await Promise.all([
      asService((db) => claimPendingExecution(db, row.id, "awaiting_reply")),
      asService((db) => claimPendingExecution(db, row.id, "awaiting_reply")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await statusOf(row.id)).toBe("running");
    // Wrong expected status never claims.
    expect(await asService((db) => claimPendingExecution(db, row.id, "pending"))).toBe(false);
  });

  it("supersedes the contact's older waits and scopes status writes", async () => {
    const older = await asService((db) => insertPendingExecution(db, pending()));
    await asService((db) => supersedeAwaitingReplies(db, stranger.accountId, contactId));
    expect(await statusOf(older.id)).toBe("awaiting_reply");
    await asService((db) => supersedeAwaitingReplies(db, owner.accountId, contactId));
    expect(await statusOf(older.id)).toBe("superseded");

    await asService((db) => setPendingExecutionStatus(db, stranger.accountId, older.id, "done"));
    expect(await statusOf(older.id)).toBe("superseded");
    await asService((db) => setPendingExecutionStatus(db, owner.accountId, older.id, "done"));
    expect(await statusOf(older.id)).toBe("done");
  });

  it("cron: expires lapsed reply waits and lists due wait rows oldest first", async () => {
    const lapsed = await asService((db) =>
      insertPendingExecution(db, pending({ run_at: new Date(Date.now() - HOUR).toISOString() })),
    );
    const live = await asService((db) => insertPendingExecution(db, pending()));
    const expired = await asService((db) => expireAwaitingReplyRows(db, new Date()));
    expect(expired).toEqual([{ id: lapsed.id, account_id: owner.accountId, log_id: null }]);
    expect(await statusOf(live.id)).toBe("awaiting_reply");

    const due2 = await asService((db) =>
      insertPendingExecution(db, pending({ status: "pending", run_at: new Date(Date.now() - 1000).toISOString() })),
    );
    const due1 = await asService((db) =>
      insertPendingExecution(db, pending({ status: "pending", run_at: new Date(Date.now() - HOUR).toISOString() })),
    );
    await asService((db) => insertPendingExecution(db, pending({ status: "pending" }))); // not due yet
    const due = await asService((db) => listDuePendingExecutions(db, new Date(), 50));
    expect(due.map((r) => r.id)).toEqual([due1.id, due2.id]);
    expect(await asService((db) => claimPendingExecution(db, due1.id, "pending"))).toBe(true);
    expect(await asService((db) => claimPendingExecution(db, due1.id, "pending"))).toBe(false);
  });
});
