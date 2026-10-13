// End-to-end tests for the supabase-js compatible adapter against a
// real, fully-migrated database. Covers the select/filter syntax the
// app actually uses plus RLS behaviour through the role switch.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  joinAccount,
  seedUser,
  serviceDb,
  teardownIntegrationDb,
  useIntegrationDb,
  userDb,
  type SeededUser,
} from "@/test/integration/helpers";

let alice: SeededUser;
let bob: SeededUser; // different account
let viewer: SeededUser; // alice's account, viewer role
let contactId: string;
let conversationId: string;
let tagId: string;

beforeAll(async () => {
  useIntegrationDb();
  alice = await seedUser("Alice");
  bob = await seedUser("Bob");
  viewer = await seedUser("Vera");
  await joinAccount(viewer.id, alice.accountId, "viewer");

  const db = userDb(alice.id);
  const { data: contact, error: cErr } = await db
    .from("contacts")
    .insert({ user_id: alice.id, account_id: alice.accountId, phone: "+15550001", name: "Carol" })
    .select()
    .single();
  expect(cErr).toBeNull();
  contactId = contact.id;

  const { data: tag } = await db
    .from("tags")
    .insert({ user_id: alice.id, account_id: alice.accountId, name: "VIP", color: "#f00" })
    .select("id")
    .single();
  tagId = tag.id;
  await db.from("contact_tags").insert({ contact_id: contactId, tag_id: tagId });

  const { data: conv } = await db
    .from("conversations")
    .insert({ user_id: alice.id, account_id: alice.accountId, contact_id: contactId, last_message_at: "2024-01-02T00:00:00Z" })
    .select("id")
    .single();
  conversationId = conv.id;

  const { error: mErr } = await db.from("messages").insert([
    { conversation_id: conversationId, sender_type: "customer", content_text: "hi", created_at: "2024-01-01T00:00:00Z" },
    { conversation_id: conversationId, sender_type: "agent", content_text: "hello", created_at: "2024-01-01T00:01:00Z" },
  ]);
  expect(mErr).toBeNull();
});

afterAll(teardownIntegrationDb);

