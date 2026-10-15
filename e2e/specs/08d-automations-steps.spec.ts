// Automations — action steps built in the builder UI: messaging (text,
// buttons, list, template), tags, contact fields (built-in + custom),
// assignment, deals and closing the conversation.

import { expect, test, type Page } from "@playwright/test";

import { addMember, api, pageAs, syncTemplates, type TestUser } from "../support/accounts";
import { fakes, randomCustomerPhone } from "../support/fakes";
import {
  addStep,
  automationEnv,
  clearToasts,
  closeTriggerCard,
  contactDetail,
  conversationFor,
  createAutomation,
  createTag,
  fieldControl,
  getAutomation,
  inboundSettled,
  saveBuilder,
  sentTo,
  setActive,
  setName,
  setTrigger,
  textsOf,
  waitForLogs,
  waitForText,
  type AutomationEnv,
} from "../support/automations";

test.describe.configure({ mode: "serial" });

let env: AutomationEnv;
let page: Page;
let agnes: TestUser;

test.beforeAll(async ({ browser }) => {
  env = await automationEnv();
  await syncTemplates(env.owner);
  agnes = await addMember(env.owner, "agent", "Agnes Agent");
  ({ page } = await pageAs(browser, env.owner));
});

test.afterAll(async () => {
  await page?.context().close();
});

/** Fresh builder with a keyword trigger. */
async function newKeywordAutomation(name: string, keyword: string) {
  await page.goto("/automations/new");
  await setName(page, name);
  await setTrigger(page, "Keyword Match");
  const kw = page.getByPlaceholder("Comma-separated list (e.g. hello, help, buy)");
  await kw.fill(keyword);
  await kw.press("Enter");
  await fieldControl(page, "Match type").selectOption({ label: "Whole word" });
  await closeTriggerCard(page);
}

test("send message, reply buttons and a list — built in the builder, delivered in order", async () => {
  await newKeywordAutomation("Menus", "menus");

  await addStep(page, "Send Message");
  await page.getByPlaceholder("Hi! Thanks for reaching out…").fill("You wrote: {{ message.text }}");

  await addStep(page, "Send Buttons");
  await page.getByPlaceholder("What the customer reads above the options").fill("Pick a size");
  await page.getByLabel("Show reply IDs (advanced)").check();
  await page.getByPlaceholder("Button label").fill("Small");
  await page.getByPlaceholder("id", { exact: true }).fill("size small");
  await page.getByRole("button", { name: "Add button" }).click();
  await page.getByPlaceholder("Button label").nth(1).fill("Large");
  await expect(page.getByPlaceholder("id", { exact: true }).nth(1)).toHaveValue("btn_2");
  await expect(page.getByText("Buttons (2/3)")).toBeVisible();
  await expect(page.getByRole("button", { name: /Send Buttons\s*Pick a size/ })).toBeVisible();

  await addStep(page, "Send List");
  await page.getByPlaceholder("What the customer reads above the options").fill("Choose a topic");
  await page.locator('xpath=//label[normalize-space(.)="List button label"]/../following-sibling::*[1]').fill("Topics");
  await page.getByPlaceholder("Section title (optional)").fill("Support");
  await page.getByPlaceholder("Row title").fill("Billing");
  await page.getByPlaceholder("Description (optional)").first().fill("Invoices and payments");
  await page.getByRole("button", { name: "Add row" }).click();
  await page.getByPlaceholder("Row title").nth(1).fill("Shipping");
  await expect(page.getByText("Rows (2/10)")).toBeVisible();

  await setActive(page, true);
  const id = await saveBuilder(page, "Automation created");
  const { steps } = await getAutomation(env.owner, id);
  expect(steps.map((s) => s.step_type)).toEqual(["send_message", "send_buttons", "send_list"]);
  expect(steps[1].step_config.buttons).toEqual([
    { id: "size_small", title: "Small" },
    { id: "btn_2", title: "Large" },
  ]);

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "show menus" });
  const out = await fakes.waitForOutbound({ to: phone, phoneNumberId: env.wa.phoneNumberId }, () => true, 3);
  expect(out.map((m) => m.type)).toEqual(["text", "interactive", "interactive"]);
  expect(out[0].body.text.body).toBe("You wrote: show menus");
  expect(out[1].body.interactive).toEqual({
    type: "button",
    body: { text: "Pick a size" },
    action: {
      buttons: [
        { type: "reply", reply: { id: "size_small", title: "Small" } },
        { type: "reply", reply: { id: "btn_2", title: "Large" } },
      ],
    },
  });
  expect(out[2].body.interactive).toMatchObject({
    type: "list",
    body: { text: "Choose a topic" },
    action: {
      button: "Topics",
      sections: [
        {
          title: "Support",
          rows: [
            { id: "row_1", title: "Billing", description: "Invoices and payments" },
            { id: "row_2", title: "Shipping" },
          ],
        },
      ],
    },
  });
  const [log] = await waitForLogs(env.owner, id, (l) => l.status === "success");
  expect(log.steps_executed.map((s: { detail: string }) => s.detail)).toEqual([
    expect.stringMatching(/^sent via Meta \(wamid\./),
    expect.stringMatching(/^interactive sent via Meta/),
    expect.stringMatching(/^interactive sent via Meta/),
  ]);
  // The sends show up in the conversation (as the bot).
  const conv = await conversationFor(env.owner, phone);
  const msgs = await api(env.owner, "GET", `/api/conversations/${conv!.id}/messages`);
  expect(JSON.stringify(msgs.body)).toContain("You wrote: show menus");
});

