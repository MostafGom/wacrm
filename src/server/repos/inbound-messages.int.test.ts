import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService } from "@/server/db";
import {
  bumpConversationOnInbound,
  countCustomerMessages,
  deleteCustomerReaction,
  findContactByWaUserId,
  findMessageIdByMetaId,
  findOldestConversation,
  insertInboundContact,
  insertInboundConversation,
  insertInboundMessage,
  markLatestBroadcastReplied,
  reopenConversationIfClosed,
  updateContactIdentity,
  upsertCustomerReaction,
} from "@/server/repos/inbound-messages";
import { seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let a: SeededUser;
let b: SeededUser;
let contactId: string;
let conversationId: string;

const BSUID = "US.13491208655302741918";

beforeAll(async () => {
  useIntegrationDb();
  a = await seedUser("A");
  b = await seedUser("B");
});

afterAll(teardownIntegrationDb);

describe("inbound-messages repo: contacts", () => {
  it("inserts a contact, and a racing duplicate BSUID becomes a no-op (null)", async () => {
    const row = {
      account_id: a.accountId,
      user_id: a.id,
      phone: "",
      name: "Sheena",
      wa_user_id: BSUID,
      wa_parent_user_id: null,
      wa_username: "sheena",
    };
    const created = await asService((db) => insertInboundContact(db, row));
    expect(created?.wa_user_id).toBe(BSUID);
    contactId = created!.id;

    // Migration 040's unique index — ON CONFLICT DO NOTHING, no 23505.
    expect(await asService((db) => insertInboundContact(db, row))).toBeNull();
    // Same BSUID in another account is a different person.
    const other = await asService((db) =>
      insertInboundContact(db, { ...row, account_id: b.accountId, user_id: b.id }),
    );
    expect(other).not.toBeNull();
  });

  it("looks contacts up by BSUID within the account only", async () => {
    expect((await asService((db) => findContactByWaUserId(db, a.accountId, BSUID)))?.id).toBe(contactId);
    const inB = await asService((db) => findContactByWaUserId(db, b.accountId, BSUID));
    expect(inB?.id).not.toBe(contactId);
  });

  it("backfills identity fields, scoped to the account", async () => {
    expect(await asService((db) => updateContactIdentity(db, b.accountId, contactId, { phone: "15550001111" }))).toBeNull();
    const updated = await asService((db) => updateContactIdentity(db, a.accountId, contactId, { phone: "15550001111" }));
    expect(updated?.phone).toBe("15550001111");
  });
});

describe("inbound-messages repo: conversations + messages", () => {
  it("creates one conversation per (account, contact); a racing insert returns null", async () => {
    expect(await asService((db) => findOldestConversation(db, a.accountId, contactId))).toBeNull();
    const row = { account_id: a.accountId, user_id: a.id, contact_id: contactId };
    const created = await asService((db) => insertInboundConversation(db, row));
    conversationId = created!.id;
    expect(await asService((db) => insertInboundConversation(db, row))).toBeNull();
    expect((await asService((db) => findOldestConversation(db, a.accountId, contactId)))?.id).toBe(conversationId);
    // Another account never sees it.
    expect(await asService((db) => findOldestConversation(db, b.accountId, contactId))).toBeNull();
  });

  it("inserts a message idempotently on (conversation_id, message_id) (#367)", async () => {
    expect(await asService((db) => countCustomerMessages(db, conversationId))).toBe(0);
    const msg = {
      conversation_id: conversationId,
      sender_type: "customer",
      content_type: "text",
      content_text: "hi",
      message_id: "wamid.ONE",
      status: "delivered",
      created_at: new Date(1700000000 * 1000).toISOString(),
    };
    const id = await asService((db) => insertInboundMessage(db, msg));
    expect(id).toEqual(expect.any(String));
    // Meta replays the same wamid: no error, no second row.
    expect(await asService((db) => insertInboundMessage(db, msg))).toBeNull();
    expect(await asService((db) => countCustomerMessages(db, conversationId))).toBe(1);
    expect(await asService((db) => findMessageIdByMetaId(db, conversationId, "wamid.ONE"))).toBe(id);
    expect(await asService((db) => findMessageIdByMetaId(db, conversationId, "wamid.NONE"))).toBeNull();
  });

  it("bumps unread atomically through the RPC (#369)", async () => {
    await asService((db) => bumpConversationOnInbound(db, conversationId, "first"));
    await asService((db) => bumpConversationOnInbound(db, conversationId, "second"));
    const conv = await asService((db) => findOldestConversation(db, a.accountId, contactId));
    expect(conv?.unread_count).toBe(2);
    expect(conv?.last_message_text).toBe("second");
  });

  it("re-opens only a closed conversation, only inside the account (#409)", async () => {
    expect(await asService((db) => reopenConversationIfClosed(db, a.accountId, conversationId))).toBe(false);
    await asService((db) =>
      db.updateTable("conversations").set({ status: "closed" }).where("id", "=", conversationId).execute(),
    );
    expect(await asService((db) => reopenConversationIfClosed(db, b.accountId, conversationId))).toBe(false);
    expect(await asService((db) => reopenConversationIfClosed(db, a.accountId, conversationId))).toBe(true);
    const conv = await asService((db) => findOldestConversation(db, a.accountId, contactId));
    expect(conv?.status).toBe("open");
  });

  it("upserts and deletes a customer reaction", async () => {
    const messageId = (await asService((db) => findMessageIdByMetaId(db, conversationId, "wamid.ONE")))!;
    const react = (emoji: string) =>
      asService((db) =>
        upsertCustomerReaction(db, { message_id: messageId, conversation_id: conversationId, contact_id: contactId, emoji }),
      );
    await react("👍");
    await react("❤️");
    const rows = () =>
      asService((db) => db.selectFrom("message_reactions").select("emoji").where("message_id", "=", messageId).execute());
    expect(await rows()).toEqual([{ emoji: "❤️" }]);
    await asService((db) => deleteCustomerReaction(db, messageId, contactId));
    expect(await rows()).toEqual([]);
  });
});

describe("inbound-messages repo: broadcast replies", () => {
  it("flips the contact's latest unreplied recipient in this account to replied", async () => {
    const recipientId = await asService(async (db) => {
      const bc = await db
        .insertInto("broadcasts")
        .values({ account_id: a.accountId, user_id: a.id, name: "promo", template_name: "promo" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const rec = await db
        .insertInto("broadcast_recipients")
        .values({ broadcast_id: bc.id, contact_id: contactId, status: "delivered", whatsapp_message_id: "wamid.BC" })
        .returning("id")
        .executeTakeFirstOrThrow();
      return rec.id;
    });

    expect(await asService((db) => markLatestBroadcastReplied(db, b.accountId, contactId))).toBeNull();
    expect(await asService((db) => markLatestBroadcastReplied(db, a.accountId, contactId))).toBe(recipientId);
    const rec = await asService((db) =>
      db
        .selectFrom("broadcast_recipients")
        .select(["status", "replied_at"])
        .where("id", "=", recipientId)
        .executeTakeFirstOrThrow(),
    );
    expect(rec.status).toBe("replied");
    expect(rec.replied_at).not.toBeNull();
    // Already replied → nothing left to flag.
    expect(await asService((db) => markLatestBroadcastReplied(db, a.accountId, contactId))).toBeNull();
  });
});