describe("select", () => {
  it("returns typed JSON (numbers, timestamps with +00:00)", async () => {
    const { data, error } = await userDb(alice.id)
      .from("conversations")
      .select("id, unread_count, last_message_at")
      .eq("id", conversationId)
      .single();
    expect(error).toBeNull();
    expect(data.unread_count).toBe(0);
    expect(data.last_message_at).toBe("2024-01-02T00:00:00+00:00");
  });

  it("embeds many-to-one and nested one-to-many (CONVERSATION_SELECT)", async () => {
    const { data, error } = await userDb(alice.id)
      .from("conversations")
      .select("*, contact:contacts(*, contact_tags(tags(*)))")
      .eq("id", conversationId)
      .single();
    expect(error).toBeNull();
    expect(data.contact.name).toBe("Carol");
    expect(data.contact.contact_tags).toHaveLength(1);
    expect(data.contact.contact_tags[0].tags.name).toBe("VIP");
  });

  it("embeds without alias, two levels of many-to-one", async () => {
    const { data, error } = await userDb(alice.id)
      .from("messages")
      .select("id, content_text, conversations(contact_id, contacts(name, phone))")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    expect(data[0].content_text).toBe("hi");
    expect(data[0].conversations.contacts.phone).toBe("+15550001");
  });

  it("!inner embed + dotted filter filters parent rows", async () => {
    const db = userDb(alice.id);
    await db.from("contacts").insert({ user_id: alice.id, account_id: alice.accountId, phone: "+15550002", name: "Dan" });
    const all = await db.from("contacts").select("id");
    expect(all.data).toHaveLength(2);

    const { data, error } = await db
      .from("contacts")
      .select("*, contact_tags(tags(*)), tag_filter:contact_tags!inner(tag_id)")
      .eq("account_id", alice.accountId)
      .eq("tag_filter.tag_id", tagId);
    expect(error).toBeNull();
    expect(data.map((c: { name: string }) => c.name)).toEqual(["Carol"]);
  });

  it("supports FK hints", async () => {
    const db = userDb(alice.id);
    const { data: pipeline } = await db
      .from("pipelines")
      .insert({ user_id: alice.id, account_id: alice.accountId, name: "Sales" })
      .select()
      .single();
    const { data: stage } = await db
      .from("pipeline_stages")
      .insert({ pipeline_id: pipeline.id, name: "New", position: 0 })
      .select()
      .single();
    const { data: prof } = await db.from("profiles").select("id").eq("user_id", alice.id).single();
    const { error: dErr } = await db.from("deals").insert({
      user_id: alice.id,
      account_id: alice.accountId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      title: "Big one",
      value: 1234.5,
      contact_id: contactId,
      assigned_to: prof.id,
    });
    expect(dErr).toBeNull();
    const { data, error } = await db
      .from("deals")
      .select("*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*), stage:pipeline_stages(name)")
      .eq("pipeline_id", pipeline.id)
      .single();
    expect(error).toBeNull();
    expect(data.value).toBe(1234.5);
    expect(data.assignee.full_name).toBe("Alice");
    expect(data.stage.name).toBe("New");
  });

  it("parses or() strings incl. nested and()", async () => {
    const db = userDb(alice.id);
    const r1 = await db.from("contacts").select("name").or("name.ilike.*car*,phone.ilike.*0002*").order("name");
    expect(r1.data.map((c: { name: string }) => c.name)).toEqual(["Carol", "Dan"]);

    const r2 = await db
      .from("messages")
      .select("content_text")
      .eq("conversation_id", conversationId)
      .or("created_at.lt.2024-01-01T00:00:30Z,and(created_at.eq.2024-01-01T00:01:00Z,sender_type.eq.agent)");
    expect(r2.data).toHaveLength(2);
  });

  it("count exact with head", async () => {
    const { data, count, error } = await userDb(alice.id)
      .from("contacts")
      .select("*", { count: "exact", head: true });
    expect(error).toBeNull();
    expect(data).toBeNull();
    expect(count).toBe(2);
  });

  it("range / is / in / neq / json path filter", async () => {
    const db = userDb(alice.id);
    const page = await db.from("contacts").select("name").order("name").range(1, 1);
    expect(page.data).toEqual([{ name: "Dan" }]);

    const isNull = await db.from("contacts").select("id").is("email", null);
    expect(isNull.data).toHaveLength(2);

    const inList = await db.from("contacts").select("name").in("name", ["Dan", "Nobody"]);
    expect(inList.data).toEqual([{ name: "Dan" }]);

    const empty = await db.from("contacts").select("name").in("name", []);
    expect(empty.data).toEqual([]);

    const neq = await db.from("contacts").select("name").neq("name", "Dan");
    expect(neq.data).toEqual([{ name: "Carol" }]);
  });

  it("single() errors with PGRST116 on 0 rows, maybeSingle() returns null", async () => {
    const db = userDb(alice.id);
    const s = await db.from("contacts").select("id").eq("name", "Nobody").single();
    expect(s.error?.code).toBe("PGRST116");
    const m = await db.from("contacts").select("id").eq("name", "Nobody").maybeSingle();
    expect(m.error).toBeNull();
    expect(m.data).toBeNull();
  });

  it("rejects unknown columns and tables without running SQL", async () => {
    const db = userDb(alice.id);
    const c = await db.from("contacts").select("id, nope");
    expect(c.error?.code).toBe("42703");
    const t = await db.from("pg_authid").select("*");
    expect(t.error?.code).toBe("42P01");
    const inj = await db.from("contacts").select('id"; DROP TABLE contacts; --');
    expect(inj.error?.code).toBe("PGRST100");
  });
});

