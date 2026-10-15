// Automations — flow control: If/Else conditions (every kind, both
// branches), send_webhook, wait (resumed by the cron) and wait-for-reply
// (resumed by the customer's reply, or expired by the cron).

import { expect, test, type Page } from "@playwright/test";

import { api, pageAs, runCron } from "../support/accounts";
import { fakes, randomCustomerPhone } from "../support/fakes";
import {
  addStep,
  automationEnv,
  conditionDetail,
  backdatePending,
  branch,
  closeTriggerCard,
  conversationFor,
  createAutomation,
  createTag,
  expandStep,
  fieldControl,
  getAutomation,
  inboundSettled,
  logsOf,
  pendingStatuses,
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

test.beforeAll(async ({ browser }) => {
  env = await automationEnv();
  ({ page } = await pageAs(browser, env.owner));
});

test.afterAll(async () => {
  await page?.context().close();
});

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

const say = (text: string) => ({ step_type: "send_message", step_config: { text } });

/** An If/Else automation (API-built) whose branches each send a marker text. */
function conditionAutomation(keyword: string, step_config: Record<string, unknown>) {
  return createAutomation(env.owner, {
    name: `cond ${keyword}`,
    trigger_type: "keyword_match",
    trigger_config: { keywords: [keyword], match_type: "word" },
    is_active: true,
    steps: [
      {
        step_type: "condition",
        step_config,
        branches: { yes: [say(`${keyword}: yes`)], no: [say(`${keyword}: no`)] },
      },
      say(`${keyword}: after`),
    ],
  });
}

/** Fire `text` from `phone` and assert which branch ran (plus the step after the condition). */
async function expectBranch(phone: string, text: string, keyword: string, taken: "yes" | "no") {
  const sent = textsOf(await sentTo(env, phone));
  const before = sent.length;
  const afters = sent.filter((t) => t === `${keyword}: after`).length;
  await inboundSettled(env, { from: phone, text });
  await waitForText(env, phone, `${keyword}: after`, afters + 1);
  const texts = textsOf(await sentTo(env, phone)).slice(before);
  expect(texts).toEqual([`${keyword}: ${taken}`, `${keyword}: after`]);
}

test("condition on message content, built in the builder: Yes and No branches", async () => {
  await newKeywordAutomation("Triage", "triage");
  await addStep(page, "Condition (If/Else)");
  await expect(fieldControl(page, "Subject")).toHaveValue("tag_presence");
  await expect(fieldControl(page, "Operand")).toHaveAttribute("placeholder", "tag id");
  await fieldControl(page, "Subject").selectOption({ label: "Message content" });
  // Message content only needs a value: the Operand input goes away.
  await expect(page.locator("label", { hasText: /^Operand$/ })).toHaveCount(0);
  await fieldControl(page, "Value").fill("URGENT");
  await expect(page.getByRole("button", { name: /Condition \(If\/Else\)\s*when message_content/ })).toBeVisible();

  await addStep(page, "Send Message", branch(page, "Yes").getByRole("button", { name: "Add step" }).first());
  await page.getByPlaceholder("Hi! Thanks for reaching out…").fill("Escalating right away");
  await addStep(page, "Add Tag", branch(page, "No").getByRole("button", { name: "Add step" }).first());
  await addStep(page, "Send Message", branch(page, "No").getByRole("button", { name: "Add step" }).first());
  await page.getByPlaceholder("Hi! Thanks for reaching out…").fill("We'll get back to you");
  await expandStep(page, "Add Tag");
  // No tags exist → the picker falls back to a raw id input; delete the step again.
  await expect(page.getByPlaceholder("Tag id")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();

  await setActive(page, true);
  const id = await saveBuilder(page, "Automation created");
  const { steps } = await getAutomation(env.owner, id);
  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatchObject({
    step_type: "condition",
    step_config: { subject: "message_content", operand: "", value: "URGENT" },
    branches: {
      yes: [{ step_type: "send_message", step_config: { text: "Escalating right away" } }],
      no: [{ step_type: "send_message", step_config: { text: "We'll get back to you" } }],
    },
  });

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "triage: this is urgent!!" });
  await waitForText(env, phone, "Escalating right away");
  await inboundSettled(env, { from: phone, text: "triage when you can" });
  await waitForText(env, phone, "We'll get back to you");
  expect(textsOf(await sentTo(env, phone))).toEqual(["Escalating right away", "We'll get back to you"]);
  const logs = await waitForLogs(env.owner, id, (l) => l.status === "success", 2);
  expect(logs.map((l) => conditionDetail(l))).toEqual(["branch=no", "branch=yes"]);
  expect(logs[1].steps_executed).toHaveLength(2);
});

