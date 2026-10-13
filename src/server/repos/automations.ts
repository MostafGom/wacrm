// Automations + their step trees.
//
// `automations` is account-scoped (migration 017). `automation_steps`
// has no account_id of its own — every steps query either joins its
// parent automation's account or is only reached after the caller has
// loaded that automation through an account-scoped lookup.

import type { InsertObject, UpdateObject } from "kysely";

import { sql, type Db } from "@/server/db";
import type { DB } from "@/server/db/schema.gen";
import { jsonb } from "@/server/repos/engine-data";
import type { Automation, AutomationLog, AutomationStep } from "@/types";

// Generated row types carry `Json` for jsonb columns; the app types
// narrow those to the config shapes the UI and engine use.
type AutomationRow = Automation;

// ---- automations ------------------------------------------------------

export async function listAutomations(db: Db, accountId: string): Promise<AutomationRow[]> {
  const rows = await db
    .selectFrom("automations")
    .selectAll()
    .where("account_id", "=", accountId)
    .orderBy("created_at", "desc")
    .execute();
  return rows as unknown as AutomationRow[];
}

export async function getAutomation(db: Db, accountId: string, id: string): Promise<AutomationRow | undefined> {
  const row = await db
    .selectFrom("automations")
    .selectAll()
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return row as unknown as AutomationRow | undefined;
}

/** Active automations of one trigger type, for the engine's dispatch. */
export async function listActiveAutomationsForTrigger(
  db: Db,
  accountId: string,
  triggerType: string,
): Promise<AutomationRow[]> {
  const rows = await db
    .selectFrom("automations")
    .selectAll()
    .where("account_id", "=", accountId)
    .where("trigger_type", "=", triggerType)
    .where("is_active", "=", true)
    .execute();
  return rows as unknown as AutomationRow[];
}

export interface AutomationInsert {
  account_id: string;
  user_id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_config: unknown;
  is_active: boolean;
}

export async function insertAutomation(db: Db, values: AutomationInsert): Promise<AutomationRow> {
  const row: InsertObject<DB, "automations"> = { ...values, trigger_config: jsonb(values.trigger_config ?? {}) };
  const inserted = await db.insertInto("automations").values(row).returningAll().executeTakeFirstOrThrow();
  return inserted as unknown as AutomationRow;
}

export interface AutomationPatch {
  name?: string;
  description?: string | null;
  trigger_type?: string;
  trigger_config?: unknown;
  is_active?: boolean;
}

/** Returns false when the automation isn't in the account. */
export async function updateAutomation(
  db: Db,
  accountId: string,
  id: string,
  patch: AutomationPatch,
): Promise<boolean> {
  const set: UpdateObject<DB, "automations"> = { updated_at: sql<string>`now()` };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.trigger_type !== undefined) set.trigger_type = patch.trigger_type;
  if (patch.trigger_config !== undefined) set.trigger_config = jsonb(patch.trigger_config);
  if (patch.is_active !== undefined) set.is_active = patch.is_active;
  const r = await db
    .updateTable("automations")
    .set(set)
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

