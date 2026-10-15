// Automations — the four quick-start templates: each is created from its
// card on the list page, activated in the builder, and proven to run.

import { expect, test, type Page } from "@playwright/test";

import { api, pageAs, runCron } from "../support/accounts";
import { randomCustomerPhone } from "../support/fakes";
import {
  automationEnv,
  conditionDetail,
  backdatePending,
  conversationFor,
  contactDetail,
  createTag,
  expandStep,
  fieldControl,
  getAutomation,
  inboundSettled,
  pendingStatuses,
  saveBuilder,
  sentTo,
  setActive,
  textsOf,
  waitForLogs,
  waitForText,
  type AutomationEnv,
} from "../support/automations";

test.describe.configure({ mode: "serial" });

const TEXT = {
  welcome: "Hi! 👋 Thanks for reaching out. We'll get back to you shortly.",
  ooo: "Thanks for your message! Our team is offline right now (9am–6pm) and will reply first thing tomorrow.",
  lead: "Great — happy to help with pricing! Quick question: roughly how many seats are you looking for?",
  followUp: "Just circling back — did you have any other questions for us? Happy to help!",
};

let env: AutomationEnv;
let page: Page;

test.beforeAll(async ({ browser }) => {
  env = await automationEnv();
  ({ page } = await pageAs(browser, env.owner));
});

test.afterAll(async () => {
  await page?.context().close();
});

/** Click a quick-start card and land in the prefilled builder. */
async function startFromTemplate(name: string, slug: string) {
  await page.goto("/automations");
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await page.waitForURL(new RegExp(`/automations/new\\?template=${slug}$`));
  await expect(page.getByPlaceholder("Untitled automation")).toHaveValue(name);
}

async function removeAutomation(id: string) {
  expect((await api(env.owner, "DELETE", `/api/automations/${id}`)).status).toBe(200);
}

test("Welcome Message: first-message greeting + tag, once per contact", async () => {
  const tag = await createTag(env.owner, "Welcomed");
  await startFromTemplate("Welcome Message", "welcome_message");
  await expect(page.getByRole("button", { name: /^Trigger\s*First Message from Contact/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Send Message\s*Hi! 👋 Thanks for reaching out/ })).toBeVisible();

  // The template's Add Tag step ships without a tag, so activation is refused until one is picked.
  await setActive(page, true);
  await page.getByRole("button", { name: "Save Draft" }).click();
  await expect(page.getByText("tag is required")).toBeVisible();
  await expect(page.getByText("at steps[1].tag_id")).toBeVisible();

  await expandStep(page, "Add Tag");
  await fieldControl(page, "Tag").selectOption({ label: "Welcomed" });
  const id = await saveBuilder(page, "Automation created");
  const saved = await getAutomation(env.owner, id);
  expect(saved.automation).toMatchObject({ name: "Welcome Message", trigger_type: "first_inbound_message", is_active: true });
  expect(saved.steps.map((s) => s.step_type)).toEqual(["send_message", "add_tag"]);
  expect(saved.steps[1].step_config.tag_id).toBe(tag.id);

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "Hello!" });
  await waitForText(env, phone, TEXT.welcome);
  const conv = await conversationFor(env.owner, phone);
  expect((await contactDetail(env.owner, conv!.contact.id)).tag_ids).toContain(tag.id);

  await inboundSettled(env, { from: phone, text: "Anyone there?" });
  expect(textsOf(await sentTo(env, phone)).filter((t) => t === TEXT.welcome)).toHaveLength(1);
  await removeAutomation(id);
});