test("run logs list steps in execution order (condition before its branch)", async () => {
  const logs = await logsOf(env.owner, (await api(env.owner, "GET", "/api/automations")).body.automations.find((a: { name: string }) => a.name === "Triage").id);
  const yes = logs.find((l) => conditionDetail(l) === "branch=yes")!;
  expect(yes.steps_executed.map((s: { step_type: string }) => s.step_type)).toEqual(["condition", "send_message"]);
});

test("message-content condition can be activated without an operand", async () => {
  const r = await api(env.owner, "POST", "/api/automations", {
    name: "mc no operand",
    trigger_type: "new_message_received",
    is_active: true,
    steps: [{ step_type: "condition", step_config: { subject: "message_content", operand: "", value: "urgent" }, branches: { yes: [say("u")], no: [] } }],
  });
  expect(r.status).toBe(201);
});

test("condition on tag presence: Yes and No branches, then the step after the condition", async () => {
  const vip = await createTag(env.owner, "VIP");
  await conditionAutomation("tagcheck", { subject: "tag_presence", operand: vip.id });
  const phone = randomCustomerPhone();
  await expectBranch(phone, "tagcheck", "tagcheck", "no");
  const contactId = (await conversationFor(env.owner, phone))!.contact.id;
  await api(env.owner, "POST", `/api/contacts/${contactId}/tags`, { tag_id: vip.id });
  await expectBranch(phone, "tagcheck again", "tagcheck", "yes");
});

test("condition on a contact field: Yes and No branches", async () => {
  await conditionAutomation("fieldcheck", { subject: "contact_field", operand: "company", value: "Acme" });
  const phone = randomCustomerPhone();
  await expectBranch(phone, "fieldcheck", "fieldcheck", "no");
  const contactId = (await conversationFor(env.owner, phone))!.contact.id;
  await api(env.owner, "PATCH", `/api/contacts/${contactId}`, { company: "Acme" });
  await expectBranch(phone, "fieldcheck now", "fieldcheck", "yes");
});

test("condition on time of day: Yes inside the window, No outside (incl. over-midnight windows)", async () => {
  const h = new Date().getUTCHours(); // the app runs in UTC
  const pad = (n: number) => String((n + 24) % 24).padStart(2, "0");
  // Window wrapping over midnight that contains now: (h+20) → (h+2), i.e. 4h before to 2h after.
  await conditionAutomation("timein", { subject: "time_of_day", operand: `${pad(h + 20)}:00-${pad(h + 2)}:00` });
  await conditionAutomation("timeout", { subject: "time_of_day", operand: `${pad(h + 3)}:00-${pad(h + 5)}:00` });
  const phone = randomCustomerPhone();
  await expectBranch(phone, "timein", "timein", "yes");
  await expectBranch(phone, "timeout", "timeout", "no");
});

test("a failing step inside a condition branch marks the run failed", async () => {
  const a = await createAutomation(env.owner, {
    name: "nested failure",
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["nestedfail"], match_type: "word" },
    is_active: true,
    steps: [
      {
        step_type: "condition",
        step_config: { subject: "message_content", operand: "x", value: "nestedfail" },
        branches: { yes: [{ step_type: "send_webhook", step_config: { url: "http://127.0.0.1:9/x" } }], no: [] },
      },
    ],
  });
  await inboundSettled(env, { from: randomCustomerPhone(), text: "nestedfail" });
  const [log] = await waitForLogs(env.owner, a.id);
  expect(log.error_message).toBe("send_webhook: destination not allowed");
  expect(log.status).toBe("failed");
});

