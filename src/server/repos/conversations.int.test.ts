// Inbox repositories (conversations, messages, reactions) and the
// phone → conversation resolver against real Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser, serviceRunner } from "@/server/db";
import { insertContact } from "@/server/repos/contacts";
import {
  conversationIdInAccount,
  findOrCreateConversationId,
  getConversationForSend,
  getConversationWithContact,
  listConversationsKeyset,
  listConversationsWithContact,
  listUnreadCounts,
  markConversationRead,
  touchConversationLastMessage,
  updateConversation,
} from "@/server/repos/conversations";
import {
  getMessageRef,
  getReplyParent,
  getWhatsAppSendConfig,
  getWhatsAppStatus,
  insertOutboundMessage,
  listConversationMessages,
  listMessagesKeyset,
  pauseActiveFlowRunsForContact,
} from "@/server/repos/messages";
import { deleteAgentReaction, listConversationReactions, upsertAgentReaction } from "@/server/repos/reactions";
import { resolveConversationByPhone } from "@/lib/whatsapp/resolve-conversation";
import { normalizeConversation } from "@/lib/inbox/conversations";
import type { Conversation } from "@/types";
import {
  joinAccount,
  seedUser,
  teardownIntegrationDb,
  useIntegrationDb,
  withSuperuser,
  type SeededUser,
} from "@/test/integration/helpers";

let owner: SeededUser;
let viewer: SeededUser;
let other: SeededUser;
let aliceId: string;
let bobId: string;
let convA: string;
let convB: string;
let tagId: string;

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  viewer = await seedUser("Viewer");
  other = await seedUser("Other");
  await joinAccount(viewer.id, owner.accountId, "viewer");

  await asUser(owner.id, async (db) => {
    const tag = await db
      .insertInto("tags")
      .values({ account_id: owner.accountId, user_id: owner.id, name: "VIP" })
      .returning("id")
      .executeTakeFirstOrThrow();
    tagId = tag.id;
    const alice = await insertContact(db, { account_id: owner.accountId, user_id: owner.id, phone: "+15550001", name: "Alice" });
    const bob = await insertContact(db, { account_id: owner.accountId, user_id: owner.id, phone: "+15550002", name: "Bob" });
    aliceId = alice!.id;
    bobId = bob!.id;
    await db.insertInto("contact_tags").values({ contact_id: aliceId, tag_id: tagId }).execute();
    convA = (await findOrCreateConversationId(db, owner.accountId, aliceId, owner.id))!;
    convB = (await findOrCreateConversationId(db, owner.accountId, bobId, owner.id))!;
    await db.updateTable("conversations").set({ unread_count: 3 }).where("id", "=", convA).execute();
    await db
      .insertInto("whatsapp_config")
      .values({
        account_id: owner.accountId,
        user_id: owner.id,
        phone_number_id: "pn-1",
        access_token: "secret",
        status: "connected",
      })
      .execute();
  });
});

afterAll(teardownIntegrationDb);