test("send template picked in the builder (approved templates only)", async () => {
  await newKeywordAutomation("Template send", "appointment");
  await addStep(page, "Send Template");
  const select = fieldControl(page, "Template");
  // (The fake WABA lists every account's submitted templates, so only the fixtures are asserted.)
  await expect(select.locator("option").first()).toHaveText("Select a template…");
  for (const label of ["appointment_confirm (en)", "order_update (en_US)", "promo_image (en_US)"]) {
    await expect(select.locator("option", { hasText: label })).toHaveCount(1);
  }
  await select.selectOption({ label: "appointment_confirm (en)" });
  await expect(page.getByRole("button", { name: /Send Template\s*appointment_confirm/ })).toBeVisible();
  await setActive(page, true);
  const id = await saveBuilder(page, "Automation created");
  expect((await getAutomation(env.owner, id)).steps[0].step_config).toMatchObject({
    template_name: "appointment_confirm",
    language: "en",
  });

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "my appointment" });
  const [tpl] = await fakes.waitForOutbound({ to: phone, phoneNumberId: env.wa.phoneNumberId }, (m) => m.type === "template");
  expect(tpl.body.template).toMatchObject({ name: "appointment_confirm", language: { code: "en" } });
  await waitForLogs(env.owner, id, (l) => l.status === "success");
  // The inbox shows the template's text, not an empty bubble.
  const conv = await conversationFor(env.owner, phone);
  expect(conv!.last_message_text).toBe("Can you make it to your appointment tomorrow?");
});

test("send template with variables fills {{1}}, {{2}} in order (API-built)", async () => {
  const a = await createAutomation(env.owner, {
    name: "Order update",
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["order"], match_type: "word" },
    is_active: true,
    steps: [
      {
        step_type: "send_template",
        step_config: { template_name: "order_update", language: "en_US", variables: { "2": "#1001", "1": "Jane" } },
      },
    ],
  });
  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "where is my order" });
  const [tpl] = await fakes.waitForOutbound({ to: phone, phoneNumberId: env.wa.phoneNumberId }, (m) => m.type === "template");
  expect(tpl.body.template.name).toBe("order_update");
  expect(tpl.body.template.language.code).toBe("en_US");
  const body = tpl.body.template.components.find((c: { type: string }) => c.type === "body");
  expect(body.parameters).toEqual([
    { type: "text", text: "Jane" },
    { type: "text", text: "#1001" },
  ]);
  await waitForLogs(env.owner, a.id, (l) => l.status === "success");
  expect((await conversationFor(env.owner, phone))!.last_message_text).toBe("Hi Jane, your order #1001 has shipped!");
});

test("builder lets you fill a template's variables", async () => {
  await newKeywordAutomation("Template vars", "vars");
  await addStep(page, "Send Template");
  await fieldControl(page, "Template").selectOption({ label: "order_update (en_US)" });
  // One input per body placeholder.
  await expect(page.getByText("Sent as the template's body variables, in order.")).toBeVisible();
  await expect(fieldControl(page, "Variable {{1}}")).toBeVisible();
  await expect(fieldControl(page, "Variable {{2}}")).toBeVisible();
  await expect(page.locator("label", { hasText: /^Variable \{\{\d+\}\}$/ })).toHaveCount(2);

  // Activating with the variables empty is refused.
  await setActive(page, true);
  await clearToasts(page);
  const refused = page.waitForResponse((r) => r.url().endsWith("/api/automations") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save Draft", exact: true }).click();
  const res = await refused;
  expect(res.status()).toBe(400);
  const err = await res.json();
  expect(err.error).toBe("Cannot activate automation with invalid configuration");
  expect(err.issues.map((i: { message: string }) => i.message)).toContain("value for template variable {{1}} is required");
  await expect(page.getByText("value for template variable {{1}} is required").first()).toBeVisible();
  await expect(page).toHaveURL(/\/automations\/new/);

  await fieldControl(page, "Variable {{1}}").fill("Sam");
  await fieldControl(page, "Variable {{2}}").fill("#2002");
  const id = await saveBuilder(page, "Automation created");
  expect((await getAutomation(env.owner, id)).steps[0].step_config).toEqual({
    template_name: "order_update",
    language: "en_US",
    variables: { "1": "Sam", "2": "#2002" },
  });

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "vars please" });
  const [tpl] = await fakes.waitForOutbound({ to: phone, phoneNumberId: env.wa.phoneNumberId }, (m) => m.type === "template");
  const body = tpl.body.template.components.find((c: { type: string }) => c.type === "body");
  expect(body.parameters).toEqual([
    { type: "text", text: "Sam" },
    { type: "text", text: "#2002" },
  ]);
  await waitForLogs(env.owner, id, (l) => l.status === "success");
});

