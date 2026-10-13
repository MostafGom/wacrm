import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService } from "@/server/db";
import {
  listConfigsByPhoneNumberId,
  listVerifyTokenConfigs,
  setConfigVerifyToken,
} from "@/server/repos/inbound-config";
import { seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let a: SeededUser;
let b: SeededUser;
let configA: string;

beforeAll(async () => {
  useIntegrationDb();
  a = await seedUser("A");
  b = await seedUser("B");
  configA = await asService(async (db) => {
    const rows = await db
      .insertInto("whatsapp_config")
      .values([
        { account_id: a.accountId, user_id: a.id, phone_number_id: "pn-a", access_token: "tok-a", verify_token: "vt-a" },
        { account_id: b.accountId, user_id: b.id, phone_number_id: "pn-b", access_token: "tok-b", verify_token: null },
      ])
      .returning(["id", "account_id"])
      .execute();
    return rows.find((r) => r.account_id === a.accountId)!.id;
  });
});

afterAll(teardownIntegrationDb);

describe("inbound-config repo", () => {
  it("resolves the owning account from the phone_number_id", async () => {
    const rows = await asService((db) => listConfigsByPhoneNumberId(db, "pn-a"));
    expect(rows).toEqual([{ account_id: a.accountId, user_id: a.id, access_token: "tok-a", mirror_inbound_media: true }]);
    expect(await asService((db) => listConfigsByPhoneNumberId(db, "pn-nobody"))).toEqual([]);
  });

  it("lists only configs that have a verify token, and rewrites one", async () => {
    const rows = await asService((db) => listVerifyTokenConfigs(db));
    expect(rows).toEqual([{ id: configA, verify_token: "vt-a" }]);

    await asService((db) => setConfigVerifyToken(db, configA, "vt-a2"));
    const after = await asService((db) => listVerifyTokenConfigs(db));
    expect(after[0].verify_token).toBe("vt-a2");
  });
});