describe("conversations repo", () => {
  it("embeds contact + contact_tags(tags) in the CONVERSATION_SELECT shape", async () => {
    const row = await asUser(owner.id, (db) => getConversationWithContact(db, owner.accountId, convA));
    expect(row?.contact?.name).toBe("Alice");
    expect(row?.contact?.contact_tags.map((ct) => ct.tags?.name)).toEqual(["VIP"]);
    const normalized = normalizeConversation(row as unknown as Conversation);
    expect(normalized.contact?.tags?.map((t) => t.id)).toEqual([tagId]);

    const list = await asUser(viewer.id, (db) => listConversationsWithContact(db, owner.accountId));
    expect(list.map((c) => c.id).sort()).toEqual([convA, convB].sort());
  });

  it("does not leak another account's conversations", async () => {
    const list = await asUser(other.id, (db) => listConversationsWithContact(db, owner.accountId));
    expect(list).toEqual([]);
    expect(await asService((db) => conversationIdInAccount(db, other.accountId, convA))).toBeUndefined();
    expect(await asService((db) => getConversationForSend(db, other.accountId, convA))).toBeUndefined();
  });

  it("find-or-create converges on one conversation per contact", async () => {
    const again = await asUser(owner.id, (db) => findOrCreateConversationId(db, owner.accountId, aliceId, owner.id));
    expect(again).toBe(convA);
    // A racing insert (row already there) is absorbed by ON CONFLICT and
    // the transaction stays usable.
    const raced = await asUser(owner.id, async (db) => {
      const inserted = await db
        .insertInto("conversations")
        .values({ account_id: owner.accountId, user_id: owner.id, contact_id: aliceId })
        .onConflict((oc) => oc.columns(["account_id", "contact_id"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      const id = await findOrCreateConversationId(db, owner.accountId, aliceId, owner.id);
      return { inserted, id };
    });
    expect(raced).toEqual({ inserted: undefined, id: convA });
  });

  it("keyset-pages with status / contact filters", async () => {
    await asService(async (db) => {
      const first = await listConversationsKeyset(db, owner.accountId, { limit: 1, cursor: null });
      expect(first).toHaveLength(1);
      const next = await listConversationsKeyset(db, owner.accountId, {
        limit: 5,
        cursor: { createdAt: first[0].created_at as string, id: first[0].id },
      });
      expect(next.map((c) => c.id)).not.toContain(first[0].id);
      expect(first.length + next.length).toBe(2);

      const byContact = await listConversationsKeyset(db, owner.accountId, { limit: 5, cursor: null, contactId: bobId });
      expect(byContact.map((c) => c.id)).toEqual([convB]);
      const closed = await listConversationsKeyset(db, owner.accountId, { limit: 5, cursor: null, status: "closed" });
      expect(closed).toEqual([]);
    });
  });

  it("updates status/assignment (agent) and unread resets are a no-op for viewers", async () => {
    const updated = await asUser(owner.id, (db) =>
      updateConversation(db, owner.accountId, convB, { status: "pending", assigned_agent_id: owner.id }),
    );
    expect(updated).toMatchObject({ status: "pending", assigned_agent_id: owner.id });

    await asUser(viewer.id, (db) => markConversationRead(db, owner.accountId, convA));
    let counts = await asUser(viewer.id, (db) => listUnreadCounts(db, owner.accountId));
    expect(counts.find((c) => c.id === convA)?.unread_count).toBe(3);

    await asUser(owner.id, (db) => markConversationRead(db, owner.accountId, convA));
    counts = await asUser(owner.id, (db) => listUnreadCounts(db, owner.accountId));
    expect(counts.find((c) => c.id === convA)?.unread_count).toBe(0);
  });
});

describe("messages + reactions repos", () => {
  let first: string;
  let second: string;

  beforeAll(async () => {
    await asUser(owner.id, async (db) => {
      const base = {
        conversation_id: convA,
        content_type: "text",
        media_url: null,
        template_name: null,
        reply_to_message_id: null,
      };
      first = (await insertOutboundMessage(db, { ...base, content_text: "one", interactive_payload: null, message_id: "wamid.1" })).id;
      const row = await insertOutboundMessage(db, {
        ...base,
        content_type: "interactive",
        content_text: "pick",
        interactive_payload: { kind: "buttons", body: "pick", buttons: [{ id: "a", title: "A" }] },
        message_id: "wamid.2",
      });
      second = row.id;
      expect(row).toMatchObject({ sender_type: "agent", status: "sent" });
      expect(row.interactive_payload).toEqual({ kind: "buttons", body: "pick", buttons: [{ id: "a", title: "A" }] });
      await touchConversationLastMessage(db, owner.accountId, convA, "pick");
    });
  });

  it("lists the thread oldest-first and pages newest-first", async () => {
    const thread = await asUser(viewer.id, (db) => listConversationMessages(db, owner.accountId, convA));
    expect(thread.map((m) => m.id)).toEqual([first, second]);

    const page1 = await asService((db) => listMessagesKeyset(db, owner.accountId, convA, { limit: 1, cursor: null }));
    expect(page1.map((m) => m.id)).toEqual([second]);
    const page2 = await asService((db) =>
      listMessagesKeyset(db, owner.accountId, convA, {
        limit: 5,
        cursor: { createdAt: page1[0].created_at as string, id: page1[0].id },
      }),
    );
    expect(page2.map((m) => m.id)).toEqual([first]);

    // Scoped through the conversation's account.
    expect(await asService((db) => listConversationMessages(db, other.accountId, convA))).toEqual([]);
    expect(await asService((db) => getMessageRef(db, other.accountId, first))).toBeUndefined();

    const conv = await asUser(owner.id, (db) => getConversationWithContact(db, owner.accountId, convA));
    expect(conv?.last_message_text).toBe("pick");
  });

  it("resolves reply parents only inside the same conversation", async () => {
    const parent = await asUser(owner.id, (db) => getReplyParent(db, convA, first));
    expect(parent?.message_id).toBe("wamid.1");
    expect(await asUser(owner.id, (db) => getReplyParent(db, convB, first))).toBeUndefined();
  });

  it("upserts (swaps) and deletes the agent's reaction", async () => {
    const ref = await asUser(owner.id, (db) => getMessageRef(db, owner.accountId, first));
    expect(ref).toMatchObject({ id: first, message_id: "wamid.1", conversation_id: convA });

    const values = { message_id: first, conversation_id: convA, actor_id: owner.id };
    await asUser(owner.id, (db) => upsertAgentReaction(db, { ...values, emoji: "👍" }));
    await asUser(owner.id, (db) => upsertAgentReaction(db, { ...values, emoji: "🎉" }));
    let reactions = await asUser(viewer.id, (db) => listConversationReactions(db, owner.accountId, convA));
    expect(reactions.map((r) => r.emoji)).toEqual(["🎉"]);
    expect(await asService((db) => listConversationReactions(db, other.accountId, convA))).toEqual([]);

    await asUser(owner.id, (db) => deleteAgentReaction(db, first, owner.id));
    reactions = await asUser(owner.id, (db) => listConversationReactions(db, owner.accountId, convA));
    expect(reactions).toEqual([]);
  });

  it("reads the WhatsApp config / status and pauses active flow runs", async () => {
    const config = await asService((db) => getWhatsAppSendConfig(db, owner.accountId));
    expect(config).toMatchObject({ phone_number_id: "pn-1", access_token: "secret" });
    expect(await asUser(viewer.id, (db) => getWhatsAppStatus(db, owner.accountId))).toBe("connected");
    expect(await asService((db) => getWhatsAppSendConfig(db, other.accountId))).toBeUndefined();

    const runId = await withSuperuser(async (c) => {
      const flow = await c.query(
        "INSERT INTO public.flows (account_id, user_id, name, trigger_type) VALUES ($1, $2, 'F', 'keyword') RETURNING id",
        [owner.accountId, owner.id],
      );
      const run = await c.query(
        "INSERT INTO public.flow_runs (account_id, user_id, flow_id, contact_id, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id",
        [owner.accountId, owner.id, flow.rows[0].id, aliceId],
      );
      return run.rows[0].id as string;
    });
    await asService((db) => pauseActiveFlowRunsForContact(db, other.accountId, aliceId));
    const untouched = await withSuperuser((c) => c.query("SELECT status FROM public.flow_runs WHERE id = $1", [runId]));
    expect(untouched.rows[0].status).toBe("active");
    await asService((db) => pauseActiveFlowRunsForContact(db, owner.accountId, aliceId));
    const paused = await withSuperuser((c) =>
      c.query("SELECT status, end_reason FROM public.flow_runs WHERE id = $1", [runId]),
    );
    expect(paused.rows[0]).toEqual({ status: "paused_by_agent", end_reason: "agent_replied" });
  });
});

describe("resolveConversationByPhone (service runner)", () => {
  it("reuses the existing contact + conversation", async () => {
    const res = await resolveConversationByPhone(serviceRunner, owner.accountId, "+15550001");
    expect(res).toEqual({ conversationId: convA, contactId: aliceId, contactCreated: false });
  });

  it("creates a contact + conversation attributed to the config owner", async () => {
    const res = await resolveConversationByPhone(serviceRunner, owner.accountId, "+14155550123", "Dana");
    expect(res.contactCreated).toBe(true);
    const row = await asService((db) => getConversationForSend(db, owner.accountId, res.conversationId));
    expect(row?.contact).toMatchObject({ id: res.contactId, name: "Dana", user_id: owner.id });

    const again = await resolveConversationByPhone(serviceRunner, owner.accountId, "+1 415 555 0123");
    expect(again).toEqual({ ...res, contactCreated: false });
  });

  it("refuses an account without WhatsApp config", async () => {
    await expect(resolveConversationByPhone(serviceRunner, other.accountId, "+14155550123")).rejects.toMatchObject({
      code: "whatsapp_not_configured",
    });
  });
});