test("add tag, remove tag, update built-in and custom fields; add_tag chains into tag_added", async () => {
  const lead = await createTag(env.owner, "Lead");
  const cold = await createTag(env.owner, "Cold", "#64748b");
  const plan = await api(env.owner, "POST", "/api/custom-fields", { field_name: "Plan" });
  expect(plan.status).toBe(201);
  const chained = await createAutomation(env.owner, {
    name: "On Lead",
    trigger_type: "tag_added",
    trigger_config: { tag_id: lead.id },
    is_active: true,
    steps: [{ step_type: "send_message", step_config: { text: "You're now a lead" } }],
  });

  await newKeywordAutomation("Profile", "profile");
  await addStep(page, "Add Tag");
  await fieldControl(page, "Tag").selectOption({ label: "Lead" });
  await addStep(page, "Remove Tag");
  await fieldControl(page, "Tag").selectOption({ label: "Cold" });
  const fields: Array<[string, string]> = [
    ["Name", "Profiled {{message.text}}"],
    ["Email", "profiled@example.com"],
    ["Company", "Acme"],
    ["Plan", "Gold"],
  ];
  for (const [field, value] of fields) {
    await addStep(page, "Update Contact Field");
    await expect(fieldControl(page, "Value")).toHaveAttribute("placeholder", "Text or {{ vars.x }} / {{ message.text }}");
    await fieldControl(page, "Field").selectOption({ label: field });
    await fieldControl(page, "Value").fill(value);
  }
  await setActive(page, true);
  const id = await saveBuilder(page, "Automation created");
  const { steps } = await getAutomation(env.owner, id);
  expect(steps.map((s) => s.step_config)).toEqual([
    { tag_id: lead.id },
    { tag_id: cold.id },
    { field: "name", value: "Profiled {{message.text}}" },
    { field: "email", value: "profiled@example.com" },
    { field: "company", value: "Acme" },
    { field: `custom:${plan.body.field.id}`, value: "Gold" },
  ]);

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, name: "Pat Profile", text: "hello" });
  const contactId = (await conversationFor(env.owner, phone))!.contact.id;
  await api(env.owner, "POST", `/api/contacts/${contactId}/tags`, { tag_id: cold.id });
  expect((await contactDetail(env.owner, contactId)).tag_ids).toEqual([cold.id]);

  await inboundSettled(env, { from: phone, text: "profile" });
  const [log] = await waitForLogs(env.owner, id, (l) => l.status === "success");
  expect(log.steps_executed.map((s: { detail: string }) => s.detail)).toEqual([
    `tag ${lead.id} added and tag_added dispatched`,
    `tag ${cold.id} removed`,
    "name updated",
    "email updated",
    "company updated",
    "custom field updated",
  ]);
  const detail = await contactDetail(env.owner, contactId);
  expect(detail.contact).toMatchObject({ name: "Profiled profile", email: "profiled@example.com", company: "Acme" });
  expect(detail.tag_ids).toEqual([lead.id]);
  expect(detail.custom_values).toEqual([expect.objectContaining({ custom_field_id: plan.body.field.id, value: "Gold" })]);
  await waitForText(env, phone, "You're now a lead");
  await waitForLogs(env.owner, chained.id, (l) => l.trigger_event === "tag_added");

  // Running again overwrites the custom value and doesn't re-add the tag.
  await inboundSettled(env, { from: phone, text: "profile" });
  const logs = await waitForLogs(env.owner, id, (l) => l.status === "success", 2);
  expect(logs[0].steps_executed[0].detail).toBe(`tag ${lead.id} already present`);
  expect((await contactDetail(env.owner, contactId)).custom_values).toHaveLength(1);
  expect(textsOf(await sentTo(env, phone)).filter((t) => t === "You're now a lead")).toHaveLength(1);
});