test("send webhook built in the builder: posts the body template to the URL", async () => {
  const hook = `wh08${Date.now().toString(36)}`;
  // A secret on the receiver doesn't matter: automation webhooks are not signed.
  await fakes.setHookSecret(hook, "not-used-by-automations");
  await newKeywordAutomation("Webhook", "hook");
  await addStep(page, "Send Webhook");
  await fieldControl(page, "URL").fill(fakes.hookUrl(hook));
  await fieldControl(page, "Body template").fill('{"said": "{{message.text}}", "source": "wacrm", "missing": "{{vars.nope}}"}');
  await expect(page.getByRole("button", { name: new RegExp(`Send Webhook\\s*http://fakes:4010/__hooks/${hook}`) })).toBeVisible();
  await setActive(page, true);
  const id = await saveBuilder(page, "Automation created");

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "hook me up" });
  const [delivery] = await fakes.waitForHooks(hook, () => true);
  expect(delivery.body).toEqual({ said: "hook me up", source: "wacrm", missing: "" });
  expect(delivery.headers["content-type"]).toBe("application/json");
  expect(delivery.headers["x-wacrm-signature"]).toBeUndefined();
  expect(delivery.signatureValid).toBeNull();
  const [log] = await waitForLogs(env.owner, id, (l) => l.status === "success");
  expect(log.steps_executed[0].detail).toBe("webhook 200");
});

test("send webhook (API-built): default body is the run context, custom headers are sent, non-2xx fails the run", async () => {
  const hook = `wh08b${Date.now().toString(36)}`;
  const ok = await createAutomation(env.owner, {
    name: "Webhook default body",
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["ctxhook"], match_type: "word" },
    is_active: true,
    steps: [{ step_type: "send_webhook", step_config: { url: fakes.hookUrl(hook), headers: { "x-e2e-token": "abc123" } } }],
  });
  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "ctxhook" });
  const [delivery] = await fakes.waitForHooks(hook, () => true);
  const conv = await conversationFor(env.owner, phone);
  expect(delivery.body).toMatchObject({ message_text: "ctxhook", conversation_id: conv!.id });
  expect(delivery.headers["x-e2e-token"]).toBe("abc123");
  await waitForLogs(env.owner, ok.id, (l) => l.status === "success");

  const bad = await createAutomation(env.owner, {
    name: "Webhook 404",
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["badhook"], match_type: "word" },
    is_active: true,
    // The fake answers 404 for POSTs to /__hooks/<name>/secret.
    steps: [{ step_type: "send_webhook", step_config: { url: `${fakes.hookUrl(hook)}/secret` } }, say("not reached")],
  });
  await inboundSettled(env, { from: phone, text: "badhook" });
  const [log] = await waitForLogs(env.owner, bad.id, (l) => l.status === "failed");
  expect(log.error_message).toBe("webhook returned 404");
  expect(textsOf(await sentTo(env, phone))).not.toContain("not reached");
});

test("wait, built in the builder: parks the run until the cron resumes it when due", async () => {
  await newKeywordAutomation("Drip", "drip");
  await addStep(page, "Send Message");
  await page.getByPlaceholder("Hi! Thanks for reaching out…").fill("Step one");
  await addStep(page, "Wait");
  await fieldControl(page, "Amount").fill("5");
  await fieldControl(page, "Unit").selectOption({ label: "Minutes" });
  await addStep(page, "Send Message");
  await page.getByPlaceholder("Hi! Thanks for reaching out…").fill("Step two after {{message.text}}");
  await setActive(page, true);
  const id = await saveBuilder(page, "Automation created");
  expect((await getAutomation(env.owner, id)).steps[1].step_config).toEqual({ amount: 5, unit: "minutes" });

  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "drip" });
  await waitForText(env, phone, "Step one");
  const [parked] = await waitForLogs(env.owner, id, (l) => l.status === "partial");
  expect(parked.steps_executed.map((s: { detail: string }) => s.detail)).toEqual([
    expect.stringMatching(/^sent via Meta/),
    "waiting 5 minutes",
  ]);
  // Not due yet.
  await runCron();
  expect(pendingStatuses(id)).toEqual(["pending"]);
  expect(textsOf(await sentTo(env, phone))).toEqual(["Step one"]);

  backdatePending(id);
  await runCron();
  await waitForText(env, phone, "Step two after drip");
  const [done] = await waitForLogs(env.owner, id, (l) => l.status === "success");
  expect(done.steps_executed.map((s: { step_type: string }) => s.step_type)).toEqual(["send_message", "wait", "send_message"]);
  expect(pendingStatuses(id)).toEqual(["done"]);
  // Resuming doesn't count as a second run.
  expect((await getAutomation(env.owner, id)).automation.execution_count).toBe(1);
});

