import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser } from "@/server/db";
import {
  claimAiReplySlot,
  conversationExists,
  getConversationAiState,
  hasActiveMessageAutoResponder,
  listRecentTextMessages,
  updateConversationAi,
} from "@/server/repos/ai-conversations";
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
let convId: string;

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  agent = await seedUser("Agent");
  other = await seedUser("Other");
  await joinAccount(agent.id, owner.accountId, "agent");
  convId = await asService(async (db) => {
    const contact = await db
      .insertInto("contacts")
      .values({ account_id: owner.accountId, user_id: owner.id, phone: "+15550001111" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const conv = await db
      .insertInto("conversations")
      .values({ account_id: owner.accountId, user_id: owner.id, contact_id: contact.id })
      .returning("id")
      .executeTakeFirstOrThrow();
    const base = Date.parse("2026-01-01T00:00:00Z");
    const msgs = [
      { sender_type: "customer", content_text: "first", content_type: "text" },
      { sender_type: "agent", content_text: "second", content_type: "text" },
      { sender_type: "customer", content_text: null, content_type: "image" },
      { sender_type: "customer", content_text: "third", content_type: "text" },
    ];
    for (const [i, m] of msgs.entries()) {
      await db
        .insertInto("messages")
        .values({ ...m, conversation_id: conv.id, created_at: new Date(base + i * 1000).toISOString() })
        .execute();
    }
    return conv.id;
  });
});

afterAll(teardownIntegrationDb);

describe("ai-conversations repo", () => {
  it("lists the newest text messages, scoped by account", async () => {
    const rows = await asService((db) => listRecentTextMessages(db, owner.accountId, convId, 2));
    expect(rows).toEqual([
      { sender_type: "customer", content_text: "third" },
      { sender_type: "agent", content_text: "second" },
    ]);
    expect(await asService((db) => listRecentTextMessages(db, other.accountId, convId, 10))).toEqual([]);
  });

  it("reads state and existence, scoped by account", async () => {
    expect(await asUser(agent.id, (db) => conversationExists(db, owner.accountId, convId))).toBe(true);
    expect(await asUser(other.id, (db) => conversationExists(db, other.accountId, convId))).toBe(false);
    expect(await asService((db) => getConversationAiState(db, owner.accountId, convId))).toEqual({
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    });
    expect(await asService((db) => getConversationAiState(db, other.accountId, convId))).toBeUndefined();
  });

  it("claims reply slots atomically up to the cap (service role)", async () => {
    expect(await asService((db) => claimAiReplySlot(db, convId, 2))).toBe(true);
    expect(await asService((db) => claimAiReplySlot(db, convId, 2))).toBe(true);
    expect(await asService((db) => claimAiReplySlot(db, convId, 2))).toBe(false);
    // Not EXECUTE-able by signed-in users (migration 044).
    await expect(asUser(owner.id, (db) => claimAiReplySlot(db, convId, 5))).rejects.toThrow();
  });

  it("agent pauses / resumes; other accounts update nothing", async () => {
    expect(
      await asUser(agent.id, (db) =>
        updateConversationAi(db, owner.accountId, convId, { ai_autoreply_disabled: true, assigned_agent_id: agent.id }),
      ),
    ).toBe(1);
    expect(
      await asUser(other.id, (db) => updateConversationAi(db, other.accountId, convId, { ai_autoreply_disabled: false })),
    ).toBe(0);
    await asUser(agent.id, (db) =>
      updateConversationAi(db, owner.accountId, convId, {
        ai_autoreply_disabled: false,
        assigned_agent_id: null,
        ai_reply_count: 0,
        ai_handoff_summary: null,
      }),
    );
    expect(await asService((db) => getConversationAiState(db, owner.accountId, convId))).toEqual({
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    });
  });

  it("detects active message-level auto-responders", async () => {
    expect(await asService((db) => hasActiveMessageAutoResponder(db, owner.accountId))).toBe(false);
    await asService((db) =>
      db
        .insertInto("automations")
        .values([
          { account_id: owner.accountId, user_id: owner.id, name: "rel", trigger_type: "first_inbound_message", is_active: true },
          { account_id: owner.accountId, user_id: owner.id, name: "off", trigger_type: "keyword_match", is_active: false },
        ])
        .execute(),
    );
    expect(await asService((db) => hasActiveMessageAutoResponder(db, owner.accountId))).toBe(false);
    await asService((db) =>
      db
        .insertInto("automations")
        .values({ account_id: owner.accountId, user_id: owner.id, name: "kw", trigger_type: "keyword_match", is_active: true })
        .execute(),
    );
    expect(await asService((db) => hasActiveMessageAutoResponder(db, owner.accountId))).toBe(true);
    expect(await asService((db) => hasActiveMessageAutoResponder(db, other.accountId))).toBe(false);
  });
});
