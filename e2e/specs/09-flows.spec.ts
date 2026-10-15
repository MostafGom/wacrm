// Flows: starter templates, the runtime walk-through of every node type,
// triggers, agent takeover, the runs page, the timeout sweep and the
// canvas editor — all against the fake WhatsApp customer simulator.

import { expect, test, type Page } from "@playwright/test";

import {
  addMember,
  api,
  connectWhatsApp,
  newOwner,
  pageAs,
  runCron,
  sql,
  type Connection,
  type TestUser,
} from "../support/accounts";
import { fakes, randomCustomerPhone, type OutboundMessage } from "../support/fakes";
import {
  conversationFor,
  getConversation,
  isButtons,
  isList,
  isText,
  outboundCount,
  processingBarrier,
  type Barrier,
} from "../support/flows-ai";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const digits = (s: string) => s.replace(/\D/g, "");
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

interface FlowSpec {
  name: string;
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: Record<string, unknown>;
  nodes: Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>;
  fallback_policy?: Record<string, unknown>;
  activate?: boolean;
}

/** Fixture: create a flow through the API (the editor UI is covered by the canvas tests). */
async function createFlow(user: TestUser, spec: FlowSpec): Promise<string> {
  const created = await api(user, "POST", "/api/flows", {
    name: spec.name,
    trigger_type: spec.trigger_type,
    trigger_config: spec.trigger_config,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.flow.id as string;
  const put = await api(user, "PUT", `/api/flows/${id}`, {
    entry_node_id: "start",
    nodes: spec.nodes,
    ...(spec.fallback_policy ? { fallback_policy: spec.fallback_policy } : {}),
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  if (spec.activate !== false) {
    const act = await api(user, "POST", `/api/flows/${id}/activate`, { status: "active" });
    expect(act.status, JSON.stringify(act.body)).toBe(200);
  }
  return id;
}

async function runsOf(user: TestUser, flowId: string): Promise<Json[]> {
  const r = await api(user, "GET", `/api/flows/${flowId}/runs`);
  expect(r.status).toBe(200);
  return r.body.runs;
}

async function eventsOf(user: TestUser, flowId: string, runId: string): Promise<Json[]> {
  const r = await api(user, "GET", `/api/flows/${flowId}/runs`);
  return (r.body.events as Json[]).filter((e) => e.flow_run_id === runId);
}

/** The (latest) run of `flowId` for the customer `phone`, polled until `status` matches. */
async function waitForRun(user: TestUser, flowId: string, phone: string, status?: string): Promise<Json> {
  let run: Json = null;
  await expect
    .poll(
      async () => {
        const runs = await runsOf(user, flowId);
        run = runs.find((r) => digits(r.contact?.phone ?? "") === digits(phone)) ?? null;
        return run?.status ?? null;
      },
      { message: `run of ${phone} should be ${status ?? "present"}` },
    )
    .toEqual(status ?? expect.anything());
  return run;
}

/** Wait until the customer's active run is parked on `nodeKey` (prompt sent AND pointer persisted). */
async function atNode(user: TestUser, flowId: string, phone: string, nodeKey: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (await runsOf(user, flowId)).find(
          (r) => r.status === "active" && digits(r.contact?.phone ?? "") === digits(phone),
        )?.current_node_key ?? null,
      { message: `${phone} should be waiting at ${nodeKey}` },
    )
    .toBe(nodeKey);
}

async function contactTagIds(user: TestUser, contactId: string): Promise<string[]> {
  const r = await api(user, "GET", `/api/contacts/${contactId}`);
  return r.body.tag_ids ?? [];
}

/** Wait for the n-th outbound message (1-based) matching `predicate` and return it. */
async function nth(wa: Connection, to: string, predicate: (m: OutboundMessage) => boolean, n = 1) {
  const found = await fakes.waitForOutbound({ to, phoneNumberId: wa.phoneNumberId }, predicate, n);
  return found[n - 1];
}

// ============================================================
// 1. Starter templates: clone from the UI, activate, and run them
// ============================================================

test.describe("starter templates", () => {
  test.describe.configure({ mode: "serial" });

  let owner: TestUser;
  let wa: Connection;
  const flowIds: Record<string, string> = {};
  let leadRun: Json;

  test.beforeAll(async () => {
    owner = await newOwner("Tara Templates");
    wa = await connectWhatsApp(owner);
  });

  test("clone Welcome menu, FAQ bot and Lead capture from the gallery and activate each", async ({ browser }) => {
    const { page, context } = await pageAs(browser, owner);
    await page.goto("/flows");
    await expect(page.getByRole("heading", { name: "No flows yet" })).toBeVisible();

    const templates: Array<[string, string, number]> = [
      ["welcome_menu", "Welcome menu", 4],
      ["faq_bot", "FAQ bot", 7],
      ["lead_capture", "Lead capture", 6],
    ];
    for (const [slug, name, nodeCount] of templates) {
      await page.getByRole("button", { name: "New flow" }).click();
      const dialog = page.getByRole("dialog", { name: "Create a new flow" });
      await expect(dialog.getByText("Start from a template", { exact: true })).toBeVisible();
      const card = dialog.getByRole("button", { name: new RegExp(`^${name}`) });
      await expect(card).toContainText(`${nodeCount} nodes`);
      await card.click();

      await page.waitForURL(/\/flows\/[0-9a-f-]{36}$/);
      flowIds[slug] = page.url().split("/").pop()!;
      await expect(page.getByRole("textbox", { name: "Flow name" })).toHaveValue(name);
      await expect(page.getByText("Draft", { exact: true })).toBeVisible();
      await expect(page.getByText("No issues. Ready to activate.")).toBeVisible();

      await page.getByRole("button", { name: "Activate", exact: true }).click();
      await expect(page.getByText("Flow activated.").first()).toBeVisible();
      await expect(page.getByText("Active", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();

      const saved = await api(owner, "GET", `/api/flows/${flowIds[slug]}`);
      expect(saved.body.flow.status).toBe("active");
      expect(saved.body.nodes).toHaveLength(nodeCount);

      await page.getByRole("button", { name: "Back to Flows" }).click();
      await page.waitForURL(/\/flows$/);
    }

    // The list shows all three as active with their trigger summaries.
    for (const [, name] of templates) {
      await expect(page.getByRole("heading", { name, level: 3 })).toBeVisible();
    }
    await expect(page.getByText("Active", { exact: true })).toHaveCount(3);
    await context.close();
  });

  test("Welcome menu: keyword → buttons → tap → handoff to a human", async () => {
    const customer = randomCustomerPhone();
    await fakes.inbound({ from: customer, name: "Wendy Welcome", phone_number_id: wa.phoneNumberId, text: "I need support" });
    const menu = await nth(wa, customer, isButtons);
    await atNode(owner, flowIds.welcome_menu, customer, "welcome");
    expect(menu.body.interactive.body.text).toMatch(/Welcome to support/);
    expect(menu.body.interactive.action.buttons.map((b: Json) => b.reply)).toEqual([
      { id: "existing", title: "Existing customer" },
      { id: "new", title: "New customer" },
    ]);

    await fakes.inbound({
      from: customer,
      phone_number_id: wa.phoneNumberId,
      button_reply: { id: "existing", title: "Existing customer" },
    });
    const run = await waitForRun(owner, flowIds.welcome_menu, customer, "handed_off");
    expect(run.end_reason).toBe("handoff_node");
    const conv = await conversationFor(owner, customer);
    await expect.poll(async () => (await getConversation(owner, conv.id)).status).toBe("pending");
  });

  test("FAQ bot: keyword → list → row → answer → end", async () => {
    const customer = randomCustomerPhone();
    await fakes.inbound({ from: customer, phone_number_id: wa.phoneNumberId, text: "faq please" });
    const list = await nth(wa, customer, isList);
    await atNode(owner, flowIds.faq_bot, customer, "topics");
    expect(list.body.interactive.action.button).toBe("View topics");
    const rows = list.body.interactive.action.sections.flatMap((s: Json) => s.rows.map((r: Json) => r.id));
    expect(rows).toEqual(["hours", "pricing", "refunds", "human"]);

    await fakes.inbound({
      from: customer,
      phone_number_id: wa.phoneNumberId,
      list_reply: { id: "hours", title: "Opening hours" },
    });
    await nth(wa, customer, isText(/open Mon–Fri/));
    const run = await waitForRun(owner, flowIds.faq_bot, customer, "completed");
    expect(run.end_reason).toBe("end_node");
  });

  test("Lead capture: first inbound → three questions → handoff with the answers", async () => {
    const customer = randomCustomerPhone();
    await fakes.inbound({ from: customer, phone_number_id: wa.phoneNumberId, text: "Good morning" });
    await nth(wa, customer, isText(/I'll ask a few quick questions/));
    await nth(wa, customer, isText("What's your name?"));
    await atNode(owner, flowIds.lead_capture, customer, "ask_name");

    await fakes.inbound({ from: customer, phone_number_id: wa.phoneNumberId, text: "Bea" });
    await nth(wa, customer, isText("Thanks Bea! What's your work email?"));
    await atNode(owner, flowIds.lead_capture, customer, "ask_email");
    await fakes.inbound({ from: customer, phone_number_id: wa.phoneNumberId, text: "bea@example.com" });
    await nth(wa, customer, isText(/what's your company name\?/));
    await atNode(owner, flowIds.lead_capture, customer, "ask_company");
    await fakes.inbound({ from: customer, phone_number_id: wa.phoneNumberId, text: "Acme Ltd" });

    const run = await waitForRun(owner, flowIds.lead_capture, customer, "handed_off");
    expect(run.vars).toEqual({ name: "Bea", email: "bea@example.com", company: "Acme Ltd" });
    leadRun = run;
  });

  test("Lead capture: the handoff note carries the captured answers", async () => {
    const events = await eventsOf(owner, flowIds.lead_capture, leadRun.id);
    const handoff = events.find((e) => e.event_type === "handoff");
    expect(handoff.payload.note).toBe("New lead — name=Bea, email=bea@example.com, company=Acme Ltd.");
  });
});

// ============================================================
// 2. Walk-through of every node type
// ============================================================

test.describe("walk-through of every node type", () => {
  test.describe.configure({ mode: "serial" });

  let owner: TestUser;
  let agent: TestUser;
  let viewer: TestUser;
  let wa: Connection;
  let barrier: Barrier;
  let vipTagId: string;
  let flowId: string;
  const KEYWORD = "walkthru";
  const BROCHURE_URL = "https://example.com/e2e-brochure.png";

  const customers = {
    list: randomCustomerPhone(),
    untag: randomCustomerPhone(),
    alice: randomCustomerPhone(),
    bob: randomCustomerPhone(),
    exhaust: randomCustomerPhone(),
    human: randomCustomerPhone(),
    paused: randomCustomerPhone(),
    timeout: randomCustomerPhone(),
    active: randomCustomerPhone(),
    failed: "+15550000998", // the fake rejects every send to this number (131030)
  };

  test.beforeAll(async () => {
    owner = await newOwner("Walter Walk");
    agent = await addMember(owner, "agent", "Andy Agent");
    viewer = await addMember(owner, "viewer", "Vera Viewer");
    wa = await connectWhatsApp(owner);
    barrier = await processingBarrier(owner, "flows09");

    const tag = await api(owner, "POST", "/api/tags", { name: "VIP", color: "#f59e0b" });
    expect(tag.status).toBe(201);
    vipTagId = tag.body.tag.id;

    const send = (key: string, text: string, next: string) => ({
      node_key: key,
      node_type: "send_message",
      config: { text, next_node_key: next },
    });
    flowId = await createFlow(owner, {
      name: "Walk-through",
      trigger_type: "keyword",
      trigger_config: { keywords: [KEYWORD], match_type: "contains" },
      fallback_policy: { on_unknown_reply: "reprompt", max_reprompts: 1, on_timeout_hours: 24, on_exhaust: "handoff" },
      nodes: [
        { node_key: "start", node_type: "start", config: { next_node_key: "tag_vip" } },
        { node_key: "tag_vip", node_type: "set_tag", config: { mode: "add", tag_id: vipTagId, next_node_key: "menu" } },
        {
          node_key: "menu",
          node_type: "send_buttons",
          config: {
            text: "Welcome to the walk-through! Pick a path.",
            header_text: "Walk-through",
            footer_text: "Tap a button",
            buttons: [
              { reply_id: "b_list", title: "See list", next_node_key: "topics" },
              { reply_id: "b_form", title: "Fill form", next_node_key: "ask_name" },
              { reply_id: "b_human", title: "Talk to agent", next_node_key: "to_agent" },
            ],
          },
        },
        {
          node_key: "topics",
          node_type: "send_list",
          config: {
            text: "Choose a topic",
            button_label: "Topics",
            sections: [
              {
                title: "Things",
                rows: [
                  { reply_id: "r_media", title: "Brochure", description: "Get our brochure", next_node_key: "brochure" },
                  { reply_id: "r_untag", title: "Untag me", next_node_key: "untag" },
                ],
              },
            ],
          },
        },
        {
          node_key: "brochure",
          node_type: "send_media",
          config: { media_type: "image", media_url: BROCHURE_URL, caption: "Here is our brochure", next_node_key: "bye" },
        },
        send("bye", "Thanks for walking through!", "done"),
        { node_key: "untag", node_type: "set_tag", config: { mode: "remove", tag_id: vipTagId, next_node_key: "check_tag" } },
        {
          node_key: "check_tag",
          node_type: "condition",
          config: { subject: "tag", subject_key: vipTagId, operator: "present", true_next: "still_vip", false_next: "not_vip" },
        },
        send("still_vip", "You are still VIP.", "done"),
        send("not_vip", "VIP tag removed.", "done"),
        {
          node_key: "ask_name",
          node_type: "collect_input",
          config: { prompt_text: "What's your name?", var_key: "name", next_node_key: "check_name" },
        },
        {
          node_key: "check_name",
          node_type: "condition",
          config: { subject: "var", subject_key: "name", operator: "equals", value: "Alice", true_next: "is_alice", false_next: "not_alice" },
        },
        send("is_alice", "Welcome back, {{vars.name}}!", "done"),
        send("not_alice", "Nice to meet you, {{vars.name}}.", "done"),
        { node_key: "to_agent", node_type: "handoff", config: { note: "Walk-through handoff", assign_to: agent.userId } },
        { node_key: "done", node_type: "end", config: {} },
      ],
    });
  });

  const out = (to: string) => ({ to, phoneNumberId: wa.phoneNumberId });

  test("buttons → list → send_media → send_message → end, tagging the contact on the way", async () => {
    const c = customers.list;
    await fakes.inbound({ from: c, name: "Lisa List", phone_number_id: wa.phoneNumberId, text: `Start the ${KEYWORD} please` });

    const menu = await nth(wa, c, isButtons);
    await atNode(owner, flowId, c, "menu");
    expect(menu.body.interactive.header).toEqual({ type: "text", text: "Walk-through" });
    expect(menu.body.interactive.body.text).toBe("Welcome to the walk-through! Pick a path.");
    expect(menu.body.interactive.footer).toEqual({ text: "Tap a button" });
    expect(menu.body.interactive.action.buttons.map((b: Json) => b.reply.id)).toEqual(["b_list", "b_form", "b_human"]);

    // set_tag (add) ran before the buttons were sent.
    const conv = await conversationFor(owner, c);
    expect(await contactTagIds(owner, conv.contact_id)).toContain(vipTagId);
    let run = await waitForRun(owner, flowId, c, "active");
    expect(run.current_node_key).toBe("menu");

    await fakes.inbound({ from: c, phone_number_id: wa.phoneNumberId, button_reply: { id: "b_list", title: "See list" } });
    const list = await nth(wa, c, isList);
    await atNode(owner, flowId, c, "topics");
    expect(list.body.interactive.body.text).toBe("Choose a topic");
    expect(list.body.interactive.action.button).toBe("Topics");
    expect(list.body.interactive.action.sections[0].title).toBe("Things");
    expect(list.body.interactive.action.sections[0].rows).toEqual([
      { id: "r_media", title: "Brochure", description: "Get our brochure" },
      { id: "r_untag", title: "Untag me" },
    ]);

    await fakes.inbound({ from: c, phone_number_id: wa.phoneNumberId, list_reply: { id: "r_media", title: "Brochure" } });
    const image = await nth(wa, c, (m) => m.type === "image");
    expect(image.body.image).toMatchObject({ link: BROCHURE_URL, caption: "Here is our brochure" });
    const bye = await nth(wa, c, isText("Thanks for walking through!"));
    expect(bye.at).toBeGreaterThanOrEqual(image.at);

    run = await waitForRun(owner, flowId, c, "completed");
    expect(run.end_reason).toBe("end_node");
    const types = (await eventsOf(owner, flowId, run.id)).map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(["started", "node_entered", "message_sent", "reply_received", "completed"]));
  });

  test("set_tag remove + condition on a tag takes the false branch", async () => {
    const c = customers.untag;
    await fakes.inbound({ from: c, name: "Uma Untag", phone_number_id: wa.phoneNumberId, text: KEYWORD });
    await nth(wa, c, isButtons);
    await atNode(owner, flowId, c, "menu");
    const conv = await conversationFor(owner, c);
    await expect.poll(() => contactTagIds(owner, conv.contact_id)).toContain(vipTagId);

    await fakes.inbound({ from: c, phone_number_id: wa.phoneNumberId, button_reply: { id: "b_list", title: "See list" } });
    await nth(wa, c, isList);
    await atNode(owner, flowId, c, "topics");
    await fakes.inbound({ from: c, phone_number_id: wa.phoneNumberId, list_reply: { id: "r_untag", title: "Untag me" } });

    await nth(wa, c, isText("VIP tag removed."));
    expect(await outboundCount(out(c), isText("You are still VIP."))).toBe(0);
    expect(await contactTagIds(owner, conv.contact_id)).not.toContain(vipTagId);
    await waitForRun(owner, flowId, c, "completed");
  });

  test("collect_input: an invalid answer re-prompts, a valid one is captured and routes the var condition (true branch)", async () => {
    const c = customers.alice;
    await fakes.inbound({ from: c, name: "Alice Input", phone_number_id: wa.phoneNumberId, text: KEYWORD });
    await nth(wa, c, isButtons);
    await atNode(owner, flowId, c, "menu");
    await fakes.inbound({ from: c, phone_number_id: wa.phoneNumberId, button_reply: { id: "b_form", title: "Fill form" } });
    await nth(wa, c, isText("What's your name?"));
    await atNode(owner, flowId, c, "ask_name");
    let run = await waitForRun(owner, flowId, c, "active");
    expect(run.current_node_key).toBe("ask_name");

    // Invalid: tapping a stale button is not a text answer → the prompt is sent again.
    await fakes.inbound({ from: c, phone_number_id: wa.phoneNumberId, button_reply: { id: "b_list", title: "See list" } });
    await nth(wa, c, isText("What's your name?"), 2);
    run = await waitForRun(owner, flowId, c, "active");
    expect(run.reprompt_count).toBe(1);
    expect(run.current_node_key).toBe("ask_name");
    expect(await outboundCount(out(c), isList)).toBe(0);

    // Valid answer.
    await fakes.inbound({ from: c, phone_number_id: wa.phoneNumberId, text: "  Alice  " });
    await nth(wa, c, isText("Welcome back, Alice!"));
    run = await waitForRun(owner, flowId, c, "completed");
    expect(run.vars).toEqual({ name: "Alice" });
    expect(run.reprompt_count).toBe(0);
    expect(await outboundCount(out(c), isText(/Nice to meet you/))).toBe(0);
  });

  test("collect_input + var condition false branch interpolates the captured value", async () => {
    const c = customers.bob;
    await fakes.inbound({ from: c, name: "Bob Input", phone_number_id: wa.phoneNumberId, text: KEYWORD });
    await nth(wa, c, isButtons);
    await atNode(owner, flowId, c, "menu");
    await fakes.inbound({ from: c, phone_number_id: wa.phoneNumberId, button_reply: { id: "b_form", title: "Fill form" } });
    await nth(wa, c, isText("What's your name?"));
    await atNode(owner, flowId, c, "ask_name");
    await fakes.inbound({ from: c, phone_number_id: wa.phoneNumberId, text: "Bob" });
    await nth(wa, c, isText("Nice to meet you, Bob."));
    const run = await waitForRun(owner, flowId, c, "completed");
    expect(run.vars).toEqual({ name: "Bob" });
  });

  test("unknown replies re-prompt the buttons, then hand off once max re-prompts is exhausted", async () => {
    const c = customers.exhaust;
    await fakes.inbound({ from: c, name: "Ed Exhaust", phone_number_id: wa.phoneNumberId, text: KEYWORD });
    await nth(wa, c, isButtons);
    await atNode(owner, flowId, c, "menu");

    await barrier.send({ from: c, phone_number_id: wa.phoneNumberId, text: "banana" });
    await nth(wa, c, isButtons, 2); // re-prompt #1 (max_reprompts = 1)
    let run = await waitForRun(owner, flowId, c, "active");
    expect(run.reprompt_count).toBe(1);

    await barrier.send({ from: c, phone_number_id: wa.phoneNumberId, text: "still banana" });
    run = await waitForRun(owner, flowId, c, "handed_off");
    expect(run.end_reason).toBe("fallback_exhausted");
    expect(await outboundCount(out(c), isButtons)).toBe(2); // no third prompt
    const conv = await conversationFor(owner, c);
    expect((await getConversation(owner, conv.id)).status).toBe("pending");
  });

  test("handoff node assigns the configured agent and leaves the note; inbox shows the assignee", async ({ browser }) => {
    const c = customers.human;
    await fakes.inbound({ from: c, name: "Hank Handoff", phone_number_id: wa.phoneNumberId, text: KEYWORD });
    await nth(wa, c, isButtons);
    await atNode(owner, flowId, c, "menu");
    await fakes.inbound({ from: c, phone_number_id: wa.phoneNumberId, button_reply: { id: "b_human", title: "Talk to agent" } });

    const run = await waitForRun(owner, flowId, c, "handed_off");
    expect(run.end_reason).toBe("handoff_node");
    const handoff = (await eventsOf(owner, flowId, run.id)).find((e) => e.event_type === "handoff");
    expect(handoff.payload).toMatchObject({ note: "Walk-through handoff", assigned_to: agent.userId });

    const conv = await conversationFor(owner, c);
    const fresh = await getConversation(owner, conv.id);
    expect(fresh.status).toBe("pending");
    expect(fresh.assigned_agent_id).toBe(agent.userId);

    const { page, context } = await pageAs(browser, owner);
    await page.goto(`/inbox?c=${conv.id}`);
    await expect(page.getByText("Welcome to the walk-through! Pick a path.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Andy Agent/ })).toBeVisible();
    await context.close();
  });

  test("an agent replying from the inbox pauses the run; later taps are no longer consumed", async ({ browser }) => {
    const c = customers.paused;
    await fakes.inbound({ from: c, name: "Paula Paused", phone_number_id: wa.phoneNumberId, text: KEYWORD });
    await nth(wa, c, isButtons);
    await atNode(owner, flowId, c, "menu");
    await waitForRun(owner, flowId, c, "active");
    const conv = await conversationFor(owner, c);

    const { page, context } = await pageAs(browser, owner);
    await page.goto(`/inbox?c=${conv.id}`);
    const box = page.getByPlaceholder(/type a message/i);
    await box.fill("Hi Paula, a human here — I'll take it from here.");
    await box.press("Enter");
    await nth(wa, c, isText("Hi Paula, a human here — I'll take it from here."));

    const run = await waitForRun(owner, flowId, c, "paused_by_agent");
    expect(run.end_reason).toBe("agent_replied");

    // The tap on the old menu is not handled by the flow any more.
    await barrier.send({ from: c, phone_number_id: wa.phoneNumberId, button_reply: { id: "b_list", title: "See list" } });
    expect(await outboundCount(out(c), isList)).toBe(0);
    expect((await waitForRun(owner, flowId, c)).status).toBe("paused_by_agent");
    await context.close();
  });

  test("a send failure fails the run", async () => {
    const c = customers.failed;
    await barrier.send({ from: c, name: "Fred Failed", phone_number_id: wa.phoneNumberId, text: KEYWORD });
    const run = await waitForRun(owner, flowId, c, "failed");
    expect(run.end_reason).toBe("send_buttons_failed");
  });

  test("timeout: a stale active run is swept to timed_out by the cron and the customer can start over", async () => {
    const c = customers.timeout;
    await fakes.inbound({ from: c, name: "Tim Timeout", phone_number_id: wa.phoneNumberId, text: KEYWORD });
    await nth(wa, c, isButtons);
    const run = await waitForRun(owner, flowId, c, "active");

    // Time travel: the run last advanced 25h ago (policy: 24h).
    sql(`UPDATE flow_runs SET last_advanced_at = now() - interval '25 hours' WHERE id = '${run.id}'`);
    await runCron();
    const timedOut = await waitForRun(owner, flowId, c, "timed_out");
    expect(timedOut.ended_at).toBeTruthy();
    expect((await eventsOf(owner, flowId, run.id)).map((e) => e.event_type)).toContain("timeout");

    // A new keyword starts a fresh run (the old one no longer blocks).
    await fakes.inbound({ from: c, phone_number_id: wa.phoneNumberId, text: KEYWORD });
    await nth(wa, c, isButtons, 2);
    await expect
      .poll(async () => (await runsOf(owner, flowId)).filter((r) => digits(r.contact?.phone ?? "") === digits(c)).map((r) => r.status).sort())
      .toEqual(["active", "timed_out"]);
  });

  test("runs page lists every run with its status, node, re-prompts and captured vars", async ({ browser }) => {
    const c = customers.active;
    await fakes.inbound({ from: c, name: "Ada Active", phone_number_id: wa.phoneNumberId, text: KEYWORD });
    await waitForRun(owner, flowId, c, "active");

    const { page, context } = await pageAs(browser, viewer); // any member can read runs
    await page.goto(`/flows/${flowId}`);
    await page.getByRole("button", { name: /Runs/ }).click();
    await page.waitForURL(new RegExp(`/flows/${flowId}/runs$`));
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();

    const card = (name: string) => page.locator("div.rounded-lg.border").filter({ has: page.getByText(name, { exact: true }) });
    const expectations: Array<[string, string]> = [
      ["Lisa List", "Completed"],
      ["Uma Untag", "Completed"],
      ["Alice Input", "Completed"],
      ["Ed Exhaust", "Handed off"],
      ["Hank Handoff", "Handed off"],
      ["Paula Paused", "Paused by agent"],
      ["Fred Failed", "Failed"],
      ["Ada Active", "Active"],
    ];
    for (const [name, status] of expectations) {
      await expect(card(name).first()).toContainText(status);
    }
    await expect(card("Tim Timeout")).toHaveCount(2);
    await expect(card("Tim Timeout").filter({ hasText: "Timed out" })).toHaveCount(1);
    await expect(card("Ada Active")).toContainText("at menu");
    await expect(card("Ed Exhaust")).toContainText("2 re-prompts");

    // Expand a run: captured vars + the event timeline.
    await card("Alice Input").getByRole("button").first().click();
    await expect(card("Alice Input").getByText("Captured vars (1)")).toBeVisible();
    await card("Alice Input").getByText("Captured vars (1)").click();
    await expect(card("Alice Input").locator("pre")).toContainText('"name": "Alice"');
    await expect(card("Alice Input").getByText("captured_key=name")).toBeVisible();
    await expect(card("Alice Input").getByText("completed", { exact: true })).toBeVisible();
    // The handoff event's summary carries the (interpolated) note.
    await card("Hank Handoff").getByRole("button").first().click();
    await expect(card("Hank Handoff").getByText("note=Walk-through handoff")).toBeVisible();
    await context.close();
  });

  test("role gates: viewers can read flows but cannot create, edit or activate them", async ({ browser }) => {
    expect((await api(viewer, "GET", "/api/flows")).status).toBe(200);
    expect((await api(viewer, "GET", `/api/flows/${flowId}`)).status).toBe(200);
    expect((await api(viewer, "POST", "/api/flows", { name: "Nope" })).status).toBe(403);
    expect((await api(viewer, "PUT", `/api/flows/${flowId}`, { name: "Nope" })).status).toBe(403);
    expect((await api(viewer, "POST", `/api/flows/${flowId}/activate`, { status: "draft" })).status).toBe(403);
    expect((await api(viewer, "DELETE", `/api/flows/${flowId}`)).status).toBe(403);
    // Agents can author flows.
    const byAgent = await api(agent, "POST", "/api/flows", { name: "Agent draft" });
    expect(byAgent.status).toBe(201);
    expect((await api(agent, "DELETE", `/api/flows/${byAgent.body.flow.id}`)).status).toBe(200);

    const { page, context } = await pageAs(browser, viewer);
    await page.goto("/flows");
    await expect(page.getByRole("heading", { name: "Walk-through", level: 3 })).toBeVisible();
    await expect(page.getByRole("button", { name: "New flow" })).toBeDisabled();
    await expect(page.locator("span[title=\"Read-only — your role can't create flows\"]")).toBeVisible();
    await context.close();
  });
});

// ============================================================
// 3. Triggers
// ============================================================

test.describe("triggers", () => {
  test.describe.configure({ mode: "serial" });

  let owner: TestUser;
  let wa: Connection;
  let barrier: Barrier;
  let keywordFlow: string;
  let firstFlow: string;
  const regular = randomCustomerPhone();

  test.beforeAll(async () => {
    owner = await newOwner("Trina Trigger");
    wa = await connectWhatsApp(owner);
    barrier = await processingBarrier(owner, "flows09t");
    keywordFlow = await createFlow(owner, {
      name: "Quote bot",
      trigger_type: "keyword",
      trigger_config: { keywords: ["quote", "pricing"], match_type: "contains" },
      nodes: [
        { node_key: "start", node_type: "start", config: { next_node_key: "answer" } },
        { node_key: "answer", node_type: "send_message", config: { text: "Our quotes start at $10.", next_node_key: "end" } },
        { node_key: "end", node_type: "end", config: {} },
      ],
    });
    firstFlow = await createFlow(owner, {
      name: "First hello",
      trigger_type: "first_inbound_message",
      trigger_config: {},
      activate: false,
      nodes: [
        { node_key: "start", node_type: "start", config: { next_node_key: "hello" } },
        { node_key: "hello", node_type: "send_message", config: { text: "Welcome, first-timer!", next_node_key: "end" } },
        { node_key: "end", node_type: "end", config: {} },
      ],
    });
  });

  test("keyword trigger: case-insensitive contains match, ignores other text, re-triggers after completion", async () => {
    const out = { to: regular, phoneNumberId: wa.phoneNumberId };
    await barrier.send({ from: regular, name: "Rita Regular", phone_number_id: wa.phoneNumberId, text: "hello there" });
    expect(await outboundCount(out)).toBe(0);

    await fakes.inbound({ from: regular, phone_number_id: wa.phoneNumberId, text: "Can I get a QUOTE?" });
    await nth(wa, regular, isText("Our quotes start at $10."));
    await waitForRun(owner, keywordFlow, regular, "completed");

    await fakes.inbound({ from: regular, phone_number_id: wa.phoneNumberId, text: "pricing again" });
    await nth(wa, regular, isText("Our quotes start at $10."), 2);
    await expect.poll(async () => (await runsOf(owner, keywordFlow)).filter((r) => r.status === "completed").length).toBe(2);
    const flow = await api(owner, "GET", `/api/flows/${keywordFlow}`);
    expect(flow.body.flow.execution_count).toBe(2);
  });

  test("first-message trigger fires only on a contact's first-ever inbound", async ({ browser }) => {
    // Pause the keyword flow and activate the first-message flow from the editor.
    expect((await api(owner, "POST", `/api/flows/${keywordFlow}/activate`, { status: "draft" })).status).toBe(200);
    const { page, context } = await pageAs(browser, owner);
    await page.goto(`/flows/${firstFlow}`);
    await page.getByRole("button", { name: "Activate", exact: true }).click();
    await expect(page.getByText("Flow activated.").first()).toBeVisible();
    await context.close();

    const newbie = randomCustomerPhone();
    await fakes.inbound({ from: newbie, name: "Nina New", phone_number_id: wa.phoneNumberId, text: "hey" });
    await nth(wa, newbie, isText("Welcome, first-timer!"));
    await waitForRun(owner, firstFlow, newbie, "completed");

    // Second message from the same contact: no welcome again.
    await barrier.send({ from: newbie, phone_number_id: wa.phoneNumberId, text: "hey again" });
    expect(await outboundCount({ to: newbie, phoneNumberId: wa.phoneNumberId }, isText("Welcome, first-timer!"))).toBe(1);

    // A contact who already wrote before the flow went live is not "first".
    await barrier.send({ from: regular, phone_number_id: wa.phoneNumberId, text: "anything new?" });
    expect(await outboundCount({ to: regular, phoneNumberId: wa.phoneNumberId }, isText("Welcome, first-timer!"))).toBe(0);
    expect((await runsOf(owner, firstFlow)).length).toBe(1);
  });

  test("a paused (draft) flow no longer triggers", async () => {
    await barrier.send({ from: regular, phone_number_id: wa.phoneNumberId, text: "quote please" });
    expect(await outboundCount({ to: regular, phoneNumberId: wa.phoneNumberId }, isText("Our quotes start at $10."))).toBe(2);
  });

  test("manual trigger can be started on demand", async () => {
    test.fixme(true, "GAP: the `manual` flow trigger has no start action (no UI button or API route starts a manual flow)");
  });
});

// ============================================================
// 4. Canvas editor
// ============================================================

/** Drag with real mouse events (what React Flow listens to). */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}

async function center(locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe("canvas editor", () => {
  test.describe.configure({ mode: "serial" });

  let owner: TestUser;
  let wa: Connection;

  test.beforeAll(async () => {
    owner = await newOwner("Cora Canvas");
    wa = await connectWhatsApp(owner);
  });

  test("build a flow on the canvas: add, move, connect and delete nodes; validation blocks activation until fixed", async ({ browser }) => {
    const { page, context } = await pageAs(browser, owner);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/flows");
    await page.getByRole("button", { name: "Create your first flow" }).click();
    const dialog = page.getByRole("dialog", { name: "Create a new flow" });
    await expect(dialog.getByRole("button", { name: "Create blank flow" })).toBeDisabled();
    await dialog.getByPlaceholder("e.g. Welcome menu").fill("Canvas built");
    await dialog.getByRole("button", { name: "Create blank flow" }).click();
    await page.waitForURL(/\/flows\/[0-9a-f-]{36}$/);
    const flowId = page.url().split("/").pop()!;

    // Empty canvas.
    await expect(page.getByRole("button", { name: "Canvas", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("No nodes yet.")).toBeVisible();
    await expect(page.getByText("A flow needs at least one node before activation.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Activate", exact: true })).toBeDisabled();

    const node = (key: string) => page.locator(`.react-flow__node[data-id="${key}"]`);
    const pane = page.locator(".react-flow");
    const addNode = async (label: string, key: string, at: { dx: number; dy: number }) => {
      await page.getByRole("button", { name: "Add node" }).click();
      await page.getByRole("menuitem", { name: new RegExp(`^${label}`) }).click();
      await expect(node(key)).toBeVisible();
      // Drop it somewhere free so nodes don't overlap.
      const box = (await pane.boundingBox())!;
      await drag(page, await center(node(key).getByText(key, { exact: true })), {
        x: box.x + box.width / 2 + at.dx,
        y: box.y + box.height / 2 + at.dy,
      });
    };

    await addNode("Start", "start", { dx: -400, dy: -150 });
    await addNode("Send message", "send_message", { dx: -50, dy: 0 });
    await addNode("End", "end", { dx: 300, dy: 170 });
    await addNode("Handoff to agent", "handoff_to_agent", { dx: 300, dy: -170 });
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await expect(node("start")).toContainText("Entry"); // first start node becomes the entry

    // Validation: errors listed and Activate is blocked.
    const panel = page.getByText(/\d+ errors?, \d+ warnings?/).locator("..").locator("..");
    await expect(panel).toContainText("Start node must point to a next node.");
    await expect(panel).toContainText("Send-message node needs a text body.");
    await expect(panel).toContainText("Keyword triggers need at least one keyword.");
    await expect(page.getByRole("button", { name: "Activate", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Activate", exact: true })).toHaveAttribute("title", "Fix the issues below before activating");

    // Connect start → send_message → end by dragging handle to handle.
    const connect = async (from: string, to: string) => {
      await drag(
        page,
        await center(node(from).locator(".react-flow__handle.source").first()),
        await center(node(to).locator(".react-flow__handle.target")),
      );
    };
    await connect("start", "send_message");
    await connect("send_message", "end");
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await expect(panel).not.toContainText("Start node must point to a next node.");

    // Configure the message in the node's side sheet.
    await node("send_message").click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("Sends a WhatsApp text message")).toBeVisible();
    await sheet.getByRole("textbox").fill("Hello from the canvas!");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(node("send_message")).toContainText("Hello from the canvas!");

    // Delete a node with the keyboard: the unreachable handoff disappears.
    await expect(panel).toContainText('Node "handoff_to_agent" is unreachable from the entry node.');
    await node("handoff_to_agent").click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete node" }).click();
    await expect(node("handoff_to_agent")).toHaveCount(0);

    // And one via the Delete key.
    await addNode("End", "end_2", { dx: -400, dy: 170 });
    await node("end_2").click();
    await page.keyboard.press("Escape"); // close the side sheet; the node stays selected
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(node("end_2")).toHaveClass(/selected/);
    await page.keyboard.press("Delete");
    await expect(node("end_2")).toHaveCount(0);

    // Deleting the `end` node (Backspace) also clears send_message's edge → an error returns.
    await node("end").click();
    await page.keyboard.press("Escape"); // close the side sheet; the node stays selected
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.keyboard.press("Backspace");
    await expect(node("end")).toHaveCount(0);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect(panel).toContainText("Send-message node must point to a next node.");
    await expect(page.getByRole("button", { name: "Activate", exact: true })).toBeDisabled();

    // Server agrees: activating the saved-but-broken flow is refused.
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved.").first()).toBeVisible();
    const refused = await api(owner, "POST", `/api/flows/${flowId}/activate`, { status: "active" });
    expect(refused.status).toBe(422);
    expect(refused.body.issues.map((i: Json) => i.message)).toEqual(
      expect.arrayContaining(["Send-message node must point to a next node.", "Keyword triggers need at least one keyword."]),
    );

    // Fix: re-add an end, connect it, and set a keyword in the list view.
    await addNode("End", "end", { dx: 300, dy: 170 });
    await connect("send_message", "end");
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await page.getByRole("button", { name: "List", exact: true }).click();
    const keywords = page.getByPlaceholder("support, help, hi");
    await keywords.fill("canvas, drawn");
    await keywords.press("Enter");
    await page.getByRole("button", { name: "Canvas", exact: true }).click();
    await expect(page.getByText("No issues. Ready to activate.")).toBeVisible();

    await page.getByRole("button", { name: "Activate", exact: true }).click();
    await expect(page.getByText("Flow activated.").first()).toBeVisible();
    const saved = await api(owner, "GET", `/api/flows/${flowId}`);
    expect(saved.body.flow.status).toBe("active");
    expect(saved.body.flow.trigger_config.keywords).toEqual(["canvas", "drawn"]);
    const byKey = Object.fromEntries(saved.body.nodes.map((n: Json) => [n.node_key, n]));
    expect(Object.keys(byKey).sort()).toEqual(["end", "send_message", "start"]);
    expect(byKey.start.config.next_node_key).toBe("send_message");
    expect(byKey.send_message.config).toMatchObject({ text: "Hello from the canvas!", next_node_key: "end" });
    // Positions were persisted from the drags (not all piled at the origin).
    expect(new Set(saved.body.nodes.map((n: Json) => `${n.position_x},${n.position_y}`)).size).toBe(3);
    await context.close();

    // And it works for a customer.
    const customer = randomCustomerPhone();
    await fakes.inbound({ from: customer, phone_number_id: wa.phoneNumberId, text: "I drawn this" });
    await nth(wa, customer, isText("Hello from the canvas!"));
  });

  test("send_media: upload an image in the side sheet and send it to a customer", async ({ browser }) => {
    const flowId = await createFlow(owner, {
      name: "Brochure",
      trigger_type: "keyword",
      trigger_config: { keywords: ["brochure"] },
      activate: false,
      nodes: [
        { node_key: "start", node_type: "start", config: { next_node_key: "media" } },
        {
          node_key: "media",
          node_type: "send_media",
          config: { media_type: "image", media_url: "", caption: "", filename: "", next_node_key: "done" },
        },
        { node_key: "done", node_type: "end", config: {} },
      ],
    });
    const { page, context } = await pageAs(browser, owner);
    await page.goto(`/flows/${flowId}`);
    await expect(page.getByText("Send-media node needs a file (upload one before activating).")).toBeVisible();

    await page.locator('.react-flow__node[data-id="media"]').click();
    const sheet = page.getByRole("dialog");
    const chooser = page.waitForEvent("filechooser");
    await sheet.getByRole("button", { name: "Click to upload (max 16 MB)" }).click();
    await (await chooser).setFiles({ name: "brochure.png", mimeType: "image/png", buffer: Buffer.from(PNG_1PX, "base64") });
    await expect(page.getByText("File uploaded.").first()).toBeVisible();
    await expect(sheet.getByRole("link", { name: "brochure.png" })).toBeVisible();
    await sheet.getByRole("textbox").fill("Our brochure");
    await page.keyboard.press("Escape");
    await expect(page.getByText("No issues. Ready to activate.")).toBeVisible();
    await page.getByRole("button", { name: "Activate", exact: true }).click();
    await expect(page.getByText("Flow activated.").first()).toBeVisible();
    await context.close();

    const saved = await api(owner, "GET", `/api/flows/${flowId}`);
    const media = saved.body.nodes.find((n: Json) => n.node_key === "media").config;
    expect(media).toMatchObject({ media_type: "image", filename: "brochure.png", caption: "Our brochure" });
    expect(media.media_url).toMatch(/brochure/);
    const stored = await fetch(new URL(media.media_url, "http://localhost:3000"));
    expect(stored.status).toBe(200);
    expect(stored.headers.get("content-type")).toContain("image/png");

    const customer = randomCustomerPhone();
    await fakes.inbound({ from: customer, phone_number_id: wa.phoneNumberId, text: "send the brochure" });
    const image = await nth(wa, customer, (m) => m.type === "image");
    expect(image.body.image).toMatchObject({ link: media.media_url, caption: "Our brochure" });
  });

  test("pause and delete flows from the editor and the list", async ({ browser }) => {
    const keep = await createFlow(owner, {
      name: "Pause me",
      trigger_type: "keyword",
      trigger_config: { keywords: ["pause-me"] },
      nodes: [
        { node_key: "start", node_type: "start", config: { next_node_key: "done" } },
        { node_key: "done", node_type: "end", config: {} },
      ],
    });
    const doomed = await createFlow(owner, {
      name: "Delete me from list",
      trigger_type: "manual",
      trigger_config: {},
      activate: false,
      nodes: [],
    });
    const doomed2 = await createFlow(owner, {
      name: "Delete me in editor",
      trigger_type: "manual",
      trigger_config: {},
      activate: false,
      nodes: [],
    });
    const { page, context } = await pageAs(browser, owner);
    page.on("dialog", (d) => void d.accept());

    await page.goto(`/flows/${keep}`);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByText("Saved as draft.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Activate", exact: true })).toBeEnabled();
    expect((await api(owner, "GET", `/api/flows/${keep}`)).body.flow.status).toBe("draft");

    await page.goto(`/flows/${doomed2}`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForURL(/\/flows$/);
    expect((await api(owner, "GET", `/api/flows/${doomed2}`)).status).toBe(404);

    const card = page.locator("div.rounded-lg.border").filter({ has: page.getByRole("heading", { name: "Delete me from list" }) });
    await expect(card).toContainText("Manual trigger");
    await card.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Flow deleted.").first()).toBeVisible();
    await expect(card).toHaveCount(0);
    expect((await api(owner, "GET", `/api/flows/${doomed}`)).status).toBe(404);
    // Editing an unknown flow shows the not-found state.
    await page.goto(`/flows/${doomed}`);
    await expect(page.getByText("Flow not found.")).toBeVisible();
    await context.close();
  });

  test("multi-slot nodes: each button gets its own handle and edge label", async ({ browser }) => {
    const flowId = await createFlow(owner, {
      name: "Buttons on canvas",
      trigger_type: "keyword",
      trigger_config: { keywords: ["zzz-never"] },
      activate: false,
      nodes: [
        { node_key: "start", node_type: "start", config: { next_node_key: "menu" } },
        {
          node_key: "menu",
          node_type: "send_buttons",
          config: {
            text: "Pick",
            buttons: [
              { reply_id: "yes", title: "Yes please", next_node_key: "" },
              { reply_id: "no", title: "No thanks", next_node_key: "" },
            ],
          },
        },
        { node_key: "done", node_type: "end", config: {} },
      ],
    });
    const { page, context } = await pageAs(browser, owner);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`/flows/${flowId}`);
    const node = (key: string) => page.locator(`.react-flow__node[data-id="${key}"]`);
    await expect(node("menu").locator(".react-flow__handle.source")).toHaveCount(2);
    await expect(page.getByText("Button 1 needs a next node.")).toBeVisible();
    await expect(page.getByText("Button 2 needs a next node.")).toBeVisible();

    // Auto-layout places nodes top-to-bottom; connect the "No thanks" slot only.
    await drag(
      page,
      await center(node("menu").locator('.react-flow__handle.source[data-handleid="button:no"]')),
      await center(node("done").locator(".react-flow__handle.target")),
    );
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await expect(page.locator(".react-flow__edge-text", { hasText: "No thanks" })).toBeVisible();
    await expect(page.getByText("Button 2 needs a next node.")).toHaveCount(0);
    await expect(page.getByText("Button 1 needs a next node.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Activate", exact: true })).toBeDisabled();

    // Clicking a validation issue focuses that node.
    await page.getByRole("button", { name: "Jump to node menu" }).first().click();
    await expect(node("menu").locator("div.ring-2")).toBeVisible();

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved.").first()).toBeVisible();
    const saved = await api(owner, "GET", `/api/flows/${flowId}`);
    const menu = saved.body.nodes.find((n: Json) => n.node_key === "menu");
    expect(menu.config.buttons.map((b: Json) => b.next_node_key)).toEqual(["", "done"]);
    await context.close();
  });
});
