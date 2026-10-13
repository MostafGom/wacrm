import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService } from "@/server/db";
import {
  insertTemplateStub,
  listConfigOwnersByWabaId,
  updateTemplatesByMetaId,
} from "@/server/repos/inbound-templates";
import { seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let a: SeededUser;

beforeAll(async () => {
  useIntegrationDb();
  a = await seedUser("A");
  await asService((db) =>
    db
      .insertInto("whatsapp_config")
      .values({ account_id: a.accountId, user_id: a.id, phone_number_id: "pn-t", access_token: "t", waba_id: "WABA-T" })
      .execute(),
  );
});

afterAll(teardownIntegrationDb);

describe("inbound-templates repo", () => {
  it("resolves the tenant from a WABA id", async () => {
    expect(await asService((db) => listConfigOwnersByWabaId(db, "WABA-T"))).toEqual([
      { account_id: a.accountId, user_id: a.id },
    ]);
    expect(await asService((db) => listConfigOwnersByWabaId(db, "WABA-NONE"))).toEqual([]);
  });

  it("stubs an unknown template, then updates it by meta id; a duplicate stub is a no-op (#534)", async () => {
    expect(await asService((db) => updateTemplatesByMetaId(db, "555", { status: "APPROVED" }))).toEqual([]);

    const stub = {
      account_id: a.accountId,
      user_id: a.id,
      meta_template_id: "555",
      name: "created_in_meta",
      language: "en_US",
      body_text: "",
      status: "APPROVED",
      rejection_reason: null,
      submission_error: null,
    };
    expect(await asService((db) => insertTemplateStub(db, stub))).toBe(true);
    // Same (user, name, language): ON CONFLICT DO NOTHING, not a 23505.
    expect(await asService((db) => insertTemplateStub(db, { ...stub, meta_template_id: "556" }))).toBe(false);

    const ids = await asService((db) => updateTemplatesByMetaId(db, "555", { quality_score: "RED" }));
    expect(ids).toHaveLength(1);
    const row = await asService((db) =>
      db
        .selectFrom("message_templates")
        .select(["status", "quality_score", "category"])
        .where("id", "=", ids[0])
        .executeTakeFirstOrThrow(),
    );
    expect(row.status).toBe("APPROVED");
    expect(row.quality_score).toBe("RED");
  });
});
