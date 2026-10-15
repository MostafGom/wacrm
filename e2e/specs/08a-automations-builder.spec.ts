// Automations — list page + builder (create / edit / duplicate / toggle /
// delete), activation validation, the logs page, and role gates.

import { expect, test, type Page } from "@playwright/test";

import { addMember, api, newOwner, pageAs, type TestUser } from "../support/accounts";
import { randomCustomerPhone } from "../support/fakes";
import {
  addStep,
  automationEnv,
  closeTriggerCard,
  createAutomation,
  expandStep,
  fieldControl,
  getAutomation,
  inboundSettled,
  logsOf,
  saveBuilder,
  setActive,
  setName,
  setTrigger,
  waitForLogs,
  type AutomationEnv,
  type Json,
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

/** The list card (<li>) of an automation by its name. */
const card = (p: Page, name: string) => p.getByRole("listitem").filter({ hasText: name });

test("empty list shows the empty state, quick-start templates and the create button", async () => {
  await page.goto("/automations");
  await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible();
  await expect(page.getByText("No automations yet")).toBeVisible();
  await expect(page.getByText("Pick a template above or create one from scratch.")).toBeVisible();
  await expect(page.getByText("Quick-start templates")).toBeVisible();
  for (const name of ["Welcome Message", "Out of Office", "Lead Qualifier", "Follow-up Reminder"]) {
    await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  }
  await page.getByRole("button", { name: "Create Automation" }).click();
  await page.waitForURL(/\/automations\/new$/);
  await expect(page.getByRole("button", { name: "Save Draft" })).toBeVisible();
  await expect(page.getByPlaceholder("Untitled automation")).toHaveValue("");
  // Default trigger.
  await expect(page.getByRole("button", { name: /^Trigger\s*New Message Received/ })).toBeVisible();
});

test("create an automation in the builder: keyword trigger + message step, saved as a draft", async () => {
  await page.goto("/automations/new");
  await setName(page, "Pricing reply");
  await setTrigger(page, "Keyword Match");
  await expect(page.getByText("Message contains specific keyword(s)")).toBeVisible();
  const keywords = page.getByPlaceholder("Comma-separated list (e.g. hello, help, buy)");
  await keywords.fill("pricing,  price list , ");
  await keywords.press("Enter");
  await expect(keywords).toHaveValue("pricing, price list");
  await fieldControl(page, "Match type").selectOption({ label: "Whole word" });
  await expect(page.getByText(/Matches the keyword only as a standalone word/)).toBeVisible();
  await closeTriggerCard(page);

  await addStep(page, "Send Message");
  await page.getByPlaceholder("Hi! Thanks for reaching out…").fill("Our prices start at $10.");
  // Card preview mirrors the text.
  await expect(page.getByRole("button", { name: /Send Message\s*Our prices start at \$10\./ })).toBeVisible();

  const id = await saveBuilder(page, "Automation created");
  const { automation, steps } = await getAutomation(env.owner, id);
  expect(automation).toMatchObject({
    name: "Pricing reply",
    is_active: false,
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["pricing", "price list"], match_type: "word" },
  });
  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatchObject({ step_type: "send_message", step_config: { text: "Our prices start at $10." } });

  // After creating, the page is the editor and the button reads "Save".
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();

  await page.goto("/automations");
  const c = card(page, "Pricing reply");
  await expect(c).toBeVisible();
  await expect(c.getByText("Keyword Match")).toBeVisible();
  await expect(c.getByText("0 runs")).toBeVisible();
  await expect(c.getByText("last never")).toBeVisible();
  await expect(c.getByRole("switch", { name: "Activate" })).toHaveAttribute("aria-checked", "false");
});

test("an unnamed automation is saved as 'Untitled automation'", async () => {
  await page.goto("/automations/new");
  await addStep(page, "Close Conversation");
  await expect(page.getByText('Sets the conversation status to "closed". No configuration needed.')).toBeVisible();
  const id = await saveBuilder(page, "Automation created");
  expect((await getAutomation(env.owner, id)).automation.name).toBe("Untitled automation");
  await api(env.owner, "DELETE", `/api/automations/${id}`);
});

