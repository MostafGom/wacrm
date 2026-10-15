// AI agent: provider setup (OpenAI-compatible / OpenAI / Anthropic against
// the fake providers), knowledge base, playground, inbox drafts, the
// auto-reply bot with its per-conversation cap and human handoff, the
// usage dashboard and the role gates.

import { expect, test, type Page } from "@playwright/test";

import { addMember, api, connectWhatsApp, newOwner, pageAs, type Connection, type TestUser } from "../support/accounts";
import { fakes, randomCustomerPhone } from "../support/fakes";
import { conversationFor, getConversation, isText, outboundCount, processingBarrier, type Barrier } from "../support/flows-ai";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const tag = Math.random().toString(36).slice(2, 8);
const MODELS = {
  compat: `e2e-compat-${tag}`,
  openai: `gpt-e2e-${tag}`,
  anthropic: `claude-e2e-${tag}`,
};
const KB_V1 = "Our zebrafish aquarium opens at 7am every Saturday morning.";
const KB_V2 = "Our zebrafish aquarium opens at 8am every Saturday morning.";

/** Toasts render twice (sonner + live region) — match the first. */
const toast = (page: Page, text: string | RegExp) => page.getByText(text).first();

async function aiLogSince(at: number) {
  return (await fakes.aiLog()).filter((e) => ((e as Json).at ?? 0) >= at) as Json[];
}

async function openSetup(page: Page) {
  await page.goto("/agents");
  await page.getByRole("tab", { name: "Setup" }).click();
  await expect(page.getByText("Provider & key")).toBeVisible();
}