test("Out of Office: replies only inside its off-hours window (both branches)", async () => {
  await startFromTemplate("Out of Office", "out_of_office");
  await expect(page.getByRole("button", { name: /^Trigger\s*New Message Received/ })).toBeVisible();
  await expandStep(page, "Condition (If/Else)");
  await expect(fieldControl(page, "Subject")).toHaveValue("time_of_day");
  await expect(fieldControl(page, "Operand")).toHaveValue("18:00-09:00");
  await expect(page.getByRole("button", { name: /Send Message\s*Thanks for your message! Our team is offline/ })).toBeVisible();
  await setActive(page, true);
  const id = await saveBuilder(page, "Automation created");

  // The app container runs in UTC; the window is 18:00–09:00.
  const offHours = (d: Date) => d.getUTCHours() >= 18 || d.getUTCHours() < 9;
  const before = offHours(new Date());
  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "hello?" });
  const [log] = await waitForLogs(env.owner, id);
  if (before === offHours(new Date())) {
    expect(conditionDetail(log)).toBe(`branch=${before ? "yes" : "no"}`);
    expect(textsOf(await sentTo(env, phone)).includes(TEXT.ooo)).toBe(before);
  }

  // Edit the window so "now" is inside it → the Yes branch replies.
  const h = new Date().getUTCHours();
  const pad = (n: number) => String((n + 24) % 24).padStart(2, "0");
  await expandStep(page, "Condition (If/Else)");
  await fieldControl(page, "Operand").fill(`${pad(h - 1)}:00-${pad(h + 2)}:00`);
  await saveBuilder(page, "Automation saved");
  const phone2 = randomCustomerPhone();
  await inboundSettled(env, { from: phone2, text: "hello again" });
  await waitForText(env, phone2, TEXT.ooo);

  // ...and a window that excludes "now" → the No branch stays silent.
  await expandStep(page, "Condition (If/Else)");
  await fieldControl(page, "Operand").fill(`${pad(h + 3)}:00-${pad(h + 4)}:00`);
  await saveBuilder(page, "Automation saved");
  const phone3 = randomCustomerPhone();
  await inboundSettled(env, { from: phone3, text: "third" });
  const logs = await waitForLogs(env.owner, id, () => true, 3);
  expect(conditionDetail(logs[0])).toBe("branch=no");
  expect(textsOf(await sentTo(env, phone3))).not.toContain(TEXT.ooo);
  await removeAutomation(id);
});

test("Lead Qualifier: keyword → question, wait 10 min, then assignment", async () => {
  await startFromTemplate("Lead Qualifier", "lead_qualifier");
  await page.getByRole("button", { name: /^Trigger\s*Keyword Match/ }).click();
  await expect(page.getByPlaceholder("Comma-separated list (e.g. hello, help, buy)")).toHaveValue("pricing, quote, buy");
  await expect(fieldControl(page, "Match type")).toHaveValue("contains");
  await expect(page.getByRole("button", { name: /Wait\s*Wait\s*10 minutes/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Action\s*Assign Conversation/ })).toBeVisible();
  await setActive(page, true);
  const id = await saveBuilder(page, "Automation created");
  expect((await getAutomation(env.owner, id)).automation.trigger_config).toEqual({
    keywords: ["pricing", "quote", "buy"],
    match_type: "contains",
  });

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "Can I get a QUOTE please" });
  await waitForText(env, phone, TEXT.lead);
  await waitForLogs(env.owner, id, (l) => l.status === "partial");
  expect(pendingStatuses(id)).toEqual(["pending"]);
  expect((await conversationFor(env.owner, phone))!.assigned_agent_id).toBeNull();

  backdatePending(id);
  await runCron();
  await waitForLogs(env.owner, id, (l) => l.status === "success");
  expect(pendingStatuses(id)).toEqual(["done"]);
  // Round-robin over a one-member account → the owner.
  expect((await conversationFor(env.owner, phone))!.assigned_agent_id).toBe(env.owner.userId);

  // A non-matching message does nothing.
  const other = randomCustomerPhone();
  await inboundSettled(env, { from: other, text: "just saying hi" });
  expect(textsOf(await sentTo(env, other))).toEqual([]);
  await removeAutomation(id);
});

test("Follow-up Reminder: nudges a day later (resumed by the cron)", async () => {
  await startFromTemplate("Follow-up Reminder", "follow_up_reminder");
  await expect(page.getByRole("button", { name: /Wait\s*Wait\s*1 days/ })).toBeVisible();
  await setActive(page, true);
  const id = await saveBuilder(page, "Automation created");

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "I'll think about it" });
  await waitForLogs(env.owner, id, (l) => l.status === "partial");
  // Not due yet: the cron leaves it parked.
  await runCron();
  expect(pendingStatuses(id)).toEqual(["pending"]);
  expect(textsOf(await sentTo(env, phone))).not.toContain(TEXT.followUp);

  backdatePending(id);
  await runCron();
  await waitForText(env, phone, TEXT.followUp);
  const [log] = await waitForLogs(env.owner, id, (l) => l.status === "success");
  expect(log.steps_executed.map((s: { step_type: string }) => s.step_type)).toEqual(["wait", "send_message"]);
  await removeAutomation(id);
});