export async function deleteAutomation(db: Db, accountId: string, id: string): Promise<boolean> {
  const r = await db
    .deleteFrom("automations")
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

/** Atomic counter bump (SECURITY DEFINER RPC from migration 007). */
export async function incrementAutomationExecutionCount(db: Db, automationId: string): Promise<void> {
  await sql`SELECT public.increment_automation_execution_count(${automationId}::uuid)`.execute(db);
}

// ---- steps ----------------------------------------------------------

export interface StepRow {
  id: string;
  automation_id: string;
  parent_step_id: string | null;
  branch: "yes" | "no" | null;
  step_type: string;
  step_config: Record<string, unknown>;
  position: number;
}

/** Every step of an account's automation, ordered by position. */
export async function listAutomationSteps(db: Db, accountId: string, automationId: string): Promise<StepRow[]> {
  const rows = await db
    .selectFrom("automation_steps")
    .innerJoin("automations", "automations.id", "automation_steps.automation_id")
    .selectAll("automation_steps")
    .where("automation_steps.automation_id", "=", automationId)
    .where("automations.account_id", "=", accountId)
    .orderBy("automation_steps.position", "asc")
    .execute();
  return rows as unknown as StepRow[];
}

/**
 * Insert pre-built step rows (ids assigned by the caller so parent
 * references resolve in one statement). The automation must belong to
 * the account; rows for a foreign automation are refused.
 */
export async function insertAutomationSteps(db: Db, accountId: string, rows: StepRow[]): Promise<void> {
  if (rows.length === 0) return;
  const ids = [...new Set(rows.map((r) => r.automation_id))];
  const owned = await db
    .selectFrom("automations")
    .select("id")
    .where("id", "in", ids)
    .where("account_id", "=", accountId)
    .execute();
  if (owned.length !== ids.length) throw new Error("automation not in account");
  await db
    .insertInto("automation_steps")
    .values(rows.map((r) => ({ ...r, step_config: jsonb(r.step_config ?? {}) })))
    .execute();
}

/** Delete every step of an account's automation. */
export async function deleteAutomationSteps(db: Db, accountId: string, automationId: string): Promise<void> {
  await db
    .deleteFrom("automation_steps")
    .where("automation_id", "=", automationId)
    .where("automation_id", "in", (eb) =>
      eb.selectFrom("automations").select("id").where("id", "=", automationId).where("account_id", "=", accountId),
    )
    .execute();
}

/**
 * The steps of one scope (root, or one branch of a condition) from
 * `startPosition` on, in order. Engine-only: `automationId` comes from
 * an automation row already loaded for the account.
 */
export async function listScopeSteps(
  db: Db,
  automationId: string,
  scope: { parentStepId: string | null; branch: "yes" | "no" | null; startPosition: number },
): Promise<AutomationStep[]> {
  let q = db
    .selectFrom("automation_steps")
    .selectAll()
    .where("automation_id", "=", automationId)
    .where("position", ">=", scope.startPosition);
  q =
    scope.parentStepId === null
      ? q.where("parent_step_id", "is", null)
      : q.where("parent_step_id", "=", scope.parentStepId).where("branch", "=", scope.branch ?? "yes");
  const rows = await q.orderBy("position", "asc").execute();
  return rows as unknown as AutomationStep[];
}

/** Where a step sits in the tree (for climbing out of a branch on resume). */
export async function getStepPlacement(db: Db, automationId: string, stepId: string) {
  const row = await db
    .selectFrom("automation_steps")
    .select(["id", "parent_step_id", "branch", "position"])
    .where("id", "=", stepId)
    .where("automation_id", "=", automationId)
    .executeTakeFirst();
  return row as { id: string; parent_step_id: string | null; branch: "yes" | "no" | null; position: number } | undefined;
}

// ---- logs (read side, for the logs page) ------------------------------

export type AutomationLogWithContact = Omit<AutomationLog, "contact"> & {
  contact: { id: string; name: string | null; phone: string } | null;
};

export async function listAutomationLogs(
  db: Db,
  accountId: string,
  automationId: string,
  limit = 100,
): Promise<AutomationLogWithContact[]> {
  const rows = await db
    .selectFrom("automation_logs")
    .selectAll("automation_logs")
    .select((eb) =>
      eb
        .selectFrom("contacts")
        .select(sql<unknown>`json_build_object('id', contacts.id, 'name', contacts.name, 'phone', contacts.phone)`.as("c"))
        .whereRef("contacts.id", "=", "automation_logs.contact_id")
        .as("contact"),
    )
    .where("automation_logs.automation_id", "=", automationId)
    .where("automation_logs.account_id", "=", accountId)
    .orderBy("automation_logs.created_at", "desc")
    .limit(limit)
    .execute();
  return rows as unknown as AutomationLogWithContact[];
}

// ---- builder resources ------------------------------------------------

/** Pickers the automation builder needs, in one round trip per table. */
export async function getBuilderResources(db: Db, accountId: string) {
  const [templates, pipelines, stages] = await Promise.all([
    // Only APPROVED templates can actually be sent (anything else 400s
    // at send time), matching the broadcast picker.
    db
      .selectFrom("message_templates")
      .selectAll()
      .where("account_id", "=", accountId)
      .where("status", "=", "APPROVED")
      .orderBy("name")
      .execute(),
    db.selectFrom("pipelines").select(["id", "name"]).where("account_id", "=", accountId).orderBy("name").execute(),
    db
      .selectFrom("pipeline_stages")
      .innerJoin("pipelines", "pipelines.id", "pipeline_stages.pipeline_id")
      .select(["pipeline_stages.id", "pipeline_stages.name", "pipeline_stages.pipeline_id", "pipeline_stages.position"])
      .where("pipelines.account_id", "=", accountId)
      .orderBy("pipeline_stages.position")
      .execute(),
  ]);
  return { templates, pipelines, stages };
}
