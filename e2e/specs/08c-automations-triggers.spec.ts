// Automations — every trigger, fired by simulated customer messages (or a
// tag write), with effects checked on the fake WhatsApp outbox and the API.
// Each test gets its own account so one test's automations can't fire on
// another's messages.

import { expect, test } from "@playwright/test";

import { api, pageAs } from "../support/accounts";
import { fakes, randomCustomerPhone } from "../support/fakes";
import {
  addStep,
  automationEnv,
  closeTriggerCard,
  conversationFor,
  createAutomation,
  createTag,
  fieldControl,
  getAutomation,
  inboundSettled,
  logsOf,
  saveBuilder,
  sentTo,
  setActive,
  setName,
  setTrigger,
  textsOf,
  waitForLogs,
  waitForText,
} from "../support/automations";

const reply = (text: string) => [{ step_type: "send_message", step_config: { text } }];

test("new_message_received fires on every inbound message; inactive automations never fire", async () => {
  const env = await automationEnv();
  const a = await createAutomation(env.owner, {
    name: "Echo",
    trigger_type: "new_message_received",
    is_active: true,
    steps: reply("echo: {{message.text}}"),
  });
  await createAutomation(env.owner, {
    name: "Paused",
    trigger_type: "new_message_received",
    is_active: false,
    steps: reply("should never send"),
  });
  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "one" });
  await inboundSettled(env, { from: phone, text: "two" });
  await inboundSettled(env, { from: phone, media: { kind: "image", caption: "a photo" } });
  await waitForText(env, phone, "echo: one");
  await waitForText(env, phone, "echo: two");
  const logs = await waitForLogs(env.owner, a.id, (l) => l.status === "success", 3);
  expect(logs.every((l) => l.trigger_event === "new_message_received")).toBe(true);
  expect(textsOf(await sentTo(env, phone))).not.toContain("should never send");
  expect((await getAutomation(env.owner, a.id)).automation.execution_count).toBe(3);

  // Pausing stops it.
  await api(env.owner, "PATCH", `/api/automations/${a.id}`, { is_active: false });
  await inboundSettled(env, { from: phone, text: "three" });
  expect(textsOf(await sentTo(env, phone))).not.toContain("echo: three");
  expect(await logsOf(env.owner, a.id)).toHaveLength(3);
});

test("first_inbound_message fires only on a contact's first message — including manually added contacts", async () => {
  const env = await automationEnv();
  const a = await createAutomation(env.owner, {
    name: "First",
    trigger_type: "first_inbound_message",
    is_active: true,
    steps: reply("first contact!"),
  });
  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "hello" });
  await inboundSettled(env, { from: phone, text: "hello again" });
  await waitForText(env, phone, "first contact!");
  expect(textsOf(await sentTo(env, phone)).filter((t) => t === "first contact!")).toHaveLength(1);

  // A contact created by hand (no messages yet) still counts as "first".
  const manual = randomCustomerPhone();
  const created = await api(env.owner, "POST", "/api/contacts", { name: "Manual Mo", phone: manual });
  expect(created.status).toBe(201);
  await inboundSettled(env, { from: manual, text: "hi, Mo here" });
  await waitForText(env, manual, "first contact!");
  const logs = await waitForLogs(env.owner, a.id, () => true, 2);
  expect(logs).toHaveLength(2);
  expect(logs.map((l) => l.trigger_event)).toEqual(["first_inbound_message", "first_inbound_message"]);
});

test("new_contact_created fires once for a contact auto-created by an inbound message, not for existing contacts", async () => {
  const env = await automationEnv();
  const a = await createAutomation(env.owner, {
    name: "New contact",
    trigger_type: "new_contact_created",
    is_active: true,
    steps: reply("nice to meet you"),
  });
  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, name: "Nina New", text: "first" });
  await inboundSettled(env, { from: phone, text: "second" });
  await waitForText(env, phone, "nice to meet you");
  expect(textsOf(await sentTo(env, phone)).filter((t) => t === "nice to meet you")).toHaveLength(1);

  // A contact that already exists (added by hand) doesn't trigger it on its first message.
  const manual = randomCustomerPhone();
  expect((await api(env.owner, "POST", "/api/contacts", { name: "Manual Max", phone: manual })).status).toBe(201);
  await inboundSettled(env, { from: manual, text: "hello" });
  expect(textsOf(await sentTo(env, manual))).toEqual([]);
  const logs = await logsOf(env.owner, a.id);
  expect(logs).toHaveLength(1);
  expect(logs[0].contact.name).toBe("Nina New");
});

