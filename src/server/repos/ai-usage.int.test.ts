import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser } from "@/server/db";
import { insertAiUsageLog, listAiUsageSince } from "@/server/repos/ai-usage";
import {
  joinAccount,
  seedUser,
  teardownIntegrationDb,
  useIntegrationDb,
  type SeededUser,
} from "@/test/integration/helpers";

let owner: SeededUser;
let agent: SeededUser;
let other: SeededUser;

const row = (accountId: string, model: string) => ({
  account_id: accountId,
  conversation_id: null,
  mode: "draft" as const,
  provider: "openai",
  model,
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
});

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  agent = await seedUser("Agent");
  other = await seedUser("Other");
  await joinAccount(agent.id, owner.accountId, "agent");
});

afterAll(teardownIntegrationDb);

describe("ai-usage repo", () => {
  it("service role writes; admins read their account's rows", async () => {
    await asService((db) => insertAiUsageLog(db, row(owner.accountId, "m1")));
    await asService((db) => insertAiUsageLog(db, row(owner.accountId, "m2")));
    await asService((db) => insertAiUsageLog(db, row(other.accountId, "m3")));

    const since = new Date(Date.now() - 86_400_000).toISOString();
    const rows = await asUser(owner.id, (db) => listAiUsageSince(db, owner.accountId, since, 10));
    expect(rows.map((r) => r.model).sort()).toEqual(["m1", "m2"]);
    expect(rows[0]).toMatchObject({ mode: "draft", prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(rows[0].created_at).toMatch(/\+00:00$/);

    expect(await asUser(owner.id, (db) => listAiUsageSince(db, owner.accountId, since, 1))).toHaveLength(1);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await asUser(owner.id, (db) => listAiUsageSince(db, owner.accountId, future, 10))).toEqual([]);
  });

  it("is admin-only to read and has no user-role insert (RLS)", async () => {
    const since = new Date(0).toISOString();
    expect(await asUser(agent.id, (db) => listAiUsageSince(db, owner.accountId, since, 10))).toEqual([]);
    await expect(asUser(owner.id, (db) => insertAiUsageLog(db, row(owner.accountId, "x")))).rejects.toThrow();
  });
});
