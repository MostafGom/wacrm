// Pipelines and their stages (settings-class data: members read,
// admins write — see the pipelines / pipeline_stages RLS in 017).
//
// pipeline_stages has no account_id of its own; every stage query
// joins (or checks) its pipeline's account explicitly.

import { sql, type Db } from "@/server/db";

export interface StageInput {
  name: string;
  color: string;
  position: number;
}

export interface StageUpsert extends StageInput {
  id: string;
}

// ------------------------------------------------------------
// Pipelines
// ------------------------------------------------------------

export function listPipelines(db: Db, accountId: string) {
  return db
    .selectFrom("pipelines")
    .selectAll()
    .where("account_id", "=", accountId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
}

export function getPipeline(db: Db, accountId: string, pipelineId: string) {
  return db
    .selectFrom("pipelines")
    .selectAll()
    .where("id", "=", pipelineId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}

/** Insert a pipeline and its initial stages in the caller's transaction. */
export async function createPipelineWithStages(
  db: Db,
  values: { account_id: string; user_id: string; name: string },
  stages: StageInput[],
) {
  const pipeline = await db.insertInto("pipelines").values(values).returningAll().executeTakeFirstOrThrow();
  if (stages.length > 0) {
    await db
      .insertInto("pipeline_stages")
      .values(stages.map((s) => ({ ...s, pipeline_id: pipeline.id })))
      .execute();
  }
  return pipeline;
}

export function renamePipeline(db: Db, accountId: string, pipelineId: string, name: string) {
  return db
    .updateTable("pipelines")
    .set({ name })
    .where("id", "=", pipelineId)
    .where("account_id", "=", accountId)
    .returningAll()
    .executeTakeFirst();
}

/** Delete a pipeline; its stages and deals cascade. */
export async function deletePipeline(db: Db, accountId: string, pipelineId: string): Promise<boolean> {
  const r = await db
    .deleteFrom("pipelines")
    .where("id", "=", pipelineId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

// ------------------------------------------------------------
// Stages
// ------------------------------------------------------------

export function listStages(db: Db, accountId: string, pipelineId: string) {
  return db
    .selectFrom("pipeline_stages")
    .innerJoin("pipelines", "pipelines.id", "pipeline_stages.pipeline_id")
    .selectAll("pipeline_stages")
    .where("pipeline_stages.pipeline_id", "=", pipelineId)
    .where("pipelines.account_id", "=", accountId)
    .orderBy("pipeline_stages.position")
    .orderBy("pipeline_stages.created_at")
    .execute();
}

/** Append one stage. Undefined when the pipeline isn't in the account. */
export async function insertStage(db: Db, accountId: string, pipelineId: string, stage: StageInput) {
  if (!(await getPipeline(db, accountId, pipelineId))) return undefined;
  return db
    .insertInto("pipeline_stages")
    .values({ ...stage, pipeline_id: pipelineId })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Write every stage of a pipeline in one statement (name, colour and
 * position — the settings dialog's save). Rows are keyed by id; an id
 * that already belongs to ANOTHER pipeline is left untouched by the
 * conflict guard. Undefined when the pipeline isn't in the account.
 */
export async function upsertStages(db: Db, accountId: string, pipelineId: string, stages: StageUpsert[]) {
  if (!(await getPipeline(db, accountId, pipelineId))) return undefined;
  if (stages.length === 0) return [];
  return db
    .insertInto("pipeline_stages")
    .values(stages.map((s) => ({ ...s, pipeline_id: pipelineId })))
    .onConflict((oc) =>
      oc
        .column("id")
        .doUpdateSet({
          name: (eb) => eb.ref("excluded.name"),
          color: (eb) => eb.ref("excluded.color"),
          position: (eb) => eb.ref("excluded.position"),
        })
        .where("pipeline_stages.pipeline_id", "=", pipelineId),
    )
    .returningAll()
    .execute();
}

/** Deals still referencing a stage (scoped to the account). */
export async function countDealsInStage(db: Db, accountId: string, stageId: string): Promise<number> {
  const r = await db
    .selectFrom("deals")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("stage_id", "=", stageId)
    .where("account_id", "=", accountId)
    .executeTakeFirstOrThrow();
  return r.n;
}

export async function deleteStage(db: Db, accountId: string, pipelineId: string, stageId: string): Promise<boolean> {
  const r = await db
    .deleteFrom("pipeline_stages")
    .where("id", "=", stageId)
    .where("pipeline_id", "=", pipelineId)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("pipelines")
          .select("pipelines.id")
          .where("pipelines.id", "=", pipelineId)
          .where("pipelines.account_id", "=", accountId),
      ),
    )
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}
