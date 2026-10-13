// Pipelines + stages repository against real Postgres: account
// scoping, the admin-only RLS on writes, and the one-statement stage
// upsert used by the settings dialog.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser } from "@/server/db";
import {
  countDealsInStage,
  createPipelineWithStages,
  deletePipeline,
  deleteStage,
  getPipeline,
  insertStage,
  listPipelines,
  listStages,
  renamePipeline,
  upsertStages,
} from "@/server/repos/pipelines";
import { joinAccount, seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let owner: SeededUser;
let agent: SeededUser;
let outsider: SeededUser;
let pipelineId: string;

const STAGES = [
  { name: "New", color: "#3b82f6", position: 0 },
  { name: "Won", color: "#22c55e", position: 1 },
];

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  agent = await seedUser("Agent");
  outsider = await seedUser("Outsider");
  await joinAccount(agent.id, owner.accountId, "agent");
  const p = await asUser(owner.id, (db) =>
    createPipelineWithStages(db, { account_id: owner.accountId, user_id: owner.id, name: "Sales" }, STAGES),
  );
  pipelineId = p.id;
});

afterAll(teardownIntegrationDb);

describe("pipelines repo", () => {
  it("creates a pipeline with its stages and lists them for members only", async () => {
    const asAgent = await asUser(agent.id, (db) => listPipelines(db, owner.accountId));
    expect(asAgent.map((p) => p.name)).toEqual(["Sales"]);
    expect(asAgent[0].created_at).toMatch(/\+00:00$/);

    const stages = await asUser(agent.id, (db) => listStages(db, owner.accountId, pipelineId));
    expect(stages.map((s) => [s.name, s.position])).toEqual([
      ["New", 0],
      ["Won", 1],
    ]);

    // Explicit scoping + RLS: another account sees nothing.
    expect(await asUser(outsider.id, (db) => listPipelines(db, owner.accountId))).toEqual([]);
    expect(await asUser(outsider.id, (db) => listStages(db, owner.accountId, pipelineId))).toEqual([]);
    expect(await asUser(outsider.id, (db) => listStages(db, outsider.accountId, pipelineId))).toEqual([]);
  });

  it("refuses pipeline writes from a non-admin (RLS)", async () => {
    await expect(
      asUser(agent.id, (db) =>
        createPipelineWithStages(db, { account_id: owner.accountId, user_id: agent.id, name: "Nope" }, []),
      ),
    ).rejects.toThrow();
    expect(await asUser(agent.id, (db) => renamePipeline(db, owner.accountId, pipelineId, "Hacked"))).toBeUndefined();
  });

  it("upserts all stages in one statement (rename, recolour, reorder)", async () => {
    const before = await asUser(owner.id, (db) => listStages(db, owner.accountId, pipelineId));
    const [a, b] = before;
    const saved = await asUser(owner.id, (db) =>
      upsertStages(db, owner.accountId, pipelineId, [
        { id: b.id, name: "Closed", color: "#000000", position: 0 },
        { id: a.id, name: "Lead", color: a.color, position: 1 },
      ]),
    );
    expect(saved).toHaveLength(2);
    const after = await asUser(owner.id, (db) => listStages(db, owner.accountId, pipelineId));
    expect(after.map((s) => [s.id, s.name, s.position])).toEqual([
      [b.id, "Closed", 0],
      [a.id, "Lead", 1],
    ]);
  });

  it("does not let an upsert move another pipeline's stage", async () => {
    const other = await asUser(owner.id, (db) =>
      createPipelineWithStages(db, { account_id: owner.accountId, user_id: owner.id, name: "Other" }, [
        { name: "Theirs", color: "#111111", position: 0 },
      ]),
    );
    const [theirs] = await asUser(owner.id, (db) => listStages(db, owner.accountId, other.id));
    await asUser(owner.id, (db) =>
      upsertStages(db, owner.accountId, pipelineId, [{ id: theirs.id, name: "Stolen", color: "#222222", position: 9 }]),
    );
    const [still] = await asUser(owner.id, (db) => listStages(db, owner.accountId, other.id));
    expect(still).toMatchObject({ id: theirs.id, name: "Theirs", pipeline_id: other.id });

    // A pipeline outside the account → undefined (route answers 404).
    expect(await asUser(outsider.id, (db) => upsertStages(db, outsider.accountId, pipelineId, []))).toBeUndefined();
    await asUser(owner.id, (db) => deletePipeline(db, owner.accountId, other.id));
  });

  it("adds and deletes stages; counts the deals blocking a delete", async () => {
    const stage = await asUser(owner.id, (db) =>
      insertStage(db, owner.accountId, pipelineId, { name: "Extra", color: "#ff0000", position: 2 }),
    );
    expect(stage).toMatchObject({ name: "Extra", pipeline_id: pipelineId, position: 2 });
    expect(await asUser(outsider.id, (db) => insertStage(db, outsider.accountId, pipelineId, STAGES[0]))).toBeUndefined();

    await asUser(agent.id, (db) =>
      db
        .insertInto("deals")
        .values({
          account_id: owner.accountId,
          user_id: agent.id,
          pipeline_id: pipelineId,
          stage_id: stage!.id,
          title: "Blocker",
        })
        .execute(),
    );
    expect(await asUser(owner.id, (db) => countDealsInStage(db, owner.accountId, stage!.id))).toBe(1);
    expect(await asUser(outsider.id, (db) => countDealsInStage(db, outsider.accountId, stage!.id))).toBe(0);

    await asUser(owner.id, (db) => db.deleteFrom("deals").where("stage_id", "=", stage!.id).execute());
    // Agents can't delete stages (pipeline_stages_modify is admin+).
    expect(await asUser(agent.id, (db) => deleteStage(db, owner.accountId, pipelineId, stage!.id))).toBe(false);
    expect(await asUser(owner.id, (db) => deleteStage(db, owner.accountId, pipelineId, stage!.id))).toBe(true);
  });

  it("renames and deletes (stages cascade)", async () => {
    const renamed = await asUser(owner.id, (db) => renamePipeline(db, owner.accountId, pipelineId, "Renamed"));
    expect(renamed?.name).toBe("Renamed");
    expect(await asUser(outsider.id, (db) => deletePipeline(db, outsider.accountId, pipelineId))).toBe(false);
    expect(await asUser(owner.id, (db) => deletePipeline(db, owner.accountId, pipelineId))).toBe(true);
    expect(await asUser(owner.id, (db) => getPipeline(db, owner.accountId, pipelineId))).toBeUndefined();
    expect(await asUser(owner.id, (db) => listStages(db, owner.accountId, pipelineId))).toEqual([]);
  });
});
