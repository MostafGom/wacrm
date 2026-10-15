// Public REST API (/api/v1): API keys created in Settings → API keys,
// every endpoint with a bearer key, scopes, tenancy, auth failures, rate
// limiting, outbound event webhooks (signed, received by the fakes) and
// the MCP server (mcp-server/) driven over stdio.

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { api, connectWhatsApp, newOwner, pageAs, syncTemplates, type Connection, type TestUser } from "../support/accounts";
import { BASE_URL } from "../support/env";
import { fakes, randomCustomerPhone } from "../support/fakes";
import { buildMcpServer, McpStdioClient, v1 } from "../support/public-api";

const ALL_SCOPES = [
  "messages:send",
  "messages:read",
  "contacts:read",
  "contacts:write",
  "conversations:read",
  "broadcasts:send",
  "webhooks:manage",
] as const;
type Scope = (typeof ALL_SCOPES)[number];

const toast = (page: Page, text: string | RegExp) =>
  page.locator("[data-sonner-toast]").filter({ hasText: text }).first();
const uniq = () => randomUUID().replace(/-/g, "").slice(0, 10);
const UNKNOWN_UUID = "00000000-0000-4000-8000-000000000000";
/** Contacts are stored with the phone normalised to digits (no leading +). */
const stored = (e164: string) => e164.replace(/\D/g, "");

async function createKey(user: TestUser, name: string, scopes: readonly Scope[]): Promise<{ id: string; key: string }> {
  const r = await api(user, "POST", "/api/account/api-keys", { name, scopes });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.key.id, key: r.body.plaintext };
}

