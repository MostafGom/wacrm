// Engine-side CRM reads/writes against real Postgres. Everything runs as
// the service role (RLS off), so these assert the explicit account
// scoping each function promises.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService } from "@/server/db";
import {
  assignContactConversations,
  closeContactConversations,
  contactHasTag,
  contactInAccount,
  conversationInAccount,
  customFieldInAccount,
  deleteContactTag,
  findConversationIdForContact,
  findMessageIdByWaId,
  getAccountDefaultCurrency,
  getContactFieldValue,
  getSendContact,
  handoffConversation,
  insertDeal,
  recordBotMessage,
  updateContactField,
  updateContactPhone,
  upsertContactCustomValue,
} from "@/server/repos/engine-data";
import { seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let owner: SeededUser;
let stranger: SeededUser;
const ids = {} as { contact: string; conversation: string; tag: string; field: string; foreignConversation: string };

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  stranger = await seedUser("Stranger");
  Object.assign(
    ids,
    await asService(async (db) => {
      const contact = await db
        .insertInto("contacts")
        .values({ account_id: owner.accountId, user_id: owner.id, phone: "+15550100", name: "Ann", email: "a@x.test" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const conversation = await db
        .insertInto("conversations")
        .values({ account_id: owner.accountId, user_id: owner.id, contact_id: contact.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      const tag = await db
        .insertInto("tags")
        .values({ account_id: owner.accountId, user_id: owner.id, name: "VIP" })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db.insertInto("contact_tags").values({ contact_id: contact.id, tag_id: tag.id }).execute();
      const field = await db
        .insertInto("custom_fields")
        .values({ account_id: owner.accountId, user_id: owner.id, field_name: "Plan" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const otherContact = await db
        .insertInto("contacts")
        .values({ account_id: stranger.accountId, user_id: stranger.id, phone: "+15550200" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const foreign = await db
        .insertInto("conversations")
        .values({ account_id: stranger.accountId, user_id: stranger.id, contact_id: otherContact.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      return {
        contact: contact.id,
        conversation: conversation.id,
        tag: tag.id,
        field: field.id,
        foreignConversation: foreign.id,
      };
    }),
  );
});

afterAll(teardownIntegrationDb);

describe("engine-data tenancy checks", () => {
  it("answers ownership questions per account", async () => {
    await asService(async (db) => {
      expect(await contactInAccount(db, owner.accountId, ids.contact)).toBe(true);
      expect(await contactInAccount(db, stranger.accountId, ids.contact)).toBe(false);
      expect(await conversationInAccount(db, owner.accountId, ids.conversation)).toBe(true);
      expect(await conversationInAccount(db, owner.accountId, ids.foreignConversation)).toBe(false);
      expect(await customFieldInAccount(db, stranger.accountId, ids.field)).toBe(false);
      expect(await findConversationIdForContact(db, owner.accountId, ids.contact)).toBe(ids.conversation);
      expect(await findConversationIdForContact(db, stranger.accountId, ids.contact)).toBeNull();
      expect(await getSendContact(db, stranger.accountId, ids.contact)).toBeUndefined();
    });
  });
});

describe("engine-data contact writes", () => {
  it("reads whitelisted contact fields only", async () => {
    await asService(async (db) => {
      expect(await getContactFieldValue(db, owner.accountId, ids.contact, "email")).toBe("a@x.test");
      expect(await getContactFieldValue(db, owner.accountId, ids.contact, "company")).toBeNull();
      expect(await getContactFieldValue(db, owner.accountId, ids.contact, "account_id")).toBeUndefined();
      expect(await getContactFieldValue(db, owner.accountId, ids.contact, "name; DROP TABLE contacts")).toBeUndefined();
      expect(await getContactFieldValue(db, stranger.accountId, ids.contact, "email")).toBeUndefined();
    });
  });

  it("updates fields, phone and custom values inside the account", async () => {
    await asService(async (db) => {
      await updateContactField(db, stranger.accountId, ids.contact, "company", "pwned");
      await updateContactField(db, owner.accountId, ids.contact, "company", "Acme");
      await updateContactPhone(db, owner.accountId, ids.contact, "+15550101");
      await upsertContactCustomValue(db, owner.accountId, ids.contact, ids.field, "Basic");
      await upsertContactCustomValue(db, owner.accountId, ids.contact, ids.field, "Premium");
      await upsertContactCustomValue(db, stranger.accountId, ids.contact, ids.field, "Foreign");
      expect(await getContactFieldValue(db, owner.accountId, ids.contact, "company")).toBe("Acme");
      expect((await getSendContact(db, owner.accountId, ids.contact))?.phone).toBe("+15550101");
      const values = await db
        .selectFrom("contact_custom_values")
        .select("value")
        .where("contact_id", "=", ids.contact)
        .execute();
      expect(values.map((v) => v.value)).toEqual(["Premium"]);
    });
  });

  it("checks and removes tags through the contact's account", async () => {
    await asService(async (db) => {
      expect(await contactHasTag(db, stranger.accountId, ids.contact, ids.tag)).toBe(false);
      expect(await contactHasTag(db, owner.accountId, ids.contact, ids.tag)).toBe(true);
      await deleteContactTag(db, stranger.accountId, ids.contact, ids.tag);
      expect(await contactHasTag(db, owner.accountId, ids.contact, ids.tag)).toBe(true);
      await deleteContactTag(db, owner.accountId, ids.contact, ids.tag);
      expect(await contactHasTag(db, owner.accountId, ids.contact, ids.tag)).toBe(false);
    });
  });
});

describe("engine-data conversations + messages", () => {
  it("records a bot message only into the account's conversation", async () => {
    await asService(async (db) => {
      expect(
        await recordBotMessage(db, owner.accountId, {
          conversationId: ids.foreignConversation,
          contentType: "text",
          contentText: "injected",
          waMessageId: "wamid.evil",
          preview: "injected",
        }),
      ).toBe(false);
      expect(
        await recordBotMessage(db, owner.accountId, {
          conversationId: ids.conversation,
          contentType: "interactive",
          contentText: "Pick one",
          interactivePayload: { kind: "buttons", body: "Pick one", buttons: [{ id: "a", title: "A" }] },
          waMessageId: "wamid.1",
          aiGenerated: true,
          preview: "Pick one",
        }),
      ).toBe(true);
      const msg = await db
        .selectFrom("messages")
        .selectAll()
        .where("message_id", "=", "wamid.1")
        .executeTakeFirstOrThrow();
      expect(msg).toMatchObject({
        sender_type: "bot",
        content_type: "interactive",
        status: "sent",
        ai_generated: true,
        template_name: null,
        interactive_payload: { kind: "buttons", body: "Pick one", buttons: [{ id: "a", title: "A" }] },
      });
      const conv = await db
        .selectFrom("conversations")
        .select(["last_message_text", "last_message_at"])
        .where("id", "=", ids.conversation)
        .executeTakeFirstOrThrow();
      expect(conv.last_message_text).toBe("Pick one");
      expect(conv.last_message_at).not.toBeNull();
      expect(await findMessageIdByWaId(db, owner.accountId, "wamid.1")).toBe(msg.id);
      expect(await findMessageIdByWaId(db, stranger.accountId, "wamid.1")).toBeNull();
      expect(
        await db.selectFrom("messages").select("id").where("message_id", "=", "wamid.evil").execute(),
      ).toEqual([]);
    });
  });

  it("assigns, hands off and closes only the account's conversations", async () => {
    await asService(async (db) => {
      await assignContactConversations(db, owner.accountId, ids.contact, owner.id);
      await handoffConversation(db, stranger.accountId, ids.conversation, stranger.id);
      let conv = await db.selectFrom("conversations").selectAll().where("id", "=", ids.conversation).executeTakeFirstOrThrow();
      expect(conv.assigned_agent_id).toBe(owner.id);
      expect(conv.status).not.toBe("pending");
      await handoffConversation(db, owner.accountId, ids.conversation);
      conv = await db.selectFrom("conversations").selectAll().where("id", "=", ids.conversation).executeTakeFirstOrThrow();
      expect(conv.status).toBe("pending");
      expect(conv.assigned_agent_id).toBe(owner.id);
      await closeContactConversations(db, owner.accountId, ids.contact);
      conv = await db.selectFrom("conversations").selectAll().where("id", "=", ids.conversation).executeTakeFirstOrThrow();
      expect(conv.status).toBe("closed");
    });
  });

  it("creates deals in the account's currency", async () => {
    await asService(async (db) => {
      const currency = await getAccountDefaultCurrency(db, owner.accountId);
      expect(typeof currency).toBe("string");
      const pipeline = await db
        .insertInto("pipelines")
        .values({ account_id: owner.accountId, user_id: owner.id, name: "P" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const stage = await db
        .insertInto("pipeline_stages")
        .values({ pipeline_id: pipeline.id, name: "S" })
        .returning("id")
        .executeTakeFirstOrThrow();
      await insertDeal(db, {
        account_id: owner.accountId,
        user_id: owner.id,
        pipeline_id: pipeline.id,
        stage_id: stage.id,
        contact_id: ids.contact,
        title: "Deal",
        value: 12.5,
        currency: currency ?? "USD",
      });
      const deal = await db.selectFrom("deals").selectAll().where("title", "=", "Deal").executeTakeFirstOrThrow();
      expect(deal).toMatchObject({ status: "open", value: 12.5, account_id: owner.accountId });
    });
  });
});