test("edit an automation: rename, add / reorder / delete steps, persisted on save", async () => {
  await page.goto("/automations");
  await card(page, "Pricing reply").getByRole("button", { name: /Pricing reply/ }).click();
  await page.waitForURL(/\/edit$/);
  await expect(page.getByPlaceholder("Untitled automation")).toHaveValue("Pricing reply");
  // Builder reloads the saved trigger config.
  await page.getByRole("button", { name: /^Trigger\s*Keyword Match/ }).click();
  await expect(page.getByPlaceholder("Comma-separated list (e.g. hello, help, buy)")).toHaveValue("pricing, price list");
  await expect(fieldControl(page, "Match type")).toHaveValue("word");
  await closeTriggerCard(page);

  await setName(page, "Pricing reply v2");
  // Append "Close Conversation" then "Add Tag", then move "Close Conversation" to the top.
  await addStep(page, "Close Conversation");
  await addStep(page, "Wait");
  await expect(fieldControl(page, "Amount")).toHaveValue("1");
  await fieldControl(page, "Amount").fill("3");
  await fieldControl(page, "Unit").selectOption({ label: "Days" });
  await expect(page.getByRole("button", { name: /Wait\s*Wait\s*3 days/ })).toBeVisible();

  await expandStep(page, "Close Conversation");
  await page.getByRole("button", { name: "Move up" }).click();
  // Move up is disabled for the first item.
  await expect(page.getByRole("button", { name: "Move up" })).toBeDisabled();

  // Delete the Wait step.
  await expandStep(page, "Wait");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("button", { name: /Wait\s*Wait\s*3 days/ })).toHaveCount(0);

  await saveBuilder(page, "Automation saved");
  const id = /automations\/([0-9a-f-]{36})\/edit/.exec(page.url())![1];
  const { automation, steps } = await getAutomation(env.owner, id);
  expect(automation.name).toBe("Pricing reply v2");
  expect(steps.map((s) => s.step_type)).toEqual(["close_conversation", "send_message"]);

  // Back arrow returns to the list.
  await page.getByRole("button", { name: "Back to automations" }).click();
  await page.waitForURL(/\/automations$/);
  await expect(card(page, "Pricing reply v2")).toBeVisible();
});

test("activating an invalid automation is refused with the first issue, and nothing is saved active", async () => {
  await page.goto("/automations/new");
  await setName(page, "Broken one");
  await addStep(page, "Send Message"); // empty text
  await setActive(page, true);
  await page.getByRole("button", { name: "Save Draft" }).click();
  await expect(page.getByText("message text is required")).toBeVisible();
  await expect(page.getByText("at steps[0].text")).toBeVisible();
  // Still on /new — nothing was created.
  expect(page.url()).toMatch(/\/automations\/new$/);
  const list = await api(env.owner, "GET", "/api/automations");
  expect(list.body.automations.map((a: { name: string }) => a.name)).not.toContain("Broken one");

  // No steps at all.
  await expandStep(page, "Send Message");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Save Draft" }).click();
  await expect(page.getByText("active automations need at least one step")).toBeVisible();

  // Keyword trigger without keywords.
  await addStep(page, "Close Conversation");
  await setTrigger(page, "Keyword Match");
  await page.getByRole("button", { name: "Save Draft" }).click();
  await expect(page.getByText("at least one keyword is required")).toBeVisible();

  // Fixing it lets it save as active.
  const kw = page.getByPlaceholder("Comma-separated list (e.g. hello, help, buy)");
  await kw.fill("broken");
  await kw.press("Enter");
  const id = await saveBuilder(page, "Automation created");
  expect((await getAutomation(env.owner, id)).automation.is_active).toBe(true);
  await api(env.owner, "DELETE", `/api/automations/${id}`);
});