test("new_contact_created for contacts added manually / imported", async () => {
  test.fixme(true, "GAP: new_contact_created only fires for contacts auto-created by inbound WhatsApp messages; contacts added in the UI, imported or created via API never fire it");
  const env = await automationEnv();
  await createAutomation(env.owner, { name: "NC", trigger_type: "new_contact_created", is_active: true, steps: reply("hello new contact") });
  const phone = randomCustomerPhone();
  await api(env.owner, "POST", "/api/contacts", { name: "Manual", phone });
  await fakes.inbound({ from: phone, phone_number_id: env.wa.phoneNumberId, text: "x" });
  await waitForText(env, phone, "hello new contact");
});

test("keyword_match: contains / exact / whole-word, case-insensitive and case-sensitive", async () => {
  const env = await automationEnv();
  const kw = (name: string, keywords: string[], match_type: string, case_sensitive = false) =>
    createAutomation(env.owner, {
      name,
      trigger_type: "keyword_match",
      trigger_config: { keywords, match_type, case_sensitive },
      is_active: true,
      steps: reply(name),
    });
  await kw("contains", ["pricing", "quote"], "contains");
  await kw("contains-cs", ["Promo"], "contains", true);
  await kw("exact", ["help me"], "exact");
  await kw("exact-cs", ["STOP"], "exact", true);
  await kw("word", ["hi", "k"], "word");
  await kw("word-cs", ["Go"], "word", true);

  const cases: Array<[string, string[]]> = [
    ["What's your PRICING?", ["contains"]],
    ["can I get a quote", ["contains"]],
    ["Promo code please", ["contains-cs"]],
    ["promo code please", []],
    ["Help Me", ["exact"]],
    ["help me please", []],
    ["STOP", ["exact-cs"]],
    ["stop", []],
    ["Hi there", ["word"]],
    ["say hi!", ["word"]],
    ["this is thin, thanks", []],
    ["k", ["word"]],
    ["Go now", ["word-cs"]],
    ["go now", []],
    ["Gopher", []],
    ["HI, GO and STOP pricing", ["contains", "word"]],
  ];
  for (const [text, expected] of cases) {
    const phone = randomCustomerPhone();
    await inboundSettled(env, { from: phone, text });
    for (const name of expected) await waitForText(env, phone, name);
    expect(textsOf(await sentTo(env, phone)).sort(), `message ${JSON.stringify(text)}`).toEqual([...expected].sort());
  }
});

test("tag_added (built in the builder) fires when that tag is newly added to a contact", async ({ browser }) => {
  const env = await automationEnv();
  const vip = await createTag(env.owner, "VIP");
  const other = await createTag(env.owner, "Other", "#ef4444");

  const { context, page } = await pageAs(browser, env.owner);
  await page.goto("/automations/new");
  await setName(page, "VIP welcome");
  await setTrigger(page, "Tag Added");
  await expect(page.getByText("When a tag is added to a contact")).toBeVisible();
  await fieldControl(page, "Tag").selectOption({ label: "VIP" });
  await closeTriggerCard(page);
  await addStep(page, "Send Message");
  await page.getByPlaceholder("Hi! Thanks for reaching out…").fill("Welcome to the VIP club");
  await setActive(page, true);
  const id = await saveBuilder(page, "Automation created");
  await context.close();
  expect((await getAutomation(env.owner, id)).automation.trigger_config).toEqual({ tag_id: vip.id });

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "hello" });
  const contactId = (await conversationFor(env.owner, phone))!.contact.id;
  const tag = (tagId: string, method = "POST") => api(env.owner, method, `/api/contacts/${contactId}/tags`, { tag_id: tagId });

  // A different tag: nothing.
  expect((await tag(other.id)).body).toMatchObject({ added: true, dispatched: true });
  expect(await logsOf(env.owner, id)).toHaveLength(0);

  expect((await tag(vip.id)).body).toMatchObject({ added: true, dispatched: true });
  await waitForText(env, phone, "Welcome to the VIP club");
  const [log] = await waitForLogs(env.owner, id);
  expect(log.trigger_event).toBe("tag_added");

  // Re-adding a tag the contact already has is not "added".
  expect((await tag(vip.id)).body).toMatchObject({ added: false, dispatched: false, reason: "duplicate" });
  expect(await logsOf(env.owner, id)).toHaveLength(1);

  // Removed and added again → fires again.
  await tag(vip.id, "DELETE");
  await tag(vip.id);
  await waitForText(env, phone, "Welcome to the VIP club", 2);
  expect(await logsOf(env.owner, id)).toHaveLength(2);
});

