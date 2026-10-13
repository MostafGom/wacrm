// API keys repository (dashboard management + auth-path lookups) and
// the store built on it, against real Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateApiKey } from "@/lib/api-keys/keys";
import { findActiveKeyByHash, getAccountName } from "@/lib/api-keys/store";
import { asService, asUser } from "@/server/db";
import {
  createApiKey,
  findApiKeyByHash,
  listApiKeys,
  revokeApiKey,
  touchApiKeyLastUsed,
} from "@/server/repos/api-keys";
import {
  joinAccount,
  seedUser,
  teardownIntegrationDb,
  useIntegrationDb,
  type SeededUser,
} from "@/test/integration/helpers";

let owner: SeededUser;
let viewer: SeededUser;
let outsider: SeededUser;

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  viewer = await seedUser("Viewer");
  outsider = await seedUser("Outsider");
  await joinAccount(viewer.id, owner.accountId, "viewer");
});

afterAll(teardownIntegrationDb);

function mint(accountId: string, userId: string, name: string, expires_at: string | null = null) {
  const k = generateApiKey();
  return {
    k,
    values: {
      account_id: accountId,
      created_by: userId,
      name,
      key_prefix: k.prefix,
      key_hash: k.hash,
      scopes: ["contacts:read"],
      expires_at,
    },
  };
}

describe("api-keys repo", () => {
  it("creates (admin) and lists safe columns only (any member)", async () => {
    const { values } = mint(owner.accountId, owner.id, "CI");
    const created = await asUser(owner.id, (db) => createApiKey(db, values));
    expect(created).not.toHaveProperty("key_hash");
    expect(created.scopes).toEqual(["contacts:read"]);

    const rows = await asUser(viewer.id, (db) => listApiKeys(db, owner.accountId));
    expect(rows.map((r) => r.name)).toEqual(["CI"]);
    expect(rows[0]).not.toHaveProperty("key_hash");

    // A viewer can't mint (RLS api_keys_insert is admin+).
    const { values: v2 } = mint(owner.accountId, viewer.id, "Nope");
    await expect(asUser(viewer.id, (db) => createApiKey(db, v2))).rejects.toMatchObject({ code: "42501" });
    expect(await asUser(outsider.id, (db) => listApiKeys(db, owner.accountId))).toEqual([]);
  });

  it("auth path resolves live keys only; revoke is account-scoped and one-shot", async () => {
    const { k, values } = mint(owner.accountId, owner.id, "Live");
    const created = await asUser(owner.id, (db) => createApiKey(db, values));

    const row = await findActiveKeyByHash(k.hash);
    expect(row).toMatchObject({ id: created.id, account_id: owner.accountId, scopes: ["contacts:read"] });
    expect(await getAccountName(owner.accountId)).toBeTruthy();

    await asService((db) => touchApiKeyLastUsed(db, owner.accountId, created.id));
    const listed = await asUser(owner.id, (db) => listApiKeys(db, owner.accountId));
    expect(listed.find((r) => r.id === created.id)?.last_used_at).toMatch(/^\d{4}-/);

    expect(await asUser(outsider.id, (db) => revokeApiKey(db, outsider.accountId, created.id))).toBe(false);
    expect(await asUser(owner.id, (db) => revokeApiKey(db, owner.accountId, created.id))).toBe(true);
    expect(await asUser(owner.id, (db) => revokeApiKey(db, owner.accountId, created.id))).toBe(false);

    expect(await findActiveKeyByHash(k.hash)).toBeNull();
    // The raw row is still there (soft revoke).
    expect((await asService((db) => findApiKeyByHash(db, k.hash)))?.revoked_at).toBeTruthy();
  });

  it("expired keys don't resolve", async () => {
    const { k, values } = mint(owner.accountId, owner.id, "Old", new Date(Date.now() - 1000).toISOString());
    await asUser(owner.id, (db) => createApiKey(db, values));
    expect(await findActiveKeyByHash(k.hash)).toBeNull();
    expect(await findActiveKeyByHash("0".repeat(64))).toBeNull();
  });
});