test("activation validation covers every step type (API)", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ step_type: "send_template", step_config: { template_name: "" } }, "template name is required"],
    [{ step_type: "add_tag", step_config: { tag_id: "" } }, "tag is required"],
    [{ step_type: "remove_tag", step_config: { tag_id: " " } }, "tag is required"],
    [{ step_type: "assign_conversation", step_config: { mode: "specific" } }, 'agent is required when mode is "specific"'],
    [{ step_type: "update_contact_field", step_config: { field: "name", value: "" } }, "field value is required"],
    [{ step_type: "create_deal", step_config: { pipeline_id: "", stage_id: "", title: "" } }, "pipeline is required"],
    [{ step_type: "wait", step_config: { amount: 0, unit: "hours" } }, "wait amount must be greater than 0"],
    [{ step_type: "wait", step_config: { amount: 1, unit: "weeks" } }, "wait unit must be minutes, hours, or days"],
    [{ step_type: "condition", step_config: { subject: "tag_presence", operand: "" } }, "condition operand is required"],
    [{ step_type: "send_webhook", step_config: { url: "" } }, "webhook URL is required"],
    [{ step_type: "send_webhook", step_config: { url: "ftp://x.example" } }, "webhook URL must use http or https"],
    [{ step_type: "send_webhook", step_config: { url: "not a url" } }, "webhook URL is not a valid URL"],
    [{ step_type: "send_buttons", step_config: { kind: "buttons", body: "", buttons: [] } }, ""],
    [{ step_type: "teleport", step_config: {} }, "unknown step type: teleport"],
  ];
  for (const [step, message] of cases) {
    const r = await api(env.owner, "POST", "/api/automations", {
      name: "invalid",
      trigger_type: "new_message_received",
      is_active: true,
      steps: [step],
    });
    expect(r.status, JSON.stringify(step)).toBe(400);
    expect(r.body.error).toBe("Cannot activate automation with invalid configuration");
    if (message) expect(r.body.issues.map((i: { message: string }) => i.message)).toContain(message);
  }
  // Trigger validation.
  const trig: Array<[string, Record<string, unknown>, string]> = [
    ["tag_added", {}, "tag is required"],
    ["interactive_reply", { reply_ids: [] }, "at least one reply id is required"],
    ["interactive_reply", { reply_ids: [" "] }, "reply ids cannot be empty strings"],
    ["keyword_match", { keywords: ["ok"], match_type: "regex" }, 'match type must be "exact", "contains" or "word"'],
    ["keyword_match", { keywords: [""] }, "keywords cannot be empty strings"],
    ["time_based", {}, "schedule is required"],
  ];
  for (const [trigger_type, trigger_config, message] of trig) {
    const r = await api(env.owner, "POST", "/api/automations", {
      name: "invalid",
      trigger_type,
      trigger_config,
      is_active: true,
      steps: [{ step_type: "close_conversation", step_config: {} }],
    });
    expect(r.status).toBe(400);
    expect(r.body.issues.map((i: { message: string }) => i.message)).toContain(message);
  }
  // Missing name / trigger.
  const bad = await api(env.owner, "POST", "/api/automations", { trigger_type: "new_message_received" });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toBe("name and trigger_type are required");
  // Drafts may be incomplete.
  const draft = await createAutomation(env.owner, {
    name: "Draft incomplete",
    trigger_type: "tag_added",
    steps: [{ step_type: "add_tag", step_config: { tag_id: "" } }],
  });
  // ...but an already-active automation can't be edited into an invalid state.
  const fine = await createAutomation(env.owner, {
    name: "Active fine",
    trigger_type: "new_message_received",
    is_active: true,
    steps: [{ step_type: "close_conversation", step_config: {} }],
  });
  const patch = await api(env.owner, "PATCH", `/api/automations/${fine.id}`, {
    steps: [{ step_type: "send_message", step_config: { text: "" } }],
  });
  expect(patch.status).toBe(400);
  expect(patch.body.error).toBe("Cannot keep automation active with invalid configuration");
  expect((await getAutomation(env.owner, fine.id)).steps[0].step_type).toBe("close_conversation");
  for (const id of [draft.id, fine.id]) await api(env.owner, "DELETE", `/api/automations/${id}`);
});

