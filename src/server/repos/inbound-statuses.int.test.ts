import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService } from "@/server/db";
import {
  findBroadcastRecipientByWamid,
  updateBroadcastRecipient,
  updateMessageStatusByWamid,
} from "@/server/repos/inbound-statuses";
import { seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let a: SeededUser;
let b: SeededUser;
let conversationId: string;
let recipientId: string;

beforeAll(async () => {
  useIntegrationDb();
  a = await seedUser("A");
  b = await seedUser("B");
  ({ conversationId, recipientId } = await asService(async (db) => {
    const contact = await db
      .insertInto("contacts")
      .values({ account_id: a.accountId, user_id: a.id, phone: "15551230000" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const conv = await db
      .insertInto("conversations")
      .values({ account_id: a.accountId, user_id: a.id, contact_id: contact.id })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("messages")
      .values({ conversation_id: conv.id, sender_type: "agent", message_id: "wamid.OUT", status: "sent" })
      .execute();
    const bc = await db
      .insertInto("broadcasts")
      .values({ account_id: a.accountId, user_id: a.id, name: "promo", template_name: "promo" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const rec = await db
      .insertInto("broadcast_recipients")
      .values({ broadcast_id: bc.id, contact_id: contact.id, status: "sent", whatsapp_message_id: "wamid.BC-ST" })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { conversationId: conv.id, recipientId: rec.id };
  }));
});

afterAll(teardownIntegrationDb);

describe("inbound-statuses repo", () => {
  it("mirrors a status (with failure reason) onto the account's messages only", async () => {
    const patch = { status: "failed", error_code: 131049, error_title: "Not delivered", error_details: "eco" };
    expect(await asService((db) => updateMessageStatusByWamid(db, b.accountId, "wamid.OUT", patch))).toBeNull();
    expect(await asService((db) => updateMessageStatusByWamid(db, a.accountId, "wamid.OUT", patch))).toBe(conversationId);
    const msg = await asService((db) =>
      db
        .selectFrom("messages")
        .select(["status", "error_code", "error_title", "error_details"])
        .where("message_id", "=", "wamid.OUT")
        .executeTakeFirstOrThrow(),
    );
    expect(msg).toEqual(patch);
    expect(await asService((db) => updateMessageStatusByWamid(db, a.accountId, "wamid.NONE", patch))).toBeNull();
  });

  it("finds a broadcast recipient by wamid inside the account and updates it", async () => {
    expect(await asService((db) => findBroadcastRecipientByWamid(db, b.accountId, "wamid.BC-ST"))).toBeNull();
    const rec = await asService((db) => findBroadcastRecipientByWamid(db, a.accountId, "wamid.BC-ST"));
    expect(rec).toEqual({ id: recipientId, status: "sent" });

    const ts = new Date(1700000000 * 1000).toISOString();
    await asService((db) => updateBroadcastRecipient(db, recipientId, { status: "delivered", delivered_at: ts }));
    const after = await asService((db) => findBroadcastRecipientByWamid(db, a.accountId, "wamid.BC-ST"));
    expect(after?.status).toBe("delivered");
  });
});