test("a wait inside a condition branch resumes the branch, then the steps after the condition", async () => {
  const a = await createAutomation(env.owner, {
    name: "Branch wait",
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["branchwait"], match_type: "word" },
    is_active: true,
    steps: [
      {
        step_type: "condition",
        step_config: { subject: "message_content", operand: "x", value: "branchwait" },
        branches: { yes: [{ step_type: "wait", step_config: { amount: 1, unit: "hours" } }, say("in branch")], no: [say("wrong branch")] },
      },
      say("after condition"),
    ],
  });
  const phone = randomCustomerPhone();
  await inboundSettled(env, { from: phone, text: "branchwait" });
  await waitForLogs(env.owner, a.id, (l) => l.status === "partial");
  expect(textsOf(await sentTo(env, phone))).toEqual([]);
  backdatePending(a.id);
  await runCron();
  await waitForText(env, phone, "after condition");
  expect(textsOf(await sentTo(env, phone))).toEqual(["in branch", "after condition"]);
  await waitForLogs(env.owner, a.id, (l) => l.status === "success");
});

test.describe("wait for reply", () => {
  let surveyId: string;
  let keywordYesId: string;

  test.beforeAll(async () => {
    // Fires on any message containing "yes" — must NOT fire for a reply consumed by a waiting run.
    keywordYesId = (
      await createAutomation(env.owner, {
        name: "yes listener",
        trigger_type: "keyword_match",
        trigger_config: { keywords: ["yes"], match_type: "word" },
        is_active: true,
        steps: [say("keyword yes fired")],
      })
    ).id;
  });

  test("buttons with 'wait for reply' (builder): a tap resumes the run on the reply's branch", async () => {
    await newKeywordAutomation("Survey", "survey");
    await addStep(page, "Send Buttons");
    await page.getByPlaceholder("What the customer reads above the options").fill("Happy with us?");
    await page.getByPlaceholder("Button label").fill("Yes");
    await page.getByRole("button", { name: "Add button" }).click();
    await page.getByPlaceholder("Button label").nth(1).fill("No");
    await page.getByLabel(/Wait for reply before continuing/).check();
    await expect(page.getByRole("button", { name: /Send Buttons\s*Happy with us\? · waits for reply/ })).toBeVisible();
    await addStep(page, "Condition (If/Else)");
    await fieldControl(page, "Subject").selectOption({ label: "Message content" });
    await fieldControl(page, "Value").fill("yes");
    await addStep(page, "Send Message", branch(page, "Yes").getByRole("button", { name: "Add step" }).first());
    await page.getByPlaceholder("Hi! Thanks for reaching out…").fill("Glad to hear: {{message.text}}");
    await addStep(page, "Send Message", branch(page, "No").getByRole("button", { name: "Add step" }).first());
    await page.getByPlaceholder("Hi! Thanks for reaching out…").fill("Sorry to hear: {{message.text}}");
    await setActive(page, true);
    surveyId = await saveBuilder(page, "Automation created");
    expect((await getAutomation(env.owner, surveyId)).steps[0].step_config.wait_for_reply).toBe(true);

    const phone = randomCustomerPhone();
    await inboundSettled(env, { from: phone, text: "survey" });
    const [menu] = await fakes.waitForOutbound({ to: phone, phoneNumberId: env.wa.phoneNumberId }, (m) => m.type === "interactive");
    const [parked] = await waitForLogs(env.owner, surveyId, (l) => l.status === "partial");
    expect(parked.steps_executed[0].detail).toMatch(/; waiting for reply$/);
    expect(pendingStatuses(surveyId)).toEqual(["awaiting_reply"]);

    await inboundSettled(env, { from: phone, button_reply: { id: "btn_1", title: "Yes" }, context_id: menu.id });
    await waitForText(env, phone, "Glad to hear: Yes");
    const [done] = await waitForLogs(env.owner, surveyId, (l) => l.status === "success");
    expect(done.steps_executed.map((s: { step_type: string }) => s.step_type)).toEqual(["send_buttons", "condition", "send_message"]);
    expect(done.steps_executed[0].detail).toMatch(/waiting for reply$/);
    expect(conditionDetail(done)).toBe("branch=yes");
    expect(done.steps_executed.map((s: { detail: string }) => s.detail)).toContainEqual(expect.stringMatching(/^sent via Meta/));
    expect(pendingStatuses(surveyId)).toEqual(["done"]);
    // The consumed reply did not also fire content triggers.
    expect(textsOf(await sentTo(env, phone))).toEqual(["Glad to hear: Yes"]);
    expect(await logsOf(env.owner, keywordYesId)).toHaveLength(0);

    // A typed reply works too, and takes the other branch.
    await inboundSettled(env, { from: phone, text: "survey" });
    await waitForLogs(env.owner, surveyId, (l) => l.status === "partial");
    await inboundSettled(env, { from: phone, text: "meh, not really" });
    await waitForText(env, phone, "Sorry to hear: meh, not really");
  });

  test("a second message while waiting is the reply; a newer menu supersedes an older waiting one", async () => {
    // While a run waits, the customer's next message is consumed as its reply.
    const phone = randomCustomerPhone();
    await inboundSettled(env, { from: phone, text: "survey" });
    await inboundSettled(env, { from: phone, text: "survey" });
    await waitForText(env, phone, "Sorry to hear: survey");

    // Two menus parked by the same message: only the newest survives.
    const menu = (name: string) =>
      createAutomation(env.owner, {
        name,
        trigger_type: "keyword_match",
        trigger_config: { keywords: ["double"], match_type: "word" },
        is_active: true,
        steps: [
          {
            step_type: "send_buttons",
            step_config: { kind: "buttons", body: `${name}?`, buttons: [{ id: "ok", title: "OK" }], wait_for_reply: true },
          },
          say(`${name} got {{message.text}}`),
        ],
      });
    const [a, b] = await Promise.all([menu("Menu A"), menu("Menu B")]);
    const phone2 = randomCustomerPhone();
    await inboundSettled(env, { from: phone2, text: "double" });
    const statuses = () => [...pendingStatuses(a.id), ...pendingStatuses(b.id)].sort();
    expect(statuses()).toEqual(["awaiting_reply", "superseded"]);
    await inboundSettled(env, { from: phone2, button_reply: { id: "ok", title: "OK" } });
    await expect.poll(statuses).toEqual(["done", "superseded"]);
    const texts = textsOf(await sentTo(env, phone2));
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/^Menu [AB] got OK$/);
    for (const x of [a, b]) await api(env.owner, "DELETE", `/api/automations/${x.id}`);
  });

  test("no reply within 24h: the cron expires the wait and a late reply goes to the normal triggers", async () => {
    const phone = randomCustomerPhone();
    await inboundSettled(env, { from: phone, text: "survey" });
    await waitForLogs(env.owner, surveyId, (l) => l.status === "partial" && l.contact.phone === phone.replace(/\D/g, ""));
    const before = pendingStatuses(surveyId);
    backdatePending(surveyId, "awaiting_reply");
    await runCron();
    await expect.poll(() => pendingStatuses(surveyId).filter((s) => s === "expired").length).toBe(
      before.filter((s) => s === "expired").length + 1,
    );
    const [expired] = await waitForLogs(env.owner, surveyId, (l) => l.error_message === "no reply within 24h");
    expect(expired.status).toBe("partial");
    expect(expired.contact.phone).toBe(phone.replace(/\D/g, ""));

    // Nothing was sent on expiry; a late "yes" is a fresh message, not a reply.
    await inboundSettled(env, { from: phone, text: "yes" });
    await waitForText(env, phone, "keyword yes fired");
    expect(textsOf(await sentTo(env, phone))).toEqual(["keyword yes fired"]);
  });

  test("a timeout branch for wait-for-reply", async () => {
    test.fixme(true, "GAP: wait_for_reply has no timeout branch — on expiry the run just stops (log stays 'partial' with 'no reply within 24h'); there is no way to send a reminder or take another path");
  });

  test("pausing the automation while it waits hands the reply back to the normal triggers", async () => {
    const phone = randomCustomerPhone();
    await inboundSettled(env, { from: phone, text: "survey" });
    await waitForLogs(env.owner, surveyId, (l) => l.status === "partial" && l.contact.phone === phone.replace(/\D/g, ""));
    await api(env.owner, "PATCH", `/api/automations/${surveyId}`, { is_active: false });
    await inboundSettled(env, { from: phone, text: "yes" });
    await waitForText(env, phone, "keyword yes fired");
    expect(textsOf(await sentTo(env, phone))).toEqual(["keyword yes fired"]);
    await waitForLogs(env.owner, surveyId, (l) => l.error_message === "automation paused while waiting for reply");
  });
});
