// Flow runs (one customer walking through a flow) and their event log.
//
// Engine-side calls run as the service role; every function scopes by
// account except the stale-run sweep, which spans accounts by design.
// `flow_run_events` has no account_id — it is only written for a run the
// caller already resolved inside its account, and read through a join.
//
// Concurrency:
//   - one active run per (account, contact): the partial unique index
//     `idx_one_active_run_per_contact`; a racing start is ON CONFLICT
//     DO NOTHING (never a raised 23505 inside a transaction).
//   - advancing is an optimistic UPDATE gated on the current node key.
//   - the sweep's timeout is gated on status = 'active'.

import type { UpdateObject } from "kysely";

import { sql, type Db } from "@/server/db";
import type { DB } from "@/server/db/schema.gen";
import { jsonb } from "@/server/repos/engine-data";
import type { FlowRunRow } from "@/lib/flows/types";

export type FlowRunEventType =
  | "started"
  | "node_entered"
  | "message_sent"
  | "reply_received"
  | "fallback_fired"
  | "handoff"
  | "timeout"
  | "error"
  | "completed";

export type FlowRunEndStatus = "completed" | "handed_off" | "timed_out" | "failed";

/**
 * The contact's active run, newest first. The partial unique index
 * makes two impossible, but a manual SQL glitch shouldn't break
 * dispatch for the contact — pick the newest, let the sweep clean up.
 */
