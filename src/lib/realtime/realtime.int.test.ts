// Realtime hub against a real database: NOTIFY triggers fire for
// publication tables and the hub delivers only to the owning account.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getHub, type Subscriber } from "@/lib/realtime/hub";
import {
  seedUser,
  serviceDb,
  teardownIntegrationDb,
  useIntegrationDb,
  userDb,
  type SeededUser,
} from "@/test/integration/helpers";

let alice: SeededUser;
let bob: SeededUser;

function collector(user: SeededUser) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose event payloads in assertions
  const events: Array<{ event: string; data: any }> = [];
  const sub: Subscriber = {
    accountId: user.accountId,
    userId: user.id,
    send: (event, data) => events.push({ event, data }),
  };
  return { sub, events };
}

const settle = () => new Promise((r) => setTimeout(r, 300));

beforeAll(async () => {
  useIntegrationDb();
  alice = await seedUser("Alice");
  bob = await seedUser("Bob");
});
afterAll(teardownIntegrationDb);

describe("realtime hub", () => {
  it("delivers inserts/updates/deletes to the owning account only", async () => {
    const a = collector(alice);
    const b = collector(bob);
    await getHub().add(a.sub);
    await getHub().add(b.sub);

    const db = userDb(alice.id);
    const { data: contact } = await db
      .from("contacts")
      .insert({ user_id: alice.id, account_id: alice.accountId, phone: "+1999" })
      .select("id")
      .single();
    const { data: conv } = await db
      .from("conversations")
      .insert({ user_id: alice.id, account_id: alice.accountId, contact_id: contact.id })
      .select("id")
      .single();
    await db.from("messages").insert({ conversation_id: conv.id, sender_type: "customer", content_text: "yo" });
    await db.from("conversations").update({ unread_count: 3 }).eq("id", conv.id);
    await settle();

    const tables = a.events.filter((e) => e.event === "change").map((e) => `${e.data.t}:${e.data.op}`);
    expect(tables).toContain("conversations:INSERT");
    expect(tables).toContain("messages:INSERT");
    expect(tables).toContain("conversations:UPDATE");
    const msg = a.events.find((e) => e.data.t === "messages")!.data;
    expect(msg.new.content_text).toBe("yo");
    expect(b.events).toHaveLength(0);

    // Large rows are truncated in NOTIFY and re-read by the hub.
    const big = "x".repeat(9000);
    await db.from("messages").insert({ conversation_id: conv.id, sender_type: "agent", content_text: big });
    await settle();
    const bigEv = a.events.filter((e) => e.data.t === "messages").pop()!.data;
    expect(bigEv.new.content_text).toHaveLength(9000);

    // DELETE carries the old row (so filtered DELETE subscriptions work).
    await serviceDb().from("messages").delete().eq("conversation_id", conv.id).eq("sender_type", "customer");
    await settle();
    const del = a.events.find((e) => e.data.op === "DELETE")!.data;
    expect(del.old.conversation_id).toBe(conv.id);

    getHub().remove(a.sub);
    getHub().remove(b.sub);
  });

  it("notifications go only to their recipient", async () => {
    const owner = collector(alice);
    await getHub().add(owner.sub);
    const mate = await seedUser("Mate");
    const mateC = { ...collector(mate), sub: { ...collector(mate).sub, accountId: alice.accountId } };
    const mateEvents: unknown[] = [];
    mateC.sub.send = (_e, d) => mateEvents.push(d);
    await getHub().add(mateC.sub);

    await serviceDb().from("notifications").insert({
      account_id: alice.accountId,
      user_id: alice.id,
      type: "conversation_assigned",
      title: "hi",
    });
    await settle();
    expect(owner.events.some((e) => e.data.t === "notifications")).toBe(true);
    expect(mateEvents).toHaveLength(0);

    getHub().remove(owner.sub);
    getHub().remove(mateC.sub);
  });
});
