import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser } from "@/server/db";
import {
  deleteAiConfig,
  getAiConfigCredentials,
  getAiConfigSecrets,
  getAiConfigSummary,
  getEmbeddingsKeyCipher,
  insertAiConfig,
  isAccountMember,
  updateAiConfig,
} from "@/server/repos/ai-config";
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

const BASE = {
  provider: "openai" as const,
  model: "gpt-x",
  base_url: null,
  system_prompt: "Be nice",
  is_active: true,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
};

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  agent = await seedUser("Agent");
  other = await seedUser("Other");
  await joinAccount(agent.id, owner.accountId, "agent");
});

afterAll(teardownIntegrationDb);

describe("ai-config repo", () => {
  it("admin inserts; members read a summary without ciphertext", async () => {
    await asUser(owner.id, (db) =>
      insertAiConfig(db, { ...BASE, account_id: owner.accountId, created_by: owner.id, api_key: "cipher-1" }),
    );
    const summary = await asUser(agent.id, (db) => getAiConfigSummary(db, owner.accountId));
    expect(summary).toEqual({
      ...BASE,
      handoff_agent_id: null,
      has_key: true,
      has_embeddings_key: false,
    });
    expect(summary).not.toHaveProperty("api_key");
    expect(summary).not.toHaveProperty("embeddings_api_key");
    expect(await asUser(other.id, (db) => getAiConfigSummary(db, other.accountId))).toBeUndefined();
  });

  it("agents cannot write the config (RLS: admin writes)", async () => {
    await asUser(agent.id, (db) => updateAiConfig(db, owner.accountId, { ...BASE, model: "hijack" }));
    const creds = await asUser(owner.id, (db) => getAiConfigCredentials(db, owner.accountId));
    expect(creds).toMatchObject({ provider: "openai", model: "gpt-x", base_url: null, api_key: "cipher-1" });
  });

  it("updates settings + embeddings key and exposes secrets server-side only", async () => {
    await asUser(owner.id, (db) =>
      updateAiConfig(db, owner.accountId, {
        ...BASE,
        handoff_agent_id: agent.id,
        embeddings_api_key: "emb-cipher",
      }),
    );
    expect(await asService((db) => getEmbeddingsKeyCipher(db, owner.accountId))).toBe("emb-cipher");
    const secrets = await asService((db) => getAiConfigSecrets(db, owner.accountId));
    expect(secrets).toMatchObject({ api_key: "cipher-1", embeddings_api_key: "emb-cipher", handoff_agent_id: agent.id });
    const summary = await asUser(agent.id, (db) => getAiConfigSummary(db, owner.accountId));
    expect(summary?.has_embeddings_key).toBe(true);
    expect(await asService((db) => getEmbeddingsKeyCipher(db, other.accountId))).toBeNull();
  });

  it("checks account membership for the handoff target", async () => {
    expect(await asUser(owner.id, (db) => isAccountMember(db, owner.accountId, agent.id))).toBe(true);
    expect(await asUser(owner.id, (db) => isAccountMember(db, owner.accountId, other.id))).toBe(false);
  });

  it("admin deletes the config", async () => {
    await asUser(owner.id, (db) => deleteAiConfig(db, owner.accountId));
    expect(await asService((db) => getAiConfigSecrets(db, owner.accountId))).toBeUndefined();
  });
});