describe("writes", () => {
  it("update returns null data without select, rows with select", async () => {
    const db = userDb(alice.id);
    const r1 = await db.from("contacts").update({ company: "Acme" }).eq("id", contactId);
    expect(r1.error).toBeNull();
    expect(r1.data).toBeNull();
    const r2 = await db.from("contacts").update({ email: "c@x.io" }).eq("id", contactId).select("email").single();
    expect(r2.data).toEqual({ email: "c@x.io" });
  });

  it("upsert with onConflict + ignoreDuplicates", async () => {
    const db = userDb(alice.id);
    // contact_tags has UNIQUE (contact_id, tag_id)
    const r = await db
      .from("contact_tags")
      .upsert([{ contact_id: contactId, tag_id: tagId }], { onConflict: "contact_id,tag_id", ignoreDuplicates: true });
    expect(r.error).toBeNull();
    const { count } = await db.from("contact_tags").select("*", { count: "exact", head: true }).eq("contact_id", contactId);
    expect(count).toBe(1);
  });

  it("refuses unfiltered update/delete", async () => {
    const db = userDb(alice.id);
    const u = await db.from("contacts").update({ company: "x" });
    expect(u.error?.code).toBe("21000");
    const d = await db.from("contacts").delete();
    expect(d.error?.code).toBe("21000");
  });

  it("jsonb + array columns round-trip, contains() on text[]", async () => {
    const svc = serviceDb();
    const { error } = await svc.from("webhook_endpoints").insert({
      account_id: alice.accountId,
      url: "https://example.test/hook",
      secret: "s",
      events: ["message.received", "contact.created"],
    });
    expect(error).toBeNull();
    const { data } = await svc
      .from("webhook_endpoints")
      .select("url, events")
      .eq("account_id", alice.accountId)
      .contains("events", ["contact.created"]);
    expect(data).toHaveLength(1);
    expect(data[0].events).toEqual(["message.received", "contact.created"]);
  });
});

describe("RLS through the role switch", () => {
  it("another account sees nothing", async () => {
    const { data } = await userDb(bob.id).from("contacts").select("id");
    expect(data).toEqual([]);
  });

  it("viewer can read but not write", async () => {
    const db = userDb(viewer.id);
    const read = await db.from("contacts").select("id");
    expect(read.data).toHaveLength(2);
    const write = await db
      .from("contacts")
      .insert({ user_id: viewer.id, account_id: alice.accountId, phone: "+1555", name: "Nope" });
    expect(write.error?.code).toBe("42501");
  });

  it("cannot insert into another account", async () => {
    const r = await userDb(bob.id)
      .from("contacts")
      .insert({ user_id: bob.id, account_id: alice.accountId, phone: "+1666" });
    expect(r.error?.code).toBe("42501");
  });

  it("profile privilege guard (034) still fires", async () => {
    const r = await userDb(alice.id).from("profiles").update({ account_role: "viewer" }).eq("user_id", alice.id);
    expect(r.error).not.toBeNull();
  });

  it("service role sees every account", async () => {
    const { count } = await serviceDb().from("accounts").select("*", { count: "exact", head: true });
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

describe("rpc", () => {
  it("calls a user RPC (touch_presence)", async () => {
    const r = await userDb(alice.id).rpc("touch_presence");
    expect(r.error).toBeNull();
  });

  it("service-only RPCs are denied to users (044)", async () => {
    const r = await userDb(alice.id).rpc("claim_ai_reply_slot", { conversation_id: conversationId, max_replies: 3 });
    expect(r.error?.code).toBe("42501");
  });

  it("set-returning RPC with array arg (filter_contacts_by_tags)", async () => {
    const r = await userDb(alice.id).rpc("filter_contacts_by_tags", { p_tag_ids: [tagId] });
    expect(r.error).toBeNull();
    expect(Array.isArray(r.data)).toBe(true);
  });

  it("unknown function → PGRST202", async () => {
    const r = await userDb(alice.id).rpc("does_not_exist");
    expect(r.error?.code).toBe("PGRST202");
  });
});
