// Flows (conversation graphs) and their nodes.
//
// `flows` is account-scoped (migration 017). `flow_nodes` has no
// account_id; every nodes query joins / subqueries its parent flow's
// account.

import type { UpdateObject } from "kysely";

import { sql, type Db } from "@/server/db";
import type { DB } from "@/server/db/schema.gen";
import { jsonb } from "@/server/repos/engine-data";
import type { FlowNodeRow, FlowRow } from "@/lib/flows/types";

// ---- flows ----------------------------------------------------------

export async function listFlows(db: Db, accountId: string): Promise<FlowRow[]> {
  const rows = await db
    .selectFrom("flows")
    .selectAll()
    .where("account_id", "=", accountId)
    .orderBy("created_at", "desc")
    .execute();
  return rows as unknown as FlowRow[];
}

export async function getFlow(db: Db, accountId: string, id: string): Promise<FlowRow | undefined> {
  const row = await db
    .selectFrom("flows")
    .selectAll()
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return row as unknown as FlowRow | undefined;
}

/** Active flows of an account, oldest first (entry-trigger precedence). */
export async function listActiveFlows(db: Db, accountId: string): Promise<FlowRow[]> {
  const rows = await db
    .selectFrom("flows")
    .selectAll()
    .where("account_id", "=", accountId)
    .where("status", "=", "active")
    .orderBy("created_at", "asc")
    .execute();
  return rows as unknown as FlowRow[];
}

export interface FlowInsert {
  account_id: string;
  user_id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: string;
  trigger_config: unknown;
  entry_node_id?: string | null;
}

export async function insertFlow(db: Db, values: FlowInsert): Promise<FlowRow> {
  const row = await db
    .insertInto("flows")
    .values({ ...values, trigger_config: jsonb(values.trigger_config ?? {}) })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as unknown as FlowRow;
}

export interface FlowPatch {
  name?: string;
  description?: string | null;
  status?: "draft" | "active" | "archived";
  trigger_type?: string;
  trigger_config?: unknown;
  entry_node_id?: string | null;
  fallback_policy?: unknown;
}

/** Update a flow (bumps updated_at). Undefined when it isn't in the account. */
export async function updateFlow(
  db: Db,
  accountId: string,
  id: string,
  patch: FlowPatch,
): Promise<FlowRow | undefined> {
  const set: UpdateObject<DB, "flows"> = { updated_at: sql<string>`now()` };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.trigger_type !== undefined) set.trigger_type = patch.trigger_type;
  if (patch.trigger_config !== undefined) set.trigger_config = jsonb(patch.trigger_config);
  if (patch.entry_node_id !== undefined) set.entry_node_id = patch.entry_node_id;
  if (patch.fallback_policy !== undefined) set.fallback_policy = jsonb(patch.fallback_policy);
  const row = await db
    .updateTable("flows")
    .set(set)
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .returningAll()
    .executeTakeFirst();
  return row as unknown as FlowRow | undefined;
}

export async function deleteFlow(db: Db, accountId: string, id: string): Promise<boolean> {
  const r = await db.deleteFrom("flows").where("id", "=", id).where("account_id", "=", accountId).executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

/** Atomic counter bump (SECURITY DEFINER RPC from migration 012). */
export async function incrementFlowExecutionCount(db: Db, flowId: string): Promise<void> {
  await sql`SELECT public.increment_flow_execution_count(${flowId}::uuid)`.execute(db);
}

// ---- nodes ----------------------------------------------------------

export interface FlowNodeInput {
  node_key: string;
  node_type: string;
  config: unknown;
  position_x?: number;
  position_y?: number;
}

/** Every node of an account's flow, in creation order. */
export async function listFlowNodes(db: Db, accountId: string, flowId: string): Promise<FlowNodeRow[]> {
  const rows = await db
    .selectFrom("flow_nodes")
    .innerJoin("flows", "flows.id", "flow_nodes.flow_id")
    .selectAll("flow_nodes")
    .where("flow_nodes.flow_id", "=", flowId)
    .where("flows.account_id", "=", accountId)
    .orderBy("flow_nodes.created_at", "asc")
    .execute();
  return rows as unknown as FlowNodeRow[];
}

/**
 * Insert nodes into an account's flow. Throws when the flow isn't in
 * the account (nothing is written).
 */
export async function insertFlowNodes(
  db: Db,
  accountId: string,
  flowId: string,
  nodes: FlowNodeInput[],
): Promise<void> {
  if (nodes.length === 0) return;
  const owned = await db
    .selectFrom("flows")
    .select("id")
    .where("id", "=", flowId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  if (!owned) throw new Error("flow not in account");
  await db
    .insertInto("flow_nodes")
    .values(
      nodes.map((n) => ({
        flow_id: flowId,
        node_key: n.node_key,
        node_type: n.node_type,
        config: jsonb(n.config ?? {}),
        position_x: n.position_x ?? 0,
        position_y: n.position_y ?? 0,
      })),
    )
    .execute();
}

/** Replace a flow's whole node graph (delete-then-insert). */
export async function replaceFlowNodes(
  db: Db,
  accountId: string,
  flowId: string,
  nodes: FlowNodeInput[],
): Promise<void> {
  await db
    .deleteFrom("flow_nodes")
    .where("flow_id", "=", flowId)
    .where("flow_id", "in", (eb) =>
      eb.selectFrom("flows").select("id").where("id", "=", flowId).where("account_id", "=", accountId),
    )
    .execute();
  await insertFlowNodes(db, accountId, flowId, nodes);
}