test("toggle active from the list (and an invalid one is rolled back with an error)", async () => {
  const draft = await createAutomation(env.owner, {
    name: "Needs a tag",
    trigger_type: "new_message_received",
    steps: [{ step_type: "add_tag", step_config: { tag_id: "" } }],
  });
  await page.goto("/automations");
  const c = card(page, "Pricing reply v2");
  await c.getByRole("switch", { name: "Activate" }).click();
  await expect(page.getByText("Automation activated")).toBeVisible();
  await expect(c.getByRole("switch", { name: "Deactivate" })).toHaveAttribute("aria-checked", "true");
  await expect(c.getByLabel("active", { exact: true })).toBeVisible();
  const id = (await api(env.owner, "GET", "/api/automations")).body.automations.find(
    (a: { name: string }) => a.name === "Pricing reply v2",
  ).id;
  expect((await getAutomation(env.owner, id)).automation.is_active).toBe(true);

  await c.getByRole("switch", { name: "Deactivate" }).click();
  await expect(page.getByText("Automation paused")).toBeVisible();
  await expect(c.getByRole("switch", { name: "Activate" })).toHaveAttribute("aria-checked", "false");
  expect((await getAutomation(env.owner, id)).automation.is_active).toBe(false);

  const bad = card(page, "Needs a tag");
  await bad.getByRole("switch", { name: "Activate" }).click();
  // Turning an inactive one on reports an activation error (not "Cannot keep … active").
  await expect(page.getByText("Cannot activate automation with invalid configuration")).toBeVisible();
  await expect(bad.getByRole("switch", { name: "Activate" })).toHaveAttribute("aria-checked", "false");
  expect((await getAutomation(env.owner, draft.id)).automation.is_active).toBe(false);
  await api(env.owner, "DELETE", `/api/automations/${draft.id}`);
});

test("duplicate copies the trigger and the whole step tree as an inactive '(Copy)'", async () => {
  const src = await createAutomation(env.owner, {
    name: "Branchy",
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["branch"], match_type: "contains" },
    is_active: true,
    steps: [
      {
        step_type: "condition",
        step_config: { subject: "message_content", operand: "x", value: "vip" },
        branches: {
          yes: [{ step_type: "send_message", step_config: { text: "vip!" } }],
          no: [
            { step_type: "send_message", step_config: { text: "regular" } },
            { step_type: "close_conversation", step_config: {} },
          ],
        },
      },
    ],
  });
  await page.goto("/automations");
  await card(page, "Branchy").getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByText("Automation duplicated")).toBeVisible();
  const copyCard = card(page, "Branchy (Copy)");
  await expect(copyCard).toBeVisible();
  await expect(copyCard.getByRole("switch", { name: "Activate" })).toHaveAttribute("aria-checked", "false");

  const all = (await api(env.owner, "GET", "/api/automations")).body.automations;
  const copy = all.find((a: { name: string }) => a.name === "Branchy (Copy)");
  const [a, b] = await Promise.all([getAutomation(env.owner, src.id), getAutomation(env.owner, copy.id)]);
  expect(b.automation).toMatchObject({ trigger_type: "keyword_match", trigger_config: a.automation.trigger_config, is_active: false });
  const shape = (nodes: Array<Record<string, any>>): unknown => // eslint-disable-line @typescript-eslint/no-explicit-any
    nodes.map((n) => ({ t: n.step_type, c: n.step_config, yes: shape(n.branches?.yes ?? []), no: shape(n.branches?.no ?? []) }));
  expect(shape(b.steps)).toEqual(shape(a.steps));
  expect(b.steps[0].id).not.toBe(a.steps[0].id);

  // The copy opens in the builder with the branches intact.
  await copyCard.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.waitForURL(/\/edit$/);
  await expect(page.getByRole("button", { name: /Condition\s*Condition \(If\/Else\)\s*when message_content/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Send Message\s*vip!/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Send Message\s*regular/ })).toBeVisible();
});