export async function getActiveRunForContact(
  db: Db,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | undefined> {
  const row = await db
    .selectFrom("flow_runs")
    .selectAll()
    .where("account_id", "=", accountId)
    .where("contact_id", "=", contactId)
    .where("status", "=", "active")
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row as unknown as FlowRunRow | undefined;
}

/**
 * Has any of the contact's runs already recorded a `reply_received`
 * event for this Meta message id? (Meta retries deliveries.)
 */
export async function hasReplyForMetaMessage(
  db: Db,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("flow_run_events")
    .innerJoin("flow_runs", "flow_runs.id", "flow_run_events.flow_run_id")
    .select("flow_run_events.id")
    .where("flow_runs.account_id", "=", accountId)
    .where("flow_runs.contact_id", "=", contactId)
    .where("flow_run_events.event_type", "=", "reply_received")
    .where(sql<string>`flow_run_events.payload->>'meta_message_id'`, "=", metaMessageId)
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * Start an active run. Undefined when the contact already has one in
 * this account (a concurrent webhook won the partial unique index).
 */
export async function insertActiveRun(
  db: Db,
  values: {
    flow_id: string;
    account_id: string;
    user_id: string;
    contact_id: string;
    conversation_id: string | null;
    current_node_key: string | null;
  },
): Promise<FlowRunRow | undefined> {
  const row = await db
    .insertInto("flow_runs")
    .values({ ...values, status: "active" })
    .onConflict((oc) => oc.columns(["account_id", "contact_id"]).where("status", "=", "active").doNothing())
    .returningAll()
    .executeTakeFirst();
  return row as unknown as FlowRunRow | undefined;
}

export async function insertRunEvent(
  db: Db,
  event: { flow_run_id: string; event_type: FlowRunEventType; node_key: string | null; payload?: unknown },
): Promise<void> {
  await db
    .insertInto("flow_run_events")
    .values({
      flow_run_id: event.flow_run_id,
      event_type: event.event_type,
      node_key: event.node_key,
      payload: jsonb(event.payload ?? {}),
    })
    .execute();
}

export interface FlowRunPatch {
  vars?: Record<string, unknown>;
  reprompt_count?: number;
  last_prompt_message_id?: string | null;
}

export async function updateRun(db: Db, accountId: string, runId: string, patch: FlowRunPatch): Promise<void> {
  const set: UpdateObject<DB, "flow_runs"> = {};
  if (patch.vars !== undefined) set.vars = jsonb(patch.vars);
  if (patch.reprompt_count !== undefined) set.reprompt_count = patch.reprompt_count;
  if (patch.last_prompt_message_id !== undefined) set.last_prompt_message_id = patch.last_prompt_message_id;
  if (Object.keys(set).length === 0) return;
  await db.updateTable("flow_runs").set(set).where("id", "=", runId).where("account_id", "=", accountId).execute();
}

/**
 * Optimistic advance: move current_node_key only if it still equals
 * what the caller read. False means another delivery already moved it.
 */
export async function advanceRunNodeKey(
  db: Db,
  accountId: string,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  let q = db
    .updateTable("flow_runs")
    .set({ current_node_key: newKey, last_advanced_at: sql<string>`now()` })
    .where("id", "=", runId)
    .where("account_id", "=", accountId)
    .where("status", "=", "active");
  q = expectedOldKey === null ? q.where("current_node_key", "is", null) : q.where("current_node_key", "=", expectedOldKey);
  const row = await q.returning("id").executeTakeFirst();
  return Boolean(row);
}

export async function endRun(
  db: Db,
  accountId: string,
  runId: string,
  status: FlowRunEndStatus,
  reason: string,
): Promise<void> {
  await db
    .updateTable("flow_runs")
    .set({ status, ended_at: sql<string>`now()`, end_reason: reason })
    .where("id", "=", runId)
    .where("account_id", "=", accountId)
    .execute();
}

// ---- run history (dashboard) ---------------------------------------------

export async function listRunsForFlow(db: Db, accountId: string, flowId: string, limit = 50) {
  return db
    .selectFrom("flow_runs")
    .select([
      "flow_runs.id",
      "flow_runs.status",
      "flow_runs.current_node_key",
      "flow_runs.started_at",
      "flow_runs.last_advanced_at",
      "flow_runs.ended_at",
      "flow_runs.end_reason",
      "flow_runs.vars",
      "flow_runs.reprompt_count",
    ])
    .select((eb) =>
      eb
        .selectFrom("contacts")
        .select(
          sql<{ id: string; name: string | null; phone: string }>`json_build_object('id', contacts.id, 'name', contacts.name, 'phone', contacts.phone)`.as(
            "c",
          ),
        )
        .whereRef("contacts.id", "=", "flow_runs.contact_id")
        .as("contact"),
    )
    .where("flow_runs.flow_id", "=", flowId)
    .where("flow_runs.account_id", "=", accountId)
    .orderBy("flow_runs.started_at", "desc")
    .limit(limit)
    .execute();
}

export async function listRunEvents(db: Db, accountId: string, runIds: string[]) {
  if (runIds.length === 0) return [];
  return db
    .selectFrom("flow_run_events")
    .innerJoin("flow_runs", "flow_runs.id", "flow_run_events.flow_run_id")
    .select([
      "flow_run_events.flow_run_id",
      "flow_run_events.event_type",
      "flow_run_events.node_key",
      "flow_run_events.payload",
      "flow_run_events.created_at",
    ])
    .where("flow_run_events.flow_run_id", "in", runIds)
    .where("flow_runs.account_id", "=", accountId)
    .orderBy("flow_run_events.created_at", "asc")
    .execute();
}

// ---- stale-run sweep (cron, all accounts) ---------------------------------

/** Every active run with its flow's fallback_policy. */
export async function listActiveRunsForSweep(db: Db) {
  return db
    .selectFrom("flow_runs")
    .innerJoin("flows", "flows.id", "flow_runs.flow_id")
    .select([
      "flow_runs.id",
      "flow_runs.account_id",
      "flow_runs.flow_id",
      "flow_runs.last_advanced_at",
      "flows.fallback_policy",
    ])
    .where("flow_runs.status", "=", "active")
    .execute();
}

/**
 * Time out one run, gated on it still being active (a late inbound may
 * have just advanced or ended it), and record the `timeout` event in
 * the same transaction. False when the gate didn't match.
 */
export async function timeOutRun(
  db: Db,
  runId: string,
  now: Date,
  payload: { age_hours: number; policy_hours: number },
): Promise<boolean> {
  const row = await db
    .updateTable("flow_runs")
    .set({ status: "timed_out", ended_at: now.toISOString(), end_reason: "stale_sweep" })
    .where("id", "=", runId)
    .where("status", "=", "active")
    .returning("id")
    .executeTakeFirst();
  if (!row) return false;
  await insertRunEvent(db, { flow_run_id: runId, event_type: "timeout", node_key: null, payload });
  return true;
}
