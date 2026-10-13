// Automation run state: `automation_logs` (one row per run) and
// `automation_pending_executions` (runs parked at a `wait` step or
// waiting for a reply).
//
// Engine-side (asService). Every function takes the account id except
// the cron sweeps, which deliberately span accounts and hand each row's
// own account_id back to the engine.
//
// Claims are single statements — `UPDATE … WHERE status = <expected>
// RETURNING id` — so two workers racing on a row can't both win.

import { sql, type Db } from "@/server/db";
import { jsonb } from "@/server/repos/engine-data";
import type { AutomationLogStepResult } from "@/types";

export type LogStatus = "success" | "partial" | "failed";

// ---- automation_logs --------------------------------------------------

export async function insertAutomationLog(
  db: Db,
  values: {
    automation_id: string;
    account_id: string;
    user_id: string;
    contact_id: string | null;
    trigger_event: string;
    status: LogStatus;
  },
): Promise<{ id: string }> {
  return db
    .insertInto("automation_logs")
    .values({ ...values, steps_executed: jsonb([]) })
    .returning("id")
    .executeTakeFirstOrThrow();
}

export interface LogPatch {
  /** Appended to steps_executed atomically (jsonb concatenation). */
  appendSteps?: AutomationLogStepResult[];
  status?: LogStatus;
  error_message?: string | null;
}

export async function updateAutomationLog(db: Db, accountId: string, logId: string, patch: LogPatch): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.appendSteps) {
    set.steps_executed = sql`coalesce(steps_executed, '[]'::jsonb) || ${JSON.stringify(patch.appendSteps)}::jsonb`;
  }
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.error_message !== undefined) set.error_message = patch.error_message;
  if (Object.keys(set).length === 0) return;
  await db
    .updateTable("automation_logs")
    .set(set)
    .where("id", "=", logId)
    .where("account_id", "=", accountId)
    .execute();
}

// ---- automation_pending_executions --------------------------------------

export type PendingStatus = "pending" | "running" | "awaiting_reply" | "done" | "failed" | "expired" | "superseded";

export interface PendingExecutionRow {
  id: string;
  automation_id: string;
  account_id: string;
  user_id: string;
  contact_id: string | null;
  log_id: string | null;
  parent_step_id: string | null;
  branch: "yes" | "no" | null;
  next_step_position: number;
  context: Record<string, unknown> | null;
  run_at: string;
  status: string;
  created_at: string;
}

export interface PendingExecutionInsert {
  automation_id: string;
  account_id: string;
  user_id: string;
  contact_id: string | null;
  log_id: string | null;
  parent_step_id: string | null;
  branch: "yes" | "no" | null;
  next_step_position: number;
  context: unknown;
  run_at: string;
  status: "pending" | "awaiting_reply";
}

export async function insertPendingExecution(db: Db, values: PendingExecutionInsert): Promise<{ id: string }> {
  return db
    .insertInto("automation_pending_executions")
    .values({ ...values, context: jsonb(values.context ?? {}) })
    .returning("id")
    .executeTakeFirstOrThrow();
}

/** Supersede every run already waiting on this contact's reply. */
export async function supersedeAwaitingReplies(db: Db, accountId: string, contactId: string | null): Promise<void> {
  if (!contactId) return;
  await db
    .updateTable("automation_pending_executions")
    .set({ status: "superseded" })
    .where("account_id", "=", accountId)
    .where("contact_id", "=", contactId)
    .where("status", "=", "awaiting_reply")
    .execute();
}

/** The contact's newest run waiting for a reply whose deadline hasn't passed. */
export async function findAwaitingReply(
  db: Db,
  accountId: string,
  contactId: string,
  now: Date,
): Promise<PendingExecutionRow | undefined> {
  const row = await db
    .selectFrom("automation_pending_executions")
    .selectAll()
    .where("account_id", "=", accountId)
    .where("contact_id", "=", contactId)
    .where("status", "=", "awaiting_reply")
    .where("run_at", ">", now.toISOString())
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row as PendingExecutionRow | undefined;
}

/**
 * Move a row from `from` to `running`. True only for the caller whose
 * UPDATE actually flipped it — the lock that stops two deliveries (or
 * two overlapping cron runs) from resuming the same run.
 */
export async function claimPendingExecution(db: Db, id: string, from: "pending" | "awaiting_reply"): Promise<boolean> {
  const row = await db
    .updateTable("automation_pending_executions")
    .set({ status: "running" })
    .where("id", "=", id)
    .where("status", "=", from)
    .returning("id")
    .executeTakeFirst();
  return Boolean(row);
}

export async function setPendingExecutionStatus(
  db: Db,
  accountId: string,
  id: string,
  status: "done" | "failed" | "expired",
): Promise<void> {
  await db
    .updateTable("automation_pending_executions")
    .set({ status })
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .execute();
}

/** Cron: expire every reply wait whose deadline passed (all accounts). */
export async function expireAwaitingReplyRows(
  db: Db,
  now: Date,
): Promise<{ id: string; account_id: string; log_id: string | null }[]> {
  return db
    .updateTable("automation_pending_executions")
    .set({ status: "expired" })
    .where("status", "=", "awaiting_reply")
    .where("run_at", "<=", now.toISOString())
    .returning(["id", "account_id", "log_id"])
    .execute();
}

/** Cron: due `wait` rows, oldest first (all accounts). Claim each before running it. */
export async function listDuePendingExecutions(db: Db, now: Date, limit = 50): Promise<PendingExecutionRow[]> {
  const rows = await db
    .selectFrom("automation_pending_executions")
    .selectAll()
    .where("status", "=", "pending")
    .where("run_at", "<=", now.toISOString())
    .orderBy("run_at", "asc")
    .limit(limit)
    .execute();
  return rows as PendingExecutionRow[];
}