test("interactive_reply (built in the builder) fires on matching button / list / template quick-reply ids only", async ({ browser }) => {
  const env = await automationEnv();
  await createAutomation(env.owner, {
    name: "Plans menu",
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["plans"], match_type: "word" },
    is_active: true,
    steps: [
      {
        step_type: "send_buttons",
        step_config: {
          kind: "buttons",
          body: "Which plan?",
          buttons: [
            { id: "plan_basic", title: "Basic" },
            { id: "plan_pro", title: "Pro" },
          ],
        },
      },
    ],
  });

  const { context, page } = await pageAs(browser, env.owner);
  await page.goto("/automations/new");
  await setName(page, "Pro follow-up");
  await setTrigger(page, "Button / List Reply");
  const ids = page.getByPlaceholder("yes, no, more_info");
  await ids.fill("plan_pro,  row_gold ,");
  await ids.press("Enter");
  await expect(ids).toHaveValue("plan_pro, row_gold");
  await closeTriggerCard(page);
  await addStep(page, "Send Message");
  await page.getByPlaceholder("Hi! Thanks for reaching out…").fill("Pro it is: {{message.text}}");
  await setActive(page, true);
  const id = await saveBuilder(page, "Automation created");
  await context.close();
  expect((await getAutomation(env.owner, id)).automation.trigger_config).toEqual({ reply_ids: ["plan_pro", "row_gold"] });

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "show me the plans" });
  const [menu] = await fakes.waitForOutbound(
    { to: phone, phoneNumberId: env.wa.phoneNumberId },
    (m) => m.type === "interactive",
  );
  expect(menu.body.interactive.action.buttons.map((b: { reply: { id: string } }) => b.reply.id)).toEqual(["plan_basic", "plan_pro"]);

  // Tap "Basic" → not in the reply ids.
  await inboundSettled(env, { from: phone, button_reply: { id: "plan_basic", title: "Basic" }, context_id: menu.id });
  expect(textsOf(await sentTo(env, phone))).toEqual([]);
  // Typing the id is not a tap.
  await inboundSettled(env, { from: phone, text: "plan_pro" });
  expect(textsOf(await sentTo(env, phone))).toEqual([]);

  // Tap "Pro".
  await inboundSettled(env, { from: phone, button_reply: { id: "plan_pro", title: "Pro" }, context_id: menu.id });
  await waitForText(env, phone, "Pro it is: Pro");
  // A list row with a matching id.
  await inboundSettled(env, { from: phone, list_reply: { id: "row_gold", title: "Gold tier" } });
  await waitForText(env, phone, "Pro it is: Gold tier");
  // A template quick-reply whose payload matches.
  await inboundSettled(env, { from: phone, button: { text: "Upgrade", payload: "plan_pro" } });
  await waitForText(env, phone, "Pro it is: Upgrade");

  const logs = await waitForLogs(env.owner, id, () => true, 3);
  expect(logs).toHaveLength(3);
  expect(logs.every((l) => l.trigger_event === "interactive_reply")).toBe(true);
});

test("conversation_assigned trigger", async () => {
  test.fixme(true, "GAP: the conversation_assigned trigger is offered in the builder but nothing ever dispatches it");
  const env = await automationEnv();
  await createAutomation(env.owner, { name: "On assign", trigger_type: "conversation_assigned", is_active: true, steps: reply("an agent will help you") });
  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "hi" });
  const conv = await conversationFor(env.owner, phone);
  await api(env.owner, "PATCH", `/api/conversations/${conv!.id}`, { assigned_agent_id: env.owner.userId });
  await waitForText(env, phone, "an agent will help you");
});

test("time_based trigger", async () => {
  test.fixme(true, "GAP: the time_based trigger saves a schedule but no scheduler ever fires it (the cron only resumes waits)");
  const env = await automationEnv();
  const a = await createAutomation(env.owner, {
    name: "Every minute",
    trigger_type: "time_based",
    trigger_config: { schedule: "* * * * *" },
    is_active: true,
    steps: [{ step_type: "send_webhook", step_config: { url: fakes.hookUrl("timebased08") } }],
  });
  await waitForLogs(env.owner, a.id, () => true, 1, 90_000);
});