test("delete asks for confirmation; cancel keeps it, confirm removes it", async () => {
  await page.goto("/automations");
  const c = card(page, "Branchy (Copy)");
  await c.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Delete automation")).toBeVisible();
  await expect(dialog.getByText(/This permanently removes Branchy \(Copy\) and its execution history/)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(c).toBeVisible();

  await c.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Automation deleted")).toBeVisible();
  await expect(card(page, "Branchy (Copy)")).toHaveCount(0);
  const names = (await api(env.owner, "GET", "/api/automations")).body.automations.map((a: { name: string }) => a.name);
  expect(names).not.toContain("Branchy (Copy)");
  expect(names).toContain("Branchy");
});

test("quick-start templates hide once the account has 3 automations", async () => {
  const n = (await api(env.owner, "GET", "/api/automations")).body.automations.length;
  expect(n).toBeGreaterThanOrEqual(2);
  for (let i = n; i < 3; i++) {
    await createAutomation(env.owner, { name: `Filler ${i}`, trigger_type: "new_message_received" });
  }
  await page.goto("/automations");
  await expect(card(page, "Branchy")).toBeVisible();
  await expect(page.getByText("Quick-start templates")).toHaveCount(0);
});

test("logs page: empty state, then success / failed / partial runs with step details and errors", async () => {
  const phone = randomCustomerPhone();
  const a = await createAutomation(env.owner, {
    name: "Logged",
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["logme"], match_type: "contains" },
    is_active: true,
    steps: [{ step_type: "close_conversation", step_config: {} }],
  });
  const b = await createAutomation(env.owner, {
    name: "Waits",
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["waitme"], match_type: "contains" },
    is_active: true,
    steps: [
      { step_type: "send_message", step_config: { text: "Hold on" } },
      { step_type: "wait", step_config: { amount: 2, unit: "hours" } },
      { step_type: "send_message", step_config: { text: "Later" } },
    ],
  });

  await page.goto(`/automations/${a.id}/logs`);
  await expect(page.getByRole("heading", { name: "Logged" })).toBeVisible();
  await expect(page.getByText("Execution logs")).toBeVisible();
  await expect(page.getByText("No executions yet")).toBeVisible();
  await expect(page.getByText("Trigger this automation to see runs here.")).toBeVisible();

  await inboundSettled(env, { from: phone, name: "Logan Logs", text: "logme please" });
  await waitForLogs(env.owner, a.id, (l) => l.status === "success");
  // Re-point the automation at a destination the SSRF guard refuses.
  const edit = await api(env.owner, "PATCH", `/api/automations/${a.id}`, {
    steps: [
      { step_type: "close_conversation", step_config: {} },
      { step_type: "send_webhook", step_config: { url: "http://127.0.0.1:9/nope" } },
      { step_type: "send_message", step_config: { text: "never sent" } },
    ],
  });
  expect(edit.status).toBe(200);
  await inboundSettled(env, { from: phone, text: "logme again" });
  await waitForLogs(env.owner, a.id, (l) => l.status === "failed");
  await inboundSettled(env, { from: phone, text: "waitme" });
  await waitForLogs(env.owner, b.id, (l) => l.status === "partial");

  await page.reload();
  const rows = page.getByRole("listitem").filter({ hasText: /keyword_match · / });
  await expect(rows).toHaveCount(2);
  // Newest first: the failed run.
  const failed = rows.nth(0);
  await expect(failed.getByText("failed", { exact: true })).toBeVisible();
  await expect(failed.getByText("Logan Logs")).toBeVisible();
  await expect(failed.getByText("keyword_match · 2 steps")).toBeVisible();
  await expect(failed.getByText("just now")).toBeVisible();
  await failed.getByRole("button").click();
  // Error banner + the failing step's detail; the step after it never ran.
  await expect(failed.getByText("send_webhook: destination not allowed")).toHaveCount(2);
  await expect(failed.getByText("close_conversation", { exact: true })).toBeVisible();
  await expect(failed.getByText("— conversation closed")).toBeVisible();
  await expect(failed.getByText("send_webhook", { exact: true })).toBeVisible();
  await expect(failed.getByText("send_message", { exact: true })).toHaveCount(0);

  const ok = rows.nth(1);
  await expect(ok.getByText("success", { exact: true })).toBeVisible();
  await expect(ok.getByText("keyword_match · 1 step")).toBeVisible();
  await ok.getByRole("button").click();
  await expect(ok.getByText("— conversation closed")).toBeVisible();
  // Opening one log collapses the other.
  await expect(failed.getByText("send_webhook", { exact: true })).toHaveCount(0);

  // Partial (parked at a wait) — reached through the list's "View Logs".
  await page.goto("/automations");
  await card(page, "Waits").getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "View Logs" }).click();
  await page.waitForURL(new RegExp(`/automations/${b.id}/logs$`));
  const partial = page.getByRole("listitem").filter({ hasText: /keyword_match · / }).first();
  await expect(partial.getByText("partial", { exact: true })).toBeVisible();
  await partial.getByRole("button").click();
  await expect(partial.getByText(/— sent via Meta \(wamid\./)).toBeVisible();
  await expect(partial.getByText("— waiting 2 hours")).toBeVisible();

  // The list card counts runs.
  await page.goto("/automations");
  await expect(card(page, "Logged").getByText("2 runs")).toBeVisible();
  await expect(card(page, "Waits").getByText("1 run", { exact: true })).toBeVisible();
  await expect(card(page, "Logged").getByText("last just now")).toBeVisible();

  // Back button.
  await page.goto(`/automations/${a.id}/logs`);
  await page.getByRole("button", { name: "Back" }).click();
  await page.waitForURL(/\/automations$/);
  expect((await logsOf(env.owner, a.id)).every((l) => l.contact.name === "Logan Logs")).toBe(true);
});