test.describe("Public API /api/v1", () => {
  test.describe.configure({ mode: "serial" });

  let owner: TestUser;
  let other: TestUser;
  let wa: Connection;
  let otherWa: Connection;
  let page: Page;
  /** Full-scope key created through the UI. */
  let key = "";
  let keyName = "";
  /** Another account's key + resources (tenancy checks). */
  let otherKey = "";
  const otherIds: { contact?: string; conversation?: string; webhook?: string; broadcast?: string } = {};
  /** Shared across tests. */
  const ids: { contact?: string; conversation?: string; message?: string; wamid?: string; tagId?: string } = {};
  const customer = randomCustomerPhone();

  test.beforeAll(async ({ browser }) => {
    owner = await newOwner("API Owner");
    wa = await connectWhatsApp(owner);
    await syncTemplates(owner);
    other = await newOwner("Other Tenant");
    otherWa = await connectWhatsApp(other);
    await syncTemplates(other);
    ({ page } = await pageAs(browser, owner));

    // Some data in the other account to probe cross-tenant access with.
    otherKey = (await createKey(other, "other tenant", ALL_SCOPES)).key;
    const oc = await v1(otherKey, "POST", "/messages", { to: randomCustomerPhone(), text: "other tenant hello", name: "Other Customer" });
    expect(oc.status).toBe(201);
    otherIds.contact = oc.body.data.contact_id;
    otherIds.conversation = oc.body.data.conversation_id;
    const ow = await v1(otherKey, "POST", "/webhooks", { url: fakes.hookUrl(`other-${uniq()}`), events: ["message.received"] });
    expect(ow.status).toBe(201);
    otherIds.webhook = ow.body.data.id;
    const ob = await v1(otherKey, "POST", "/broadcasts", {
      template_name: "order_update",
      template_language: "en_US",
      recipients: [{ to: randomCustomerPhone(), params: ["X", "#1"] }],
    });
    expect(ob.status).toBe(202);
    otherIds.broadcast = ob.body.data.broadcast_id;
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("create an API key in Settings → API keys (shown once)", async () => {
    keyName = `Full access ${uniq()}`;
    await page.goto("/settings?tab=api");
    await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
    await expect(page.getByText("No API keys yet.")).toBeVisible();

    await page.getByRole("button", { name: "New API key" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "New API key" })).toBeVisible();
    await expect(dialog.getByText(/A key with no scopes can still call/)).toBeVisible();

    await dialog.getByRole("button", { name: "Create key" }).click();
    await expect(toast(page, "Give the key a name")).toBeVisible();

    await dialog.getByLabel("Name").fill(keyName);
    for (const scope of ALL_SCOPES) {
      const box = dialog.getByRole("checkbox", { name: new RegExp(`^${scope}\\b`) });
      await expect(box).not.toBeChecked();
      await box.click();
      await expect(box).toBeChecked();
    }
    await dialog.getByRole("button", { name: "Create key" }).click();

    await expect(dialog.getByRole("heading", { name: "Copy your API key" })).toBeVisible();
    await expect(dialog.getByText("This is the only time the full key is shown.", { exact: false })).toBeVisible();
    const keyBox = dialog.locator("input[readonly]");
    await expect(keyBox).toHaveValue(/^wacrm_live_[\w-]{20,}$/);
    key = await keyBox.inputValue();

    await dialog.getByRole("button", { name: "Copy" }).click();
    await expect(toast(page, "API key copied")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const row = page.locator("li").filter({ hasText: keyName });
    await expect(row).toBeVisible();
    for (const scope of ALL_SCOPES) await expect(row.getByText(scope, { exact: true })).toBeVisible();
    await expect(row).toContainText("never used");
    await expect(row.getByRole("button", { name: "Revoke" })).toBeVisible();

    // Never shown again: not on the page, not in the list API.
    await page.reload();
    await expect(page.locator("li").filter({ hasText: keyName })).toBeVisible();
    expect(await page.content()).not.toContain(key);
    const list = await api(owner, "GET", "/api/account/api-keys");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(key);
    const listed = list.body.keys.find((k: { name: string }) => k.name === keyName);
    expect(listed).toMatchObject({ scopes: [...ALL_SCOPES], revoked_at: null });
    expect(key.startsWith(listed.key_prefix)).toBe(true);
    await expect(page.locator("li").filter({ hasText: keyName })).toContainText(`${listed.key_prefix}…`);

    // Using the key shows up as "last used".
    expect((await v1(key, "GET", "/me")).status).toBe(200);
    await expect
      .poll(async () => {
        const l = await api(owner, "GET", "/api/account/api-keys");
        return l.body.keys.find((k: { name: string }) => k.name === keyName).last_used_at;
      })
      .toBeTruthy();
    await page.reload();
    await expect(page.locator("li").filter({ hasText: keyName })).toContainText("last used");
  });

  test("GET /me identifies the account and scopes", async () => {
    const r = await v1(key, "GET", "/me");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      data: {
        account: { id: owner.accountId, name: expect.any(String) },
        key: { id: expect.any(String), scopes: [...ALL_SCOPES] },
      },
    });
    // "Bearer" prefix is optional.
    const bare = await fetch(`${BASE_URL}/api/v1/me`, { headers: { authorization: key } });
    expect(bare.status).toBe(200);
  });

  test("contacts: create (find-or-create), read, search, tag filter, update, paginate", async () => {
    const phone = randomCustomerPhone();
    const created = await v1(key, "POST", "/contacts", {
      phone,
      name: "Ada Lovelace",
      email: "ada@example.com",
      company: "Analytical",
      tags: ["vip-api", "lead-api"],
    });
    expect(created.status).toBe(201);
    const c = created.body.data;
    expect(c).toMatchObject({
      id: expect.any(String),
      phone: stored(phone),
      name: "Ada Lovelace",
      email: "ada@example.com",
      company: "Analytical",
      avatar_url: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(c.tags.map((t: { name: string }) => t.name).sort()).toEqual(["lead-api", "vip-api"]);
    ids.contact = c.id;
    ids.tagId = c.tags.find((t: { name: string }) => t.name === "vip-api").id;

    // Same phone again → 200, same contact (find-or-create).
    const again = await v1(key, "POST", "/contacts", { phone, name: "Someone Else" });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(c.id);
    expect(again.body.data.name).toBe("Ada Lovelace");

    // Validation.
    expect((await v1(key, "POST", "/contacts", { name: "No phone" })).body).toEqual({
      error: { code: "bad_request", message: "'phone' is required" },
    });
    const noPlus = await v1(key, "POST", "/contacts", { phone: phone.slice(1) });
    expect(noPlus.status).toBe(400);
    expect(noPlus.body.error.code).toBe("bad_request");
    expect((await v1(key, "POST", "/contacts", "not json")).status).toBe(400);

    // Read one.
    const one = await v1(key, "GET", `/contacts/${c.id}`);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ id: c.id, phone: stored(phone), name: "Ada Lovelace" });

    // A second contact for list / search / pagination.
    const bob = await v1(key, "POST", "/contacts", { phone: randomCustomerPhone(), name: "Bob Babbage" });
    expect(bob.status).toBe(201);

    const list = await v1(key, "GET", "/contacts");
    expect(list.status).toBe(200);
    expect(list.body.meta).toEqual({ next_cursor: null });
    const listIds = list.body.data.map((x: { id: string }) => x.id);
    expect(listIds).toEqual(expect.arrayContaining([c.id, bob.body.data.id]));
    // Newest first.
    expect(listIds.indexOf(bob.body.data.id)).toBeLessThan(listIds.indexOf(c.id));

    const search = await v1(key, "GET", "/contacts?search=Lovelace");
    expect(search.body.data.map((x: { id: string }) => x.id)).toEqual([c.id]);
    const byPhone = await v1(key, "GET", `/contacts?search=${encodeURIComponent(phone.slice(-7))}`);
    expect(byPhone.body.data.map((x: { id: string }) => x.id)).toContain(c.id);
    const byTag = await v1(key, "GET", `/contacts?tag=${ids.tagId}`);
    expect(byTag.body.data.map((x: { id: string }) => x.id)).toEqual([c.id]);

    // Keyset pagination.
    const p1 = await v1(key, "GET", "/contacts?limit=1");
    expect(p1.body.data).toHaveLength(1);
    expect(p1.body.meta.next_cursor).toEqual(expect.any(String));
    const p2 = await v1(key, "GET", `/contacts?limit=1&cursor=${encodeURIComponent(p1.body.meta.next_cursor)}`);
    expect(p2.body.data).toHaveLength(1);
    expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id);

    // Update only what's sent; tags replace.
    const patched = await v1(key, "PATCH", `/contacts/${c.id}`, { company: "Difference Engine", tags: ["vip-api"] });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ name: "Ada Lovelace", email: "ada@example.com", company: "Difference Engine" });
    expect(patched.body.data.tags.map((t: { name: string }) => t.name)).toEqual(["vip-api"]);
    const cleared = await v1(key, "PATCH", `/contacts/${c.id}`, { email: null });
    expect(cleared.body.data.email).toBeNull();
    const badType = await v1(key, "PATCH", `/contacts/${c.id}`, { name: 42 });
    expect(badType.status).toBe(400);
    expect(badType.body.error).toEqual({ code: "bad_request", message: "'name' must be a string or null" });

    // The dashboard sees the same contact.
    const dash = await api(owner, "GET", `/api/contacts/${c.id}`);
    expect(JSON.stringify(dash.body)).toContain("Difference Engine");

    // Unknown → 404.
    expect((await v1(key, "GET", `/contacts/${UNKNOWN_UUID}`)).body).toEqual({ error: { code: "not_found", message: "Contact not found" } });
    expect((await v1(key, "PATCH", `/contacts/${UNKNOWN_UUID}`, { name: "x" })).status).toBe(404);
  });

  test("messages: send text and template; Meta receives them", async () => {
    const sent = await v1(key, "POST", "/messages", { to: customer, text: "Hello from the API", name: "API Customer" });
    expect(sent.status).toBe(201);
    expect(sent.body.data).toEqual({
      message_id: expect.any(String),
      whatsapp_message_id: expect.stringMatching(/^wamid\./),
      conversation_id: expect.any(String),
      contact_id: expect.any(String),
      contact_created: true,
    });
    ids.conversation = sent.body.data.conversation_id;
    ids.message = sent.body.data.message_id;
    ids.wamid = sent.body.data.whatsapp_message_id;

    const [out] = await fakes.waitForOutbound({ to: customer, phoneNumberId: wa.phoneNumberId }, (m) => m.id === ids.wamid);
    expect(out).toMatchObject({ type: "text", body: { text: { body: "Hello from the API" } } });

    // Template to the same number: contact is reused.
    const tpl = await v1(key, "POST", "/messages", {
      to: customer,
      type: "template",
      template: { name: "order_update", language: "en_US", params: ["Ada", "#7"] },
    });
    expect(tpl.status).toBe(201);
    expect(tpl.body.data).toMatchObject({ contact_created: false, conversation_id: ids.conversation });
    const [tplOut] = await fakes.waitForOutbound(
      { to: customer, phoneNumberId: wa.phoneNumberId },
      (m) => m.id === tpl.body.data.whatsapp_message_id,
    );
    expect(tplOut.type).toBe("template");
    expect(tplOut.body.template).toMatchObject({ name: "order_update", language: { code: "en_US" } });
    expect(JSON.stringify(tplOut.body.template.components)).toContain("Ada");

    // Reply threading within the conversation.
    const reply = await v1(key, "POST", "/messages", { to: customer, text: "Following up", reply_to_message_id: ids.message });
    expect(reply.status).toBe(201);
    const [replyOut] = await fakes.waitForOutbound(
      { to: customer, phoneNumberId: wa.phoneNumberId },
      (m) => m.id === reply.body.data.whatsapp_message_id,
    );
    expect(replyOut.body.context?.message_id).toBe(ids.wamid);
  });

  test("messages: validation and Meta errors", async () => {
    const noTo = await v1(key, "POST", "/messages", { text: "x" });
    expect(noTo.body).toEqual({ error: { code: "bad_request", message: "'to' is required" } });
    const noPlus = await v1(key, "POST", "/messages", { to: customer.slice(1), text: "x" });
    expect(noPlus.status).toBe(400);
    expect(noPlus.body.error.code).toBe("bad_request");
    expect((await v1(key, "POST", "/messages", { to: randomCustomerPhone() })).status).toBe(400); // no text
    expect((await v1(key, "POST", "/messages", { to: randomCustomerPhone(), type: "image" })).status).toBe(400); // no media_url
    expect((await v1(key, "POST", "/messages", { to: randomCustomerPhone(), type: "template" })).status).toBe(400);

    // Meta refuses the recipient synchronously → 502 meta_error.
    const rejected = await v1(key, "POST", "/messages", { to: "+15550000998", text: "will be refused" });
    expect(rejected.status).toBe(502);
    expect(rejected.body.error.code).toBe("meta_error");

    // An account without WhatsApp → whatsapp_not_configured.
    const lonely = await newOwner("No WA");
    const lonelyKey = (await createKey(lonely, "lonely", ["messages:send"])).key;
    const nc = await v1(lonelyKey, "POST", "/messages", { to: randomCustomerPhone(), text: "x" });
    expect(nc.status).toBe(400);
    expect(nc.body.error.code).toBe("whatsapp_not_configured");
  });

  test("conversations and their messages", async () => {
    const list = await v1(key, "GET", "/conversations");
    expect(list.status).toBe(200);
    const conv = list.body.data.find((c: { id: string }) => c.id === ids.conversation);
    expect(conv).toMatchObject({
      id: ids.conversation,
      status: expect.any(String),
      contact: { phone: stored(customer), name: "API Customer", tags: [] },
    });
    expect(list.body.meta).toHaveProperty("next_cursor");

    const filtered = await v1(key, "GET", `/conversations?contact_id=${conv.contact_id}`);
    expect(filtered.body.data.map((c: { id: string }) => c.id)).toEqual([ids.conversation]);
    const byStatus = await v1(key, "GET", `/conversations?status=${conv.status}`);
    expect(byStatus.body.data.map((c: { id: string }) => c.id)).toContain(ids.conversation);

    const one = await v1(key, "GET", `/conversations/${ids.conversation}`);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ id: ids.conversation, contact_id: conv.contact_id });

    // Messages, newest first, with delivery status from Meta's webhooks.
    await expect
      .poll(async () => {
        const m = await v1(key, "GET", `/conversations/${ids.conversation}/messages`);
        return m.body.data.find((x: { id: string }) => x.id === ids.message)?.status;
      })
      .toBe("delivered");
    const msgs = await v1(key, "GET", `/conversations/${ids.conversation}/messages?limit=2`);
    expect(msgs.status).toBe(200);
    expect(msgs.body.data).toHaveLength(2);
    expect(msgs.body.meta.next_cursor).toEqual(expect.any(String));
    const all = await v1(key, "GET", `/conversations/${ids.conversation}/messages`);
    const first = all.body.data.find((x: { id: string }) => x.id === ids.message);
    expect(first).toMatchObject({
      conversation_id: ids.conversation,
      direction: "outbound",
      content_type: "text",
      content_text: "Hello from the API",
      whatsapp_message_id: ids.wamid,
      status: "delivered",
    });
    expect(all.body.data.at(-1).id).toBe(ids.message); // oldest last
    expect(all.body.data.some((x: { content_type: string; template_name: string }) => x.content_type === "template" && x.template_name === "order_update")).toBe(true);

    // An inbound reply shows up as direction=inbound.
    await fakes.inbound({ from: customer, phone_number_id: wa.phoneNumberId, text: "Thanks, got it" });
    await expect
      .poll(async () => {
        const m = await v1(key, "GET", `/conversations/${ids.conversation}/messages?limit=5`);
        return m.body.data.find((x: { content_text: string }) => x.content_text === "Thanks, got it")?.direction;
      })
      .toBe("inbound");

    expect((await v1(key, "GET", `/conversations/${UNKNOWN_UUID}`)).status).toBe(404);
    expect((await v1(key, "GET", `/conversations/${UNKNOWN_UUID}/messages`)).status).toBe(404);
  });

  test("broadcasts: launch and poll progress", async () => {
    const r1 = randomCustomerPhone();
    const r2 = randomCustomerPhone();
    const launched = await v1(key, "POST", "/broadcasts", {
      name: `API promo ${uniq()}`,
      template_name: "order_update",
      template_language: "en_US",
      recipients: [{ to: r1, params: ["Jane", "#1"] }, { to: r2, params: ["Joe", "#2"] }, { to: "12345" }],
    });
    expect(launched.status).toBe(202);
    expect(launched.body.data).toEqual({
      broadcast_id: expect.any(String),
      status: "sending",
      total_recipients: 2,
      accepted: 2,
      rejected: 1,
    });
    const id = launched.body.data.broadcast_id;
    await fakes.waitForOutbound({ to: r1, phoneNumberId: wa.phoneNumberId }, (m) => m.type === "template");
    await fakes.waitForOutbound({ to: r2, phoneNumberId: wa.phoneNumberId }, (m) => m.type === "template");
    await expect.poll(async () => (await v1(key, "GET", `/broadcasts/${id}`)).body.data?.status).toBe("sent");
    const status = await v1(key, "GET", `/broadcasts/${id}`);
    expect(status.body.data).toMatchObject({ id, template_name: "order_update", template_language: "en_US" });

    const none = await v1(key, "POST", "/broadcasts", { template_name: "order_update", recipients: [{ to: "nope" }] });
    expect(none.status).toBe(400);
    expect((await v1(key, "POST", "/broadcasts", { template_name: "order_update", recipients: [] })).status).toBe(400);
    expect((await v1(key, "GET", `/broadcasts/${UNKNOWN_UUID}`)).status).toBe(404);
  });

  test("tags and deals have no /api/v1 endpoints yet", async () => {
    test.fixme(true, "GAP: the public API has no tags or deals endpoints (docs/public-api.md roadmap) — tags are only reachable through contacts");
    expect((await v1(key, "GET", "/tags")).status).toBe(200);
    expect((await v1(key, "GET", "/deals")).status).toBe(200);
  });

  test("another account's ids are 404, never 403", async () => {
    expect((await v1(key, "GET", `/contacts/${otherIds.contact}`)).status).toBe(404);
    expect((await v1(key, "PATCH", `/contacts/${otherIds.contact}`, { name: "hijack" })).status).toBe(404);
    expect((await v1(key, "GET", `/conversations/${otherIds.conversation}`)).status).toBe(404);
    expect((await v1(key, "GET", `/conversations/${otherIds.conversation}/messages`)).status).toBe(404);
    expect((await v1(key, "GET", `/webhooks/${otherIds.webhook}`)).status).toBe(404);
    expect((await v1(key, "PATCH", `/webhooks/${otherIds.webhook}`, { is_active: false })).status).toBe(404);
    expect((await v1(key, "DELETE", `/webhooks/${otherIds.webhook}`)).status).toBe(404);
    expect((await v1(key, "GET", `/broadcasts/${otherIds.broadcast}`)).status).toBe(404);
    // Lists never leak the other tenant's rows; the other tenant's data is untouched.
    const contacts = await v1(key, "GET", "/contacts?limit=100");
    expect(contacts.body.data.map((c: { id: string }) => c.id)).not.toContain(otherIds.contact);
    const theirs = await v1(otherKey, "GET", `/contacts/${otherIds.contact}`);
    expect(theirs.body.data.name).toBe("Other Customer");
    expect((await v1(otherKey, "GET", `/webhooks/${otherIds.webhook}`)).body.data.is_active).toBe(true);
    // Sending from the API uses the key's own business number.
    const to = randomCustomerPhone();
    const s = await v1(otherKey, "POST", "/messages", { to, text: "from other" });
    expect(s.status).toBe(201);
    await fakes.waitForOutbound({ to, phoneNumberId: otherWa.phoneNumberId });
    expect(await fakes.outbound({ to, phoneNumberId: wa.phoneNumberId })).toHaveLength(0);
  });

  test("malformed ids are 404 not_found, not 500", async () => {
    const calls: Array<[string, string, unknown?]> = [
      ["GET", "/contacts/not-a-uuid"],
      ["PATCH", "/contacts/not-a-uuid", { name: "x" }],
      ["GET", "/conversations/not-a-uuid"],
      ["GET", "/conversations/not-a-uuid/messages"],
      ["GET", "/webhooks/not-a-uuid"],
      ["PATCH", "/webhooks/not-a-uuid", { is_active: false }],
      ["DELETE", "/webhooks/not-a-uuid"],
      ["GET", "/broadcasts/not-a-uuid"],
    ];
    const results: Record<string, [number, string | undefined]> = {};
    for (const [method, p, body] of calls) {
      const r = await v1(key, method, p, body);
      results[`${method} ${p}`] = [r.status, r.body?.error?.code];
    }
    expect(results).toEqual(Object.fromEntries(Object.keys(results).map((k) => [k, [404, "not_found"]])));
  });

  test("a missing scope is 403 forbidden; no scopes still reaches /me", async () => {
    const empty = (await createKey(owner, `no scopes ${uniq()}`, [])).key;
    const me = await v1(empty, "GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.data.key.scopes).toEqual([]);

    const calls: Array<[string, string, Scope, unknown?]> = [
      ["GET", "/contacts", "contacts:read"],
      ["GET", `/contacts/${ids.contact}`, "contacts:read"],
      ["POST", "/contacts", "contacts:write", { phone: randomCustomerPhone() }],
      ["PATCH", `/contacts/${ids.contact}`, "contacts:write", { name: "x" }],
      ["GET", "/conversations", "conversations:read"],
      ["GET", `/conversations/${ids.conversation}`, "conversations:read"],
      ["GET", `/conversations/${ids.conversation}/messages`, "messages:read"],
      ["POST", "/messages", "messages:send", { to: randomCustomerPhone(), text: "x" }],
      ["POST", "/broadcasts", "broadcasts:send", { template_name: "order_update", recipients: [{ to: randomCustomerPhone() }] }],
      ["GET", `/broadcasts/${UNKNOWN_UUID}`, "broadcasts:send"],
      ["GET", "/webhooks", "webhooks:manage"],
      ["POST", "/webhooks", "webhooks:manage", { url: fakes.hookUrl("never"), events: ["message.received"] }],
    ];
    for (const [method, p, scope, body] of calls) {
      const r = await v1(empty, method, p, body);
      expect(r.status, `${method} ${p}`).toBe(403);
      expect(r.body).toEqual({ error: { code: "forbidden", message: `This API key is missing the '${scope}' scope` } });
    }

    // A read-only key reads but cannot write.
    const reader = (await createKey(owner, `reader ${uniq()}`, ["contacts:read"])).key;
    expect((await v1(reader, "GET", "/contacts")).status).toBe(200);
    expect((await v1(reader, "POST", "/contacts", { phone: randomCustomerPhone() })).status).toBe(403);
    expect((await v1(reader, "GET", "/conversations")).status).toBe(403);
    // Nothing was sent by the refused calls.
    const noScopeSends = await fakes.outbound({ phoneNumberId: wa.phoneNumberId });
    expect(noScopeSends.some((m) => m.body?.text?.body === "x")).toBe(false);
  });

  test("no key, a malformed/unknown key, or a revoked key is 401", async () => {
    const unauthorized = { error: { code: "unauthorized", message: "Missing or invalid API key" } };
    expect((await v1(null, "GET", "/me")).body).toEqual(unauthorized);
    expect((await v1(null, "GET", "/me")).status).toBe(401);
    expect((await v1("not-a-key", "GET", "/me")).status).toBe(401);
    expect((await v1(`wacrm_live_${"x".repeat(40)}`, "GET", "/me")).status).toBe(401);
    expect((await v1(`${key}x`, "GET", "/contacts")).status).toBe(401);
    // A dashboard session cookie is not an API credential.
    const cookieOnly = await api(owner, "GET", "/api/v1/me");
    expect(cookieOnly.status).toBe(401);

    // Revoke through the UI.
    const name = `Revoke me ${uniq()}`;
    const doomed = (await createKey(owner, name, ["contacts:read"])).key;
    expect((await v1(doomed, "GET", "/contacts")).status).toBe(200);
    await page.goto("/settings?tab=api");
    const row = page.locator("li").filter({ hasText: name });
    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(toast(page, `Revoked "${name}"`)).toBeVisible();
    await expect(row.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Revoke" })).toHaveCount(0);

    const after = await v1(doomed, "GET", "/contacts");
    expect(after.status).toBe(401);
    expect(after.body).toEqual(unauthorized);
    // Revoked keys stay listed as an audit trail.
    await page.reload();
    await expect(page.locator("li").filter({ hasText: name }).getByText("Revoked", { exact: true })).toBeVisible();
    // Other keys keep working.
    expect((await v1(key, "GET", "/me")).status).toBe(200);
  });

  test("rate limit: 120 requests/minute per key, with retry headers", async () => {
    const limited = (await createKey(owner, `rate ${uniq()}`, [])).key;
    const results: number[] = [];
    for (let batch = 0; batch < 6; batch++) {
      const rs = await Promise.all(Array.from({ length: 20 }, () => v1(limited, "GET", "/me")));
      results.push(...rs.map((r) => r.status));
    }
    expect(results.filter((s) => s === 200)).toHaveLength(120);

    const over = await v1(limited, "GET", "/me");
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ error: { code: "rate_limited", message: "Rate limit exceeded for this API key" } });
    const retryAfter = Number(over.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(over.headers.get("x-ratelimit-limit")).toBe("120");
    expect(over.headers.get("x-ratelimit-remaining")).toBe("0");
    const reset = Number(over.headers.get("x-ratelimit-reset"));
    expect(reset * 1000).toBeGreaterThan(Date.now());
    expect(reset * 1000).toBeLessThanOrEqual(Date.now() + 61_000);

    // The limit is per key: another key of the same account is unaffected.
    expect((await v1(key, "GET", "/me")).status).toBe(200);
  });

  test("webhooks: register, receive signed events, manage", async () => {
    const hook = `api-${uniq()}`;
    const created = await v1(key, "POST", "/webhooks", {
      url: fakes.hookUrl(hook),
      events: ["message.received", "message.status_updated", "conversation.created"],
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      id: expect.any(String),
      url: fakes.hookUrl(hook),
      events: ["message.received", "message.status_updated", "conversation.created"],
      is_active: true,
      failure_count: 0,
      secret: expect.stringMatching(/^whsec_/),
    });
    const webhookId = created.body.data.id;
    await fakes.setHookSecret(hook, created.body.data.secret);

    // Secret is never returned again.
    const list = await v1(key, "GET", "/webhooks");
    expect(list.status).toBe(200);
    expect(list.body.meta).toEqual({ next_cursor: null });
    const listed = list.body.data.find((w: { id: string }) => w.id === webhookId);
    expect(listed).toBeTruthy();
    expect(listed).not.toHaveProperty("secret");
    const one = await v1(key, "GET", `/webhooks/${webhookId}`);
    expect(one.body.data).not.toHaveProperty("secret");
    expect(JSON.stringify(one.body)).not.toContain(created.body.data.secret);

    // Validation.
    expect((await v1(key, "POST", "/webhooks", { url: "http://example.com/hook", events: ["message.received"] })).status).toBe(400);
    expect((await v1(key, "POST", "/webhooks", { url: "not a url", events: ["message.received"] })).status).toBe(400);
    const badEvents = await v1(key, "POST", "/webhooks", { url: "https://example.com/hook", events: ["message.deleted"] });
    expect(badEvents.body).toEqual({ error: { code: "bad_request", message: "'events' must be a non-empty array of known event names" } });
    expect((await v1(key, "POST", "/webhooks", { url: "https://example.com/hook", events: [] })).status).toBe(400);
    expect((await v1(key, "PATCH", `/webhooks/${webhookId}`, {})).status).toBe(400);
    expect((await v1(key, "PATCH", `/webhooks/${webhookId}`, { is_active: "yes" })).status).toBe(400);

    // A new customer writes in → conversation.created + message.received.
    const newCustomer = randomCustomerPhone();
    const inbound = await fakes.inbound({ from: newCustomer, name: "Hook Customer", phone_number_id: wa.phoneNumberId, text: "Hi via webhook" });
    const [convCreated] = await fakes.waitForHooks(hook, (h) => h.event === "conversation.created");
    const [received] = await fakes.waitForHooks(hook, (h) => h.event === "message.received" && h.body.data?.text === "Hi via webhook");
    for (const h of [convCreated, received]) {
      expect(h.signatureValid).toBe(true);
      expect(h.headers["x-wacrm-webhook-id"]).toBe(webhookId);
      expect(h.headers["x-wacrm-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(h.body).toMatchObject({ id: expect.any(String), event: h.event, occurred_at: expect.any(String), account_id: owner.accountId });
    }
    expect(received.body.data).toMatchObject({
      conversation_id: convCreated.body.data.conversation_id,
      contact_id: convCreated.body.data.contact_id,
      whatsapp_message_id: inbound.id,
      content_type: "text",
      text: "Hi via webhook",
    });
    expect(convCreated.body.id).not.toBe(received.body.id);

    // A message sent through the API → message.status_updated (sent, delivered).
    const sent = await v1(key, "POST", "/messages", { to: newCustomer, text: "We got your message" });
    expect(sent.status).toBe(201);
    const wamid = sent.body.data.whatsapp_message_id;
    const statuses = await fakes.waitForHooks(
      hook,
      (h) => h.event === "message.status_updated" && h.body.data?.whatsapp_message_id === wamid,
      2,
    );
    expect(statuses.every((h) => h.signatureValid === true)).toBe(true);
    expect(statuses.map((h) => h.body.data.status)).toEqual(expect.arrayContaining(["sent", "delivered"]));
    expect(statuses[0].body.data.conversation_id).toBe(sent.body.data.conversation_id);

    // Narrow the subscription to message.received only.
    const narrowed = await v1(key, "PATCH", `/webhooks/${webhookId}`, { events: ["message.received"] });
    expect(narrowed.body.data.events).toEqual(["message.received"]);
    const third = randomCustomerPhone();
    await fakes.inbound({ from: third, phone_number_id: wa.phoneNumberId, text: "narrowed" });
    await fakes.waitForHooks(hook, (h) => h.event === "message.received" && h.body.data?.text === "narrowed");
    const fromThird = (await fakes.hooks(hook)).filter((h) => h.event === "conversation.created" && h.at > convCreated.at);
    expect(fromThird).toHaveLength(0);

    // Disable → nothing is delivered; re-enable → deliveries resume.
    const disabled = await v1(key, "PATCH", `/webhooks/${webhookId}`, { is_active: false });
    expect(disabled.body.data.is_active).toBe(false);
    await fakes.inbound({ from: third, phone_number_id: wa.phoneNumberId, text: "while disabled" });
    await expect
      .poll(async () => (await v1(key, "GET", `/conversations?limit=10`)).body.data.find((c: { contact: { phone: string } }) => c.contact?.phone === stored(third))?.last_message_text)
      .toBe("while disabled");
    expect((await fakes.hooks(hook)).some((h) => h.body.data?.text === "while disabled")).toBe(false);
    const enabled = await v1(key, "PATCH", `/webhooks/${webhookId}`, { is_active: true });
    expect(enabled.body.data).toMatchObject({ is_active: true, failure_count: 0 });
    await fakes.inbound({ from: third, phone_number_id: wa.phoneNumberId, text: "enabled again" });
    await fakes.waitForHooks(hook, (h) => h.body.data?.text === "enabled again");

    // A receiver with the wrong secret sees an invalid signature.
    await fakes.setHookSecret(hook, "whsec_wrong");
    await fakes.inbound({ from: third, phone_number_id: wa.phoneNumberId, text: "wrong secret" });
    const [wrong] = await fakes.waitForHooks(hook, (h) => h.body.data?.text === "wrong secret");
    expect(wrong.signatureValid).toBe(false);

    // Delete.
    const del = await v1(key, "DELETE", `/webhooks/${webhookId}`);
    expect(del.body).toEqual({ data: { id: webhookId, deleted: true } });
    expect((await v1(key, "GET", `/webhooks/${webhookId}`)).status).toBe(404);
    expect((await v1(key, "DELETE", `/webhooks/${webhookId}`)).status).toBe(404);
  });

  test.describe("MCP server (mcp-server/) over stdio", () => {
    let entry = "";
    let mcpKey = "";

    test.beforeAll(async () => {
      entry = buildMcpServer();
      mcpKey = (await createKey(owner, `mcp ${uniq()}`, ["contacts:read", "contacts:write", "conversations:read", "messages:read", "messages:send"])).key;
    });

    test.afterAll(() => {
      if (entry) rmSync(path.dirname(entry), { recursive: true, force: true });
    });

    test("refuses to start without configuration", async () => {
      const client = new McpStdioClient(entry, {});
      expect(await client.exited()).toBe(1);
      expect(client.stderr).toContain("Missing required environment variable(s): WACRM_BASE_URL, WACRM_API_KEY");
    });

    test("read-only by default: only read tools are listed", async () => {
      const client = new McpStdioClient(entry, { WACRM_BASE_URL: BASE_URL, WACRM_API_KEY: mcpKey });
      try {
        const init = await client.initialize();
        expect(init.result.serverInfo.name).toBe("wacrm-mcp");
        const tools = await client.request("tools/list");
        const names = tools.result.tools.map((t: { name: string }) => t.name).sort();
        expect(names).toEqual(["get_broadcast", "get_contact", "get_conversation", "list_contacts", "list_conversations", "list_messages", "whoami"]);
        // A write tool doesn't exist in read-only mode.
        const r = await client.request("tools/call", { name: "send_message", arguments: { to: randomCustomerPhone(), text: "x" } });
        expect(r.error ?? r.result?.isError).toBeTruthy();
      } finally {
        client.close();
      }
    });

    test("tools: whoami, list_contacts, create_contact, send_message", async () => {
      const client = new McpStdioClient(entry, { WACRM_BASE_URL: BASE_URL, WACRM_API_KEY: mcpKey, WACRM_ENABLE_WRITES: "true" });
      try {
        await client.initialize();
        const tools = await client.request("tools/list");
        const names: string[] = tools.result.tools.map((t: { name: string }) => t.name);
        expect(names).toEqual(expect.arrayContaining(["whoami", "list_contacts", "create_contact", "update_contact", "send_message"]));
        expect(names).not.toContain("send_broadcast");
        const sendTool = tools.result.tools.find((t: { name: string }) => t.name === "send_message");
        expect(sendTool.inputSchema.required).toContain("to");

        const who = await client.callTool("whoami");
        expect(who.isError).toBe(false);
        expect(JSON.stringify(who.json)).toContain(owner.accountId);
        expect(who.text).toContain("contacts:write");

        const phone = randomCustomerPhone();
        const created = await client.callTool("create_contact", { phone, name: "Mcp Mary", tags: ["mcp"] });
        expect(created.isError).toBe(false);
        expect(JSON.stringify(created.json)).toContain("Mcp Mary");
        const viaApi = await v1(key, "GET", `/contacts?search=${encodeURIComponent("Mcp Mary")}`);
        expect(viaApi.body.data).toHaveLength(1);
        expect(viaApi.body.data[0]).toMatchObject({ phone: stored(phone), name: "Mcp Mary", tags: [expect.objectContaining({ name: "mcp" })] });

        const listed = await client.callTool("list_contacts", { search: "Mcp Mary" });
        expect(listed.isError).toBe(false);
        expect(listed.text).toContain(stored(phone));

        const sent = await client.callTool("send_message", { to: phone, text: "Hello from MCP" });
        expect(sent.isError).toBe(false);
        expect(sent.text).toContain("whatsapp_message_id");
        const [out] = await fakes.waitForOutbound({ to: phone, phoneNumberId: wa.phoneNumberId });
        expect(out.body.text.body).toBe("Hello from MCP");

        // API errors come back as clean tool errors.
        const bad = await client.callTool("send_message", { to: phone.slice(1), text: "no plus" });
        expect(bad.isError).toBe(true);
        expect(bad.text).toContain("wacrm API error [bad_request]");
      } finally {
        client.close();
      }
    });

    test("the key's scopes still apply behind the MCP server", async () => {
      const readOnlyKey = (await createKey(owner, `mcp ro ${uniq()}`, ["contacts:read"])).key;
      const client = new McpStdioClient(entry, { WACRM_BASE_URL: BASE_URL, WACRM_API_KEY: readOnlyKey, WACRM_ENABLE_WRITES: "true" });
      try {
        await client.initialize();
        const r = await client.callTool("send_message", { to: randomCustomerPhone(), text: "should fail" });
        expect(r.isError).toBe(true);
        expect(r.text).toContain("[forbidden]");
        expect(r.text).toContain("messages:send");
      } finally {
        client.close();
      }
    });
  });
});