async function pickProvider(page: Page, label: string) {
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

test.describe("AI agent", () => {
  test.describe.configure({ mode: "serial" });

  let owner: TestUser;
  let agent: TestUser;
  let viewer: TestUser;
  let wa: Connection;
  let barrier: Barrier;
  let kbDocId: string;
  const dora = randomCustomerPhone(); // draft
  const carl = randomCustomerPhone(); // auto-reply + cap
  const hugo = randomCustomerPhone(); // handoff

  test.beforeAll(async () => {
    owner = await newOwner("Ophelia Owner");
    agent = await addMember(owner, "agent", "Andy Agent");
    viewer = await addMember(owner, "viewer", "Vera Viewer");
    wa = await connectWhatsApp(owner);
    barrier = await processingBarrier(owner, "ai10");
  });

  test("setup: OpenAI-compatible provider — bad key is rejected, good key tests OK and saves", async ({ browser }) => {
    const { page, context } = await pageAs(browser, owner);
    await page.goto("/agents");
    // Not configured yet → lands on Setup.
    await expect(page.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Usage" })).toBeVisible();

    await pickProvider(page, "OpenAI-compatible API");
    await expect(page.getByLabel("Model")).toHaveValue("");
    await page.getByLabel("Model").fill(MODELS.compat);
    await page.getByLabel("Base URL").fill(fakes.aiCompatBaseUrl);

    // Save without a key → client-side guard.
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "Enter your API key.")).toBeVisible();

    await page.getByLabel("API key").fill("bad-key");
    let t0 = Date.now();
    await page.getByRole("button", { name: "Test key" }).click();
    await expect(toast(page, /Incorrect API key provided \(fake\)/)).toBeVisible();
    // Saving with a bad key is refused too (the server validates first).
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, /Incorrect API key provided \(fake\)/).nth(0)).toBeVisible();
    expect((await api(owner, "GET", "/api/ai/config")).body.configured).toBe(false);

    await page.getByLabel("API key").fill("e2e-compat-key");
    t0 = Date.now();
    await page.getByRole("button", { name: "Test key" }).click();
    await expect(toast(page, "Key works — the provider responded.")).toBeVisible();
    expect((await aiLogSince(t0)).some((e) => e.provider === "compat" && e.model === MODELS.compat)).toBe(true);

    // Behaviour: business context + master switch + embeddings key (fake OpenAI embeddings).
    await page.getByLabel("Embeddings key").fill("sk-e2e-embeddings");
    await page.getByLabel("Business context & instructions").fill("We are Fishy Co, a friendly pet shop.");
    await page.getByRole("switch").nth(0).click(); // Enable AI assistant
    await expect(page.getByRole("switch").nth(1)).toBeEnabled(); // auto-reply becomes available
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "AI assistant saved.")).toBeVisible();

    const cfg = (await api(owner, "GET", "/api/ai/config")).body;
    expect(cfg).toMatchObject({
      configured: true,
      provider: "openai_compatible",
      model: MODELS.compat,
      base_url: fakes.aiCompatBaseUrl,
      has_key: true,
      has_embeddings_key: true,
      is_active: true,
      auto_reply_enabled: false,
      system_prompt: "We are Fishy Co, a friendly pet shop.",
    });
    expect(JSON.stringify(cfg)).not.toContain("e2e-compat-key"); // the key is never returned

    // Reload: the key field is masked and the knowledge base says semantic search is on.
    await page.reload();
    await page.getByRole("tab", { name: "Setup" }).click();
    await expect(page.getByLabel("API key")).toHaveValue("••••••••••••••••");
    await expect(page.getByText("Semantic search is on (embeddings key set).", { exact: false })).toBeVisible();
    await context.close();
  });

  test("setup: OpenAI and Anthropic providers validate against their APIs", async ({ browser }) => {
    const { page, context } = await pageAs(browser, owner);
    await openSetup(page);

    await pickProvider(page, "OpenAI");
    await page.getByLabel("Model").fill(MODELS.openai);
    await page.getByLabel("API key").fill("sk-e2e-openai");
    let t0 = Date.now();
    await page.getByRole("button", { name: "Test key" }).click();
    await expect(toast(page, "Key works — the provider responded.")).toBeVisible();
    expect((await aiLogSince(t0)).some((e) => e.provider === "openai" && e.model === MODELS.openai)).toBe(true);

    await pickProvider(page, "Anthropic (Claude)");
    await page.getByLabel("Model").fill(MODELS.anthropic);
    await page.getByLabel("API key").fill("sk-ant-e2e");
    t0 = Date.now();
    await page.getByRole("button", { name: "Test key" }).click();
    await expect(toast(page, "Key works — the provider responded.").last()).toBeVisible();
    await expect.poll(async () => (await aiLogSince(t0)).some((e) => e.provider === "anthropic" && e.model === MODELS.anthropic)).toBe(true);

    // A bad key is rejected for these providers too.
    await page.getByLabel("API key").fill("bad-key");
    await page.getByRole("button", { name: "Test key" }).click();
    await expect(toast(page, /Incorrect API key provided \(fake\)/)).toBeVisible();

    // Keep Anthropic as the live provider for the rest of the file.
    await page.getByLabel("API key").fill("sk-ant-e2e");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "AI assistant saved.")).toBeVisible();
    const cfg = (await api(owner, "GET", "/api/ai/config")).body;
    expect(cfg).toMatchObject({ provider: "anthropic", model: MODELS.anthropic, base_url: null, is_active: true });
    await context.close();
  });

  test("knowledge base: create, edit, delete and reindex documents (embedded via the fake)", async ({ browser }) => {
    const { page, context } = await pageAs(browser, owner);
    await openSetup(page);
    const kb = page.locator("[data-slot=card]").filter({ hasText: "Knowledge base" });
    await expect(kb.getByText("No documents yet.")).toBeVisible();

    // Create.
    await kb.getByRole("button", { name: "Add document" }).click();
    await kb.getByRole("button", { name: "Save document" }).click();
    await expect(toast(page, "Title and content are required.")).toBeVisible();
    await kb.getByLabel("Title").fill("Zebrafish hours");
    await kb.getByLabel("Content").fill(KB_V1);
    let t0 = Date.now();
    await kb.getByRole("button", { name: "Save document" }).click();
    await expect(toast(page, "Document added.")).toBeVisible();
    const row = kb.getByRole("listitem").filter({ hasText: "Zebrafish hours" });
    await expect(row).toBeVisible();
    await expect.poll(async () => (await aiLogSince(t0)).filter((e) => e.kind === "embeddings").length).toBeGreaterThan(0);
    const docs = (await api(owner, "GET", "/api/ai/knowledge")).body.documents;
    expect(docs.map((d: Json) => d.title)).toEqual(["Zebrafish hours"]);
    kbDocId = docs[0].id;

    // Edit.
    await row.getByRole("button", { name: "Edit" }).click();
    await expect(kb.getByLabel("Content")).toHaveValue(KB_V1);
    await kb.getByLabel("Content").fill(KB_V2);
    t0 = Date.now();
    await kb.getByRole("button", { name: "Save document" }).click();
    await expect(toast(page, "Document updated.")).toBeVisible();
    await expect.poll(async () => (await aiLogSince(t0)).filter((e) => e.kind === "embeddings").length).toBeGreaterThan(0);
    expect((await api(owner, "GET", `/api/ai/knowledge/${kbDocId}`)).body.content).toBe(KB_V2);

    // Delete (a second, throw-away document).
    await kb.getByRole("button", { name: "Add document" }).click();
    await kb.getByLabel("Title").fill("Temporary note");
    await kb.getByLabel("Content").fill("This document is about to be deleted.");
    await kb.getByRole("button", { name: "Save document" }).click();
    await expect(toast(page, "Document added.")).toBeVisible();
    const tmp = kb.getByRole("listitem").filter({ hasText: "Temporary note" });
    await tmp.getByRole("button", { name: "Delete" }).click();
    await expect(toast(page, "Document removed.")).toBeVisible();
    await expect(tmp).toHaveCount(0);
    expect((await api(owner, "GET", "/api/ai/knowledge")).body.documents.map((d: Json) => d.title)).toEqual(["Zebrafish hours"]);

    // Reindex re-embeds every document.
    t0 = Date.now();
    await kb.getByRole("button", { name: "Reindex" }).click();
    await expect(toast(page, "Reindexed 1 document(s).")).toBeVisible();
    expect((await aiLogSince(t0)).filter((e) => e.kind === "embeddings").length).toBeGreaterThan(0);
    await context.close();
  });

  test("playground: the answer cites the knowledge base; a request for a human shows the handoff marker", async ({ browser }) => {
    const { page, context } = await pageAs(browser, owner);
    await page.goto("/agents");
    // Configured → lands on the Playground.
    await expect(page.getByRole("tab", { name: "Playground" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Send a message to see how your agent would reply.")).toBeVisible();

    const box = page.getByPlaceholder("Type a customer message…");
    await box.fill("When does the zebrafish aquarium open?");
    await box.press("Enter");
    await expect(page.getByText("When does the zebrafish aquarium open?")).toBeVisible();
    await expect(page.getByText(`Fake AI: [1] ${KB_V2}`)).toBeVisible();

    await box.fill("Can I talk to a human please?");
    await box.press("Enter");
    await expect(page.getByText("Let me connect you with a member of our team.")).toBeVisible();
    await expect(page.getByText("Would hand off to a human here")).toBeVisible();

    await page.getByRole("button", { name: "Reset" }).click();
    await expect(page.getByText("Send a message to see how your agent would reply.")).toBeVisible();
    await context.close();
  });

  test("inbox: Draft with AI fills the composer without sending; the agent sends it", async ({ browser }) => {
    await barrier.send({ from: dora, name: "Dora Draft", phone_number_id: wa.phoneNumberId, text: "Is the zebrafish aquarium open on Saturday?" });
    const conv = await conversationFor(owner, dora);
    // Auto-reply is still off → nothing was sent.
    expect(await outboundCount({ to: dora, phoneNumberId: wa.phoneNumberId })).toBe(0);

    const { page, context } = await pageAs(browser, owner);
    await page.goto(`/inbox?c=${conv.id}`);
    await expect(page.getByText("Is the zebrafish aquarium open on Saturday?").last()).toBeVisible();
    // Auto-reply off for the account → no AI banner.
    await expect(page.getByText("AI assistant is replying automatically")).toHaveCount(0);

    await page.getByTitle("Draft a reply with AI").getByRole("button").click();
    const composer = page.getByPlaceholder(/type a message/i);
    await expect(composer).toHaveValue(`Fake AI: [1] ${KB_V2}`);
    expect(await outboundCount({ to: dora, phoneNumberId: wa.phoneNumberId })).toBe(0);

    await composer.press("Enter");
    const [sent] = await fakes.waitForOutbound({ to: dora, phoneNumberId: wa.phoneNumberId }, isText(`Fake AI: [1] ${KB_V2}`));
    expect(sent.body.text.body).toContain("8am");
    await context.close();
  });

  test("auto-reply answers inbound messages until the per-conversation cap", async ({ browser }) => {
    const { page, context } = await pageAs(browser, owner);
    await openSetup(page);
    await page.getByRole("switch").nth(1).click(); // Auto-reply to inbound messages
    await page.getByLabel("Max auto-replies per conversation").fill("2");
    await page.locator("#ai-handoff").click();
    await page.getByRole("option", { name: /Andy Agent/ }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "AI assistant saved.")).toBeVisible();
    expect((await api(owner, "GET", "/api/ai/config")).body).toMatchObject({
      auto_reply_enabled: true,
      auto_reply_max_per_conversation: 2,
      handoff_agent_id: agent.userId,
    });

    const out = { to: carl, phoneNumberId: wa.phoneNumberId };
    await barrier.send({ from: carl, name: "Carl Cap", phone_number_id: wa.phoneNumberId, text: "Hello, is the zebrafish aquarium open?" });
    await fakes.waitForOutbound(out, isText(`Fake AI: [1] ${KB_V2}`), 1);

    const conv = await conversationFor(owner, carl);
    await page.goto(`/inbox?c=${conv.id}`);
    await expect(page.getByText("AI assistant is replying automatically")).toBeVisible();
    await expect(page.getByRole("button", { name: "Take over" })).toBeVisible();
    await expect(page.getByTitle("Sent automatically by the AI assistant")).toHaveCount(1);

    await barrier.send({ from: carl, phone_number_id: wa.phoneNumberId, text: "And is the zebrafish aquarium open on Sunday?" });
    await fakes.waitForOutbound(out, isText(/^Fake AI:/), 2);
    await expect(page.getByTitle("Sent automatically by the AI assistant")).toHaveCount(2);

    // Cap reached: the third message gets no bot reply, and the LLM is not called.
    await barrier.send({ from: carl, phone_number_id: wa.phoneNumberId, text: "One more zebrafish question!" });
    expect(await outboundCount(out)).toBe(2);
    expect((await fakes.aiLog()).some((e) => (e.prompt ?? "").includes("One more zebrafish question!"))).toBe(false);
    const fresh = await getConversation(owner, conv.id);
    expect(fresh.ai_reply_count).toBe(2);
    await context.close();
  });

  test("hitting the reply cap hands the conversation off to the configured agent", async () => {
    const conv = await conversationFor(owner, carl);
    const fresh = await getConversation(owner, conv.id);
    expect(fresh.assigned_agent_id).toBe(agent.userId);
    expect(fresh.ai_autoreply_disabled).toBe(true);
    // Which customer message is quoted isn't asserted: inbound rows carry Meta's
    // second-resolution timestamp, so two messages sent within one second tie.
    expect(fresh.ai_handoff_summary).toMatch(/^🤖 AI agent handed off after 2 replies\. Last customer message: “.+”$/);
  });

  test("handoff: 'human' hands off to the configured agent, auto-reply stops; Resume AI and Take over from the banner", async ({ browser }) => {
    const out = { to: hugo, phoneNumberId: wa.phoneNumberId };
    await barrier.send({ from: hugo, name: "Hugo Human", phone_number_id: wa.phoneNumberId, text: "I want to talk to a human" });
    expect(await outboundCount(out)).toBe(0);

    const conv = await conversationFor(owner, hugo);
    let fresh = await getConversation(owner, conv.id);
    expect(fresh.ai_autoreply_disabled).toBe(true);
    expect(fresh.assigned_agent_id).toBe(agent.userId);
    expect(fresh.ai_handoff_summary).toBe("🤖 AI agent handed off without replying. Last customer message: “I want to talk to a human”");

    // Auto-reply stays off for this thread.
    await barrier.send({ from: hugo, phone_number_id: wa.phoneNumberId, text: "Hello? Anyone about the zebrafish aquarium?" });
    expect(await outboundCount(out)).toBe(0);

    const { page, context } = await pageAs(browser, owner);
    await page.goto(`/inbox?c=${conv.id}`);
    await expect(page.getByText("AI assistant is paused here")).toBeVisible();
    await expect(page.getByText(/AI agent handed off without replying/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Andy Agent/ })).toBeVisible();

    // The assigned human answers, then hands the thread back to the bot.
    const composer = page.getByPlaceholder(/type a message/i);
    await composer.fill("Hi Hugo, a teammate here. Our assistant can help with opening times.");
    await composer.press("Enter");
    const [agentReply] = await fakes.waitForOutbound(out, isText(/a teammate here/));
    // Inbound messages carry WhatsApp's whole-second timestamp while our own
    // sends are stamped to the millisecond; step past the reply's second so
    // the customer's next message sorts after it in the AI's context.
    await expect.poll(() => Math.floor(Date.now() / 1000)).toBeGreaterThan(Math.floor(agentReply.at / 1000));

    // Resume AI: unpauses, releases the assignment, the bot answers again.
    await page.getByRole("button", { name: "Resume AI" }).click();
    await expect(toast(page, "AI resumed.")).toBeVisible();
    await expect(page.getByText("AI assistant is replying automatically")).toBeVisible();
    fresh = await getConversation(owner, conv.id);
    expect(fresh).toMatchObject({ ai_autoreply_disabled: false, assigned_agent_id: null, ai_reply_count: 0, ai_handoff_summary: null });
    await barrier.send({ from: hugo, phone_number_id: wa.phoneNumberId, text: "When does the zebrafish aquarium open?" });
    await fakes.waitForOutbound(out, isText(`Fake AI: [1] ${KB_V2}`), 1);
    await expect(page.getByTitle("Sent automatically by the AI assistant")).toHaveCount(1);

    // Take over: the bot pauses and the thread is assigned to me.
    await page.getByRole("button", { name: "Take over" }).click();
    await expect(toast(page, "You’ve taken over this chat.")).toBeVisible();
    await expect(page.getByText("AI assistant is paused here")).toBeVisible();
    fresh = await getConversation(owner, conv.id);
    expect(fresh).toMatchObject({ ai_autoreply_disabled: true, assigned_agent_id: owner.userId });
    await barrier.send({ from: hugo, phone_number_id: wa.phoneNumberId, text: "Thanks, and the zebrafish aquarium price?" });
    expect(await outboundCount(out)).toBe(2); // the teammate's reply + one bot reply
    await context.close();
  });

  test("usage tab shows call and token counts per mode and model", async ({ browser }) => {
    const usage = (await api(owner, "GET", "/api/ai/usage?days=30")).body;
    // Carl ×2, Hugo handoff ×1, Hugo after resume ×1 → 4 auto-replies; Dora → 1 draft.
    expect(usage.by_mode.auto_reply.calls).toBe(4);
    expect(usage.by_mode.draft.calls).toBe(1);
    expect(usage.totals.calls).toBe(5);
    expect(usage.totals.total_tokens).toBeGreaterThan(0);
    expect(usage.by_model).toEqual([expect.objectContaining({ model: MODELS.anthropic, provider: "anthropic", calls: 5 })]);

    const { page, context } = await pageAs(browser, owner);
    await page.goto("/agents");
    await page.getByRole("tab", { name: "Usage" }).click();
    await expect(page.getByText("Token usage")).toBeVisible();
    const stat = (label: string) => page.locator("div.rounded-md.border").filter({ has: page.getByText(label, { exact: true }) });
    await expect(stat("LLM calls")).toContainText("5");
    await expect(stat("Total tokens")).toContainText(String(usage.totals.total_tokens));
    await expect(page.getByText("Tokens per day")).toBeVisible();
    const modelRow = page.getByRole("listitem").filter({ hasText: MODELS.anthropic });
    await expect(modelRow).toContainText("(anthropic)");
    await expect(modelRow).toContainText("5 calls");

    // Switching the window refetches.
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "Last 7 days" }).click();
    await expect(stat("LLM calls")).toContainText("5");
    await context.close();
  });

  test("role gates: agents use the AI but can't configure it; viewers can't use it", async ({ browser }) => {
    const conv = await conversationFor(owner, dora);

    // ---- agent ----
    for (const [method, path, body] of [
      ["POST", "/api/ai/config", { provider: "openai", model: "x", api_key: "k" }],
      ["DELETE", "/api/ai/config", undefined],
      ["POST", "/api/ai/test", { provider: "openai", model: "x", api_key: "k" }],
      ["POST", "/api/ai/knowledge", { title: "t", content: "c" }],
      ["PATCH", `/api/ai/knowledge/${kbDocId}`, { title: "t", content: "c" }],
      ["DELETE", `/api/ai/knowledge/${kbDocId}`, undefined],
      ["POST", "/api/ai/knowledge/reindex", undefined],
      ["GET", "/api/ai/usage", undefined],
    ] as const) {
      expect((await api(agent, method, path, body)).status, `${method} ${path} as agent`).toBe(403);
    }
    const agentCfg = await api(agent, "GET", "/api/ai/config");
    expect(agentCfg.status).toBe(200);
    expect(agentCfg.body).toMatchObject({ configured: true, has_key: true });
    expect(agentCfg.body).not.toHaveProperty("api_key");
    expect((await api(agent, "GET", "/api/ai/knowledge")).status).toBe(200);
    const pg = await api(agent, "POST", "/api/ai/playground", { messages: [{ role: "user", content: "zebrafish aquarium?" }] });
    expect(pg.status).toBe(200);
    expect(pg.body.reply).toContain("8am");
    const draft = await api(agent, "POST", "/api/ai/draft", { conversation_id: conv.id });
    expect(draft.status).toBe(200);
    expect(draft.body.draft).toContain("8am");

    const a = await pageAs(browser, agent);
    await a.page.goto("/agents");
    await expect(a.page.getByRole("tab", { name: "Playground" })).toBeVisible();
    await expect(a.page.getByRole("tab", { name: "Usage" })).toHaveCount(0);
    await a.page.getByRole("tab", { name: "Setup" }).click();
    await expect(a.page.getByText("Only admins and owners can change the AI configuration.")).toBeVisible();
    await expect(a.page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(a.page.getByRole("button", { name: "Test key" })).toBeDisabled();
    await expect(a.page.getByLabel("Model")).toBeDisabled();
    await expect(a.page.getByText("Zebrafish hours")).toBeVisible();
    await expect(a.page.getByRole("button", { name: "Add document" })).toHaveCount(0);
    await a.context.close();

    // ---- viewer ----
    for (const [method, path, body] of [
      ["POST", "/api/ai/playground", { messages: [{ role: "user", content: "hi" }] }],
      ["POST", "/api/ai/draft", { conversation_id: conv.id }],
      ["POST", `/api/ai/autoreply/${conv.id}`, { paused: true }],
      ["POST", "/api/ai/config", { provider: "openai", model: "x", api_key: "k" }],
      ["GET", "/api/ai/usage", undefined],
    ] as const) {
      expect((await api(viewer, method, path, body)).status, `${method} ${path} as viewer`).toBe(403);
    }
    expect((await api(viewer, "GET", "/api/ai/config")).status).toBe(200);

    const v = await pageAs(browser, viewer);
    await v.page.goto(`/inbox?c=${conv.id}`);
    await expect(v.page.getByText("Is the zebrafish aquarium open on Saturday?").last()).toBeVisible();
    await expect(v.page.getByTitle("Draft a reply with AI")).toHaveCount(0);
    await expect(v.page.locator("span[title=\"Read-only — your role can't send messages\"] button").first()).toBeDisabled();
    await v.context.close();

    // Anonymous.
    expect((await api(null, "GET", "/api/ai/config")).status).toBe(401);
  });
});