test("logs / edit pages for an unknown automation show an error", async () => {
  await page.goto("/automations/00000000-0000-4000-8000-000000000000/logs");
  await expect(page.getByText(/not found/i)).toBeVisible();
  await page.goto("/automations/00000000-0000-4000-8000-000000000000/edit");
  await expect(page.getByText("Failed to load (404)")).toBeVisible();
  await page.getByRole("button", { name: "Back to Automations" }).click();
  await page.waitForURL(/\/automations$/);
});

test.describe("role gates", () => {
  let viewer: TestUser;
  let agent: TestUser;
  let target: Json;

  test.beforeAll(async () => {
    [viewer, agent] = await Promise.all([addMember(env.owner, "viewer"), addMember(env.owner, "agent")]);
    target = await createAutomation(env.owner, {
      name: "Gatekeeper",
      trigger_type: "new_message_received",
      steps: [{ step_type: "close_conversation", step_config: {} }],
    });
  });

  test("viewer can read but not create / edit / toggle / duplicate / delete / fire", async ({ browser }) => {
    const { context, page: vp } = await pageAs(browser, viewer);
    await vp.goto("/automations");
    await expect(card(vp, "Gatekeeper")).toBeVisible();
    const create = vp.getByRole("button", { name: "Create Automation" });
    await expect(create).toBeDisabled();
    await expect(vp.locator("span[title=\"Read-only — your role can't create automations\"]")).toBeVisible();

    // The switch is clickable but the server refuses; the UI rolls back.
    const sw = card(vp, "Gatekeeper").getByRole("switch", { name: "Activate" });
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    expect((await getAutomation(env.owner, target.id)).automation.is_active).toBe(false);

    // Logs are readable.
    await vp.goto(`/automations/${target.id}/logs`);
    await expect(vp.getByRole("heading", { name: "Gatekeeper" })).toBeVisible();
    await context.close();

    expect((await api(viewer, "GET", "/api/automations")).status).toBe(200);
    expect((await api(viewer, "GET", `/api/automations/${target.id}`)).status).toBe(200);
    expect((await api(viewer, "GET", `/api/automations/${target.id}/logs`)).status).toBe(200);
    expect((await api(viewer, "GET", "/api/automations/resources")).status).toBe(200);
    expect((await api(viewer, "POST", "/api/automations", { name: "x", trigger_type: "new_message_received" })).status).toBe(403);
    expect((await api(viewer, "PATCH", `/api/automations/${target.id}`, { name: "hijack" })).status).toBe(403);
    expect((await api(viewer, "POST", `/api/automations/${target.id}/duplicate`)).status).toBe(403);
    expect((await api(viewer, "DELETE", `/api/automations/${target.id}`)).status).toBe(403);
    expect((await api(viewer, "POST", "/api/automations/engine", { trigger_type: "new_message_received" })).status).toBe(403);
    const still = await getAutomation(env.owner, target.id);
    expect(still.automation.name).toBe("Gatekeeper");
  });

  test("agent can create, edit, duplicate and delete automations", async ({ browser }) => {
    const { context, page: ap } = await pageAs(browser, agent);
    await ap.goto("/automations");
    await ap.getByRole("button", { name: "Create Automation" }).click();
    await ap.waitForURL(/\/automations\/new$/);
    await setName(ap, "Agent made");
    await addStep(ap, "Close Conversation");
    const id = await saveBuilder(ap, "Automation created");
    await context.close();

    const made = await getAutomation(env.owner, id);
    expect(made.automation.user_id).toBe(agent.userId);
    expect((await api(agent, "PATCH", `/api/automations/${id}`, { name: "Agent edited" })).status).toBe(200);
    const dup = await api(agent, "POST", `/api/automations/${id}/duplicate`);
    expect(dup.status).toBe(201);
    expect(dup.body.automation.name).toBe("Agent edited (Copy)");
    expect((await api(agent, "DELETE", `/api/automations/${dup.body.automation.id}`)).status).toBe(200);
    expect((await api(agent, "DELETE", `/api/automations/${id}`)).status).toBe(200);
    expect((await api(env.owner, "GET", `/api/automations/${id}`)).status).toBe(404);
  });

  test("another account can't see or touch this account's automations", async () => {
    const stranger = await newOwner("Stan Stranger");
    expect((await api(stranger, "GET", `/api/automations/${target.id}`)).status).toBe(404);
    expect((await api(stranger, "GET", `/api/automations/${target.id}/logs`)).status).toBe(404);
    expect((await api(stranger, "PATCH", `/api/automations/${target.id}`, { name: "pwned" })).status).toBe(404);
    expect((await api(stranger, "POST", `/api/automations/${target.id}/duplicate`)).status).toBe(404);
    await api(stranger, "DELETE", `/api/automations/${target.id}`);
    expect((await api(stranger, "GET", "/api/automations")).body.automations).toEqual([]);
    expect((await getAutomation(env.owner, target.id)).automation.name).toBe("Gatekeeper");
  });

  test("anonymous callers and a wrong cron secret are refused", async () => {
    expect((await api(null, "GET", "/api/automations")).status).toBe(401);
    expect((await api(null, "POST", "/api/automations/engine", { trigger_type: "new_message_received" })).status).toBe(401);
    expect((await api(null, "GET", "/api/automations/cron", undefined, { "x-cron-secret": "wrong" })).status).toBe(401);
    expect((await api(null, "GET", "/api/automations/cron")).status).toBe(401);
  });
});