test("assign the conversation to a specific agent picked by name", async () => {
  await newKeywordAutomation("Assign Agnes", "agnes");
  await addStep(page, "Assign Conversation");
  await expect(fieldControl(page, "Mode")).toHaveValue("round_robin");
  await fieldControl(page, "Mode").selectOption({ label: "Specific agent" });
  await fieldControl(page, "Agent").selectOption({ label: "Agnes Agent" });
  await setActive(page, true);
  const id = await saveBuilder(page, "Automation created");
  expect((await getAutomation(env.owner, id)).steps[0].step_config).toEqual({ mode: "specific", agent_id: agnes.userId });

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "I want agnes" });
  const [log] = await waitForLogs(env.owner, id, (l) => l.status === "success");
  expect(log.steps_executed[0].detail).toBe(`assigned to ${agnes.userId}`);
  expect((await conversationFor(env.owner, phone))!.assigned_agent_id).toBe(agnes.userId);
});

test("round-robin assignment spreads conversations across agents", async () => {
  const bruno = await addMember(env.owner, "agent", "Bruno Agent");
  const a = await createAutomation(env.owner, {
    name: "RR",
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["roundrobin"], match_type: "word" },
    is_active: true,
    steps: [{ step_type: "assign_conversation", step_config: { mode: "round_robin" } }],
  });
  const assignees: string[] = [];
  for (let i = 0; i < 4; i++) {
    const phone = randomCustomerPhone();
    await inboundSettled(env, { from: phone, text: "roundrobin" });
    await waitForLogs(env.owner, a.id, () => true, i + 1);
    assignees.push((await conversationFor(env.owner, phone))!.assigned_agent_id);
  }
  // Owner, admins and agents take turns in user_id order, wrapping around.
  const rotation = [env.owner.userId, agnes.userId, bruno.userId].sort();
  expect(assignees).toEqual([...rotation, rotation[0]]);
  // The cursor lives in the step's own config.
  expect((await getAutomation(env.owner, a.id)).steps[0].step_config).toEqual({
    mode: "round_robin",
    round_robin_last_user_id: rotation[0],
  });
});

test("create a deal (pipeline + stage picked by name) and close the conversation", async () => {
  const pipe = await api(env.owner, "POST", "/api/pipelines", {
    name: "Sales",
    stages: [
      { name: "New", color: "#3b82f6", position: 0 },
      { name: "Qualified", color: "#22c55e", position: 1 },
    ],
  });
  expect(pipe.status).toBe(201);
  const pipelineId = pipe.body.pipeline.id;

  await newKeywordAutomation("Deal + close", "deal");
  await addStep(page, "Create Deal");
  await expect(fieldControl(page, "Stage")).toBeDisabled();
  await fieldControl(page, "Pipeline").selectOption({ label: "Sales" });
  // Picking a pipeline preselects its first stage.
  await expect(fieldControl(page, "Stage").locator("option:checked")).toHaveText("New");
  await fieldControl(page, "Stage").selectOption({ label: "Qualified" });
  await fieldControl(page, "Title").fill("Deal: {{message.text}}");
  await fieldControl(page, "Value").fill("250");
  await addStep(page, "Close Conversation");
  await setActive(page, true);
  const id = await saveBuilder(page, "Automation created");
  const res = await api(env.owner, "GET", "/api/automations/resources");
  const qualified = res.body.stages.find((s: { name: string; pipeline_id: string }) => s.name === "Qualified" && s.pipeline_id === pipelineId);
  expect((await getAutomation(env.owner, id)).steps[0].step_config).toEqual({
    pipeline_id: pipelineId,
    stage_id: qualified.id,
    title: "Deal: {{message.text}}",
    value: 250,
  });

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "big deal" });
  const [log] = await waitForLogs(env.owner, id, (l) => l.status === "success");
  expect(log.steps_executed.map((s: { detail: string }) => s.detail)).toEqual(["deal created", "conversation closed"]);
  const conv = await conversationFor(env.owner, phone);
  expect(conv!.status).toBe("closed");
  const deals = await api(env.owner, "GET", `/api/deals?pipelineId=${pipelineId}`);
  expect(deals.body.deals).toHaveLength(1);
  expect(deals.body.deals[0]).toMatchObject({
    title: "Deal: big deal",
    stage_id: qualified.id,
    contact_id: conv!.contact.id,
    status: "open",
    currency: "USD",
  });
  expect(Number(deals.body.deals[0].value)).toBe(250);

  // The customer writing again re-opens it.
  await inboundSettled(env, { from: phone, text: "one more thing" });
  expect((await conversationFor(env.owner, phone))!.status).toBe("open");
});
