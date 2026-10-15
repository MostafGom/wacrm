// Pipelines & deals: default pipeline seeding, pipeline + stage management
// (add / rename / recolour / drag-reorder / delete), deals (create, edit,
// drag between stages, won/lost/reopen, delete), the analytics strip, the
// account default currency, and role gates — all through /pipelines.

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

import { addMember, api, newOwner, pageAs, type TestUser } from "../support/accounts";
import { randomCustomerPhone } from "../support/fakes";

const run = Date.now().toString(36);

let owner: TestUser;
let agent: TestUser;
let viewer: TestUser;
let pia: { id: string; name: string };
let quinn: { id: string; name: string };

interface Stage {
  id: string;
  name: string;
  color: string;
  position: number;
}
interface Deal {
  id: string;
  title: string;
  value: number;
  currency: string;
  stage_id: string;
  status: string;
  contact_id: string | null;
  assigned_to: string | null;
  expected_close_date: string | null;
  notes: string | null;
}

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------

const contexts: BrowserContext[] = [];

async function openPipelines(browser: Browser, user: TestUser, pipelineName?: string): Promise<Page> {
  const { context, page } = await pageAs(browser, user);
  contexts.push(context);
  await page.goto("/pipelines");
  await expect(page.getByText("Total Deals").or(page.getByText("Create a pipeline to start tracking deals"))).toBeVisible();
  if (pipelineName) await selectPipeline(page, pipelineName);
  return page;
}

/** The pipeline dropdown trigger (shows the selected pipeline's name). */
const pipelineTrigger = (page: Page) => page.getByRole("main").getByRole("button").filter({ has: page.locator("svg.lucide-git-branch") });

async function selectPipeline(page: Page, name: string) {
  await pipelineTrigger(page).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
  await expect(pipelineTrigger(page)).toHaveText(name);
}

async function openManage(page: Page): Promise<Locator> {
  await pipelineTrigger(page).click();
  await page.getByRole("menuitem", { name: "Manage Pipelines" }).click();
  const dlg = page.getByRole("dialog", { name: "Manage Pipeline" });
  await expect(dlg).toBeVisible();
  return dlg;
}

/** Stage rows in the Manage Pipeline dialog, in display order. */
const stageRows = (dlg: Locator) => dlg.getByRole("button", { name: "Drag to reorder" }).locator("xpath=..");

async function stageRowNames(dlg: Locator): Promise<string[]> {
  return stageRows(dlg)
    .locator("input")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
}

async function stageRow(dlg: Locator, name: string): Promise<Locator> {
  const names = await stageRowNames(dlg);
  const i = names.indexOf(name);
  expect(i, `stage row "${name}" in ${JSON.stringify(names)}`).toBeGreaterThanOrEqual(0);
  return stageRows(dlg).nth(i);
}

/** A stage column on the board. */
const column = (page: Page, stage: string) =>
  page.locator("div.snap-start").filter({ has: page.getByRole("heading", { level: 3, name: stage, exact: true }) });

/** A deal card (its dnd-kit draggable wrapper) anywhere on the board, or within `scope`. */
const card = (scope: Page | Locator, title: string) =>
  scope.locator('[aria-roledescription="draggable"]').filter({ has: scope.getByRole("heading", { level: 4, name: title }) });

async function boardStageNames(page: Page): Promise<string[]> {
  return page.locator("div.snap-start h3").allTextContents();
}

/** Analytics strip value for a metric label. */
const metric = (page: Page, label: string) =>
  page.locator("div.rounded-lg").filter({ has: page.getByText(label, { exact: true }) }).locator("p");

const toast = (page: Page, text: string | RegExp) => page.locator("[data-sonner-toast]").filter({ hasText: text }).first();

/** Pointer drag (dnd-kit PointerSensor needs ≥5px of movement to activate). */
async function drag(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
  await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2 + 2, { steps: 2 });
  await page.mouse.up();
}

async function createPipelineApi(name: string, stages: string[]) {
  const r = await api(owner, "POST", "/api/pipelines", {
    name,
    stages: stages.map((s, i) => ({ name: s, color: "#3b82f6", position: i })),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const pipeline = r.body.pipeline as { id: string; name: string };
  return { pipeline, stages: await stagesOf(pipeline.id) };
}

async function stagesOf(pipelineId: string): Promise<Stage[]> {
  const r = await api(owner, "GET", `/api/pipelines/${pipelineId}/stages`);
  expect(r.status).toBe(200);
  return (r.body.stages as Stage[]).sort((a, b) => a.position - b.position);
}

async function dealsOf(pipelineId: string): Promise<Deal[]> {
  const r = await api(owner, "GET", `/api/deals?pipelineId=${pipelineId}`);
  expect(r.status).toBe(200);
  return r.body.deals;
}

async function createDealApi(user: TestUser, fields: Record<string, unknown>) {
  const r = await api(user, "POST", "/api/deals", { currency: "USD", ...fields });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.deal as Deal;
}

async function createContactApi(name: string) {
  const r = await api(owner, "POST", "/api/contacts", { name, phone: randomCustomerPhone() });
  expect(r.status).toBe(201);
  return r.body.contact as { id: string; name: string };
}

const dealSheet = (page: Page, title: "New Deal" | "Edit Deal") => page.getByRole("dialog", { name: title });
const selectWithOption = (scope: Locator, option: string) =>
  scope.locator("select").filter({ has: scope.page().locator("option", { hasText: option }) });

test.beforeAll(async () => {
  owner = await newOwner("Pat Pipelines");
  [agent, viewer] = await Promise.all([addMember(owner, "agent", "Gil Agent"), addMember(owner, "viewer", "Val Viewer")]);
  pia = await createContactApi(`Pia Pipeline ${run}`);
  quinn = await createContactApi(`Quinn Pipeline ${run}`);
});

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});

// ------------------------------------------------------------
// pipelines & stages
// ------------------------------------------------------------

test("the default Sales Pipeline is seeded with five stages", async ({ browser }) => {
  // Arrive via the sidebar (profile already loaded); the direct-load path
  // is covered by the next test.
  const { context, page } = await pageAs(browser, owner);
  contexts.push(context);
  await page.goto("/contacts");
  await page.getByRole("link", { name: "Pipelines" }).first().click();
  await expect(page).toHaveURL(/\/pipelines/);
  await expect(pipelineTrigger(page)).toHaveText("Sales Pipeline");
  await expect.poll(() => boardStageNames(page)).toEqual(["New Lead", "Qualified", "Proposal Sent", "Negotiation", "Won"]);
  await expect(page.getByText("Drop a deal here")).toHaveCount(5);
  await expect(metric(page, "Total Deals")).toHaveText("0");
  await expect(metric(page, "Pipeline Value")).toHaveText("$0");

  // Reloading doesn't seed a second one.
  await page.reload();
  await expect(pipelineTrigger(page)).toHaveText("Sales Pipeline");
  const pipelines = (await api(owner, "GET", "/api/pipelines")).body.pipelines as { id: string; name: string }[];
  expect(pipelines.filter((p) => p.name === "Sales Pipeline")).toHaveLength(1);
  const stages = await stagesOf(pipelines[0].id);
  expect(stages.map((s) => [s.name, s.color])).toEqual([
    ["New Lead", "#3b82f6"],
    ["Qualified", "#eab308"],
    ["Proposal Sent", "#f97316"],
    ["Negotiation", "#8b5cf6"],
    ["Won", "#22c55e"],
  ]);
});

test("opening /pipelines directly on a new account seeds the default pipeline", async ({ browser }) => {
  const fresh = await newOwner("Seed Owner");
  const page = await openPipelines(browser, fresh);
  await expect(pipelineTrigger(page)).toHaveText("Sales Pipeline");
  expect((await api(fresh, "GET", "/api/pipelines")).body.pipelines).toHaveLength(1);
});

test("admin creates a pipeline, then adds, renames, recolours and reorders stages", async ({ browser }) => {
  const page = await openPipelines(browser, owner);
  const name = `Enterprise ${run}`;

  await page.getByRole("button", { name: "Add Pipeline" }).click();
  const dlg = page.getByRole("dialog", { name: "New Pipeline" });
  await expect(dlg.getByText("Default stages (New Lead → Won) will be created automatically.")).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Create Pipeline" })).toBeDisabled();
  await dlg.getByPlaceholder("e.g., Enterprise Sales").fill(name);
  await dlg.getByRole("button", { name: "Create Pipeline" }).click();
  await expect(toast(page, "Pipeline created")).toBeVisible();
  await expect(pipelineTrigger(page)).toHaveText(name);
  await expect.poll(() => boardStageNames(page)).toEqual(["New Lead", "Qualified", "Proposal Sent", "Negotiation", "Won"]);
  const pipeline = ((await api(owner, "GET", "/api/pipelines")).body.pipelines as { id: string; name: string }[]).find((p) => p.name === name)!;
  expect(pipeline).toBeTruthy();

  // Manage: add a stage (persisted immediately) with a chosen colour.
  const manage = await openManage(page);
  await expect(manage.getByText("Stages")).toBeVisible();
  await manage.getByRole("button", { name: "Pick color #ec4899" }).click();
  await manage.getByPlaceholder("New stage name").fill("Discovery");
  await manage.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => stageRowNames(manage)).toEqual(["New Lead", "Qualified", "Proposal Sent", "Negotiation", "Won", "Discovery"]);
  await expect.poll(async () => (await stagesOf(pipeline.id)).find((s) => s.name === "Discovery")?.color).toBe("#ec4899");

  // Rename a stage and the pipeline.
  await (await stageRow(manage, "Qualified")).locator("input").fill("Qualified Lead");
  const renamed = `Enterprise Renamed ${run}`;
  await manage.getByRole("textbox").first().fill(renamed);

  // Recolour "New Lead" via its swatch.
  const newLead = await stageRow(manage, "New Lead");
  await newLead.getByRole("button", { name: "Change color" }).click();
  await newLead.locator('button[style*="rgb(20, 184, 166)"]').click();
  await expect(newLead.getByRole("button", { name: "Change color" })).toHaveAttribute("style", /rgb\(20, 184, 166\)/);

  // Drag "Discovery" to the top.
  const handles = manage.getByRole("button", { name: "Drag to reorder" });
  await drag(page, handles.nth(5), handles.nth(0));
  await expect.poll(() => stageRowNames(manage)).toEqual(["Discovery", "New Lead", "Qualified Lead", "Proposal Sent", "Negotiation", "Won"]);

  await manage.getByRole("button", { name: "Save Changes" }).click();
  await expect(toast(page, "Pipeline saved")).toBeVisible();
  await expect(manage).toBeHidden();
  await expect(pipelineTrigger(page)).toHaveText(renamed);
  await expect.poll(() => boardStageNames(page)).toEqual(["Discovery", "New Lead", "Qualified Lead", "Proposal Sent", "Negotiation", "Won"]);

  const saved = await stagesOf(pipeline.id);
  expect(saved.map((s) => s.name)).toEqual(["Discovery", "New Lead", "Qualified Lead", "Proposal Sent", "Negotiation", "Won"]);
  expect(saved.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(saved.find((s) => s.name === "New Lead")!.color).toBe("#14b8a6");
  expect(saved.find((s) => s.name === "Discovery")!.color).toBe("#ec4899");
  const pipelines = (await api(owner, "GET", "/api/pipelines")).body.pipelines as { id: string; name: string }[];
  expect(pipelines.find((p) => p.id === pipeline.id)!.name).toBe(renamed);

  // Cancel discards unsaved edits.
  const again = await openManage(page);
  await again.getByRole("textbox").first().fill("Should not stick");
  await (await stageRow(again, "Won")).locator("input").fill("Closed");
  await again.getByRole("button", { name: "Cancel" }).click();
  await expect(again).toBeHidden();
  await expect(pipelineTrigger(page)).toHaveText(renamed);
  expect((await stagesOf(pipeline.id)).map((s) => s.name)).toContain("Won");

  // An empty pipeline name can't be saved.
  const third = await openManage(page);
  await third.getByRole("textbox").first().fill("  ");
  await expect(third.getByRole("button", { name: "Save Changes" })).toBeDisabled();
});

test("a stage that still has deals can't be deleted; an empty stage can", async ({ browser }) => {
  const { pipeline, stages } = await createPipelineApi(`Stage Delete ${run}`, ["Busy", "Middle", "Empty"]);
  await createDealApi(owner, { title: `Blocker ${run}`, pipeline_id: pipeline.id, stage_id: stages[0].id, contact_id: pia.id, value: 10 });

  const page = await openPipelines(browser, owner, pipeline.name);
  const manage = await openManage(page);
  await (await stageRow(manage, "Busy")).getByRole("button").last().click();
  await expect(toast(page, "Move or delete deals in this stage first")).toBeVisible();
  expect(await stageRowNames(manage)).toEqual(["Busy", "Middle", "Empty"]);

  await (await stageRow(manage, "Empty")).getByRole("button").last().click();
  await expect.poll(() => stageRowNames(manage)).toEqual(["Busy", "Middle"]);
  expect((await stagesOf(pipeline.id)).map((s) => s.name)).toEqual(["Busy", "Middle"]);

  await manage.getByRole("button", { name: "Save Changes" }).click();
  await expect(toast(page, "Pipeline saved")).toBeVisible();
  await expect.poll(() => boardStageNames(page)).toEqual(["Busy", "Middle"]);

  // API: 409 with a code while deals remain.
  const r = await api(owner, "DELETE", `/api/pipelines/${pipeline.id}/stages/${stages[0].id}`);
  expect(r.status).toBe(409);
  expect(r.body.code).toBe("stage_has_deals");
});

test("deleting a stage then closing the dialog with Cancel updates the board", async ({ browser }) => {
  const { pipeline } = await createPipelineApi(`Stale Board ${run}`, ["Keep", "Drop"]);
  const page = await openPipelines(browser, owner, pipeline.name);
  const manage = await openManage(page);
  await (await stageRow(manage, "Drop")).getByRole("button").last().click();
  await expect.poll(() => stageRowNames(manage)).toEqual(["Keep"]);
  await manage.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => boardStageNames(page)).toEqual(["Keep"]);
});

// ------------------------------------------------------------
// deals
// ------------------------------------------------------------

test("agent creates a deal linked to a contact, then edits its value and currency", async ({ browser }) => {
  const { pipeline } = await createPipelineApi(`Deals ${run}`, ["Lead", "Qualified", "Closing"]);
  const page = await openPipelines(browser, agent, pipeline.name);
  const title = `Website redesign ${run}`;

  await page.getByRole("button", { name: "Add Deal" }).first().click();
  const sheet = dealSheet(page, "New Deal");
  await expect(sheet).toBeVisible();
  const create = sheet.getByRole("button", { name: "Create Deal" });
  await expect(create).toBeDisabled();
  await sheet.getByPlaceholder("Deal title").fill(title);
  await expect(create).toBeDisabled(); // contact still missing
  await selectWithOption(sheet, "Select a contact").selectOption({ label: pia.name });
  await sheet.getByPlaceholder("0").fill("1500");
  await expect(selectWithOption(sheet, "EUR")).toHaveValue("USD");
  await expect(selectWithOption(sheet, "Closing")).toHaveValue((await stagesOf(pipeline.id))[0].id);
  await sheet.locator('input[type="date"]').fill("2026-12-31");
  await selectWithOption(sheet, "Unassigned").selectOption({ label: agent.name });
  await sheet.getByPlaceholder("Add notes...").fill("Wants a quote by Friday");
  await create.click();
  await expect(toast(page, "Deal created")).toBeVisible();
  await expect(sheet).toBeHidden();

  const lead = column(page, "Lead");
  const c = card(page, title);
  await expect(lead.locator('[aria-roledescription="draggable"]').filter({ hasText: title })).toBeVisible();
  await expect(c).toContainText(pia.name);
  await expect(c).toContainText("$1,500");
  await expect(c).toContainText("Dec 31, 2026");
  await expect(c.getByTitle(agent.name)).toBeVisible();
  await expect(lead).toContainText("$1,500");

  const options = (await api(agent, "GET", "/api/deals/form-options")).body as { profiles: { id: string; full_name: string }[] };
  const agentProfileId = options.profiles.find((p) => p.full_name === agent.name)!.id;
  let [deal] = (await dealsOf(pipeline.id)).filter((d) => d.title === title);
  expect(deal).toMatchObject({
    value: 1500,
    currency: "USD",
    contact_id: pia.id,
    assigned_to: agentProfileId,
    status: "open",
    expected_close_date: "2026-12-31",
    notes: "Wants a quote by Friday",
  });

  // Edit value + currency.
  await c.click();
  const edit = dealSheet(page, "Edit Deal");
  await expect(edit.getByPlaceholder("Deal title")).toHaveValue(title);
  await expect(selectWithOption(edit, "Select a contact")).toHaveValue(pia.id);
  await edit.getByPlaceholder("0").fill("2500.5");
  await selectWithOption(edit, "Unassigned").selectOption("");
  await selectWithOption(edit, "USD").selectOption("EUR");
  await edit.getByRole("button", { name: "Save Changes" }).click();
  await expect(toast(page, "Deal updated")).toBeVisible();
  await expect(c).toContainText("€2,501");
  await expect(c.getByTitle(agent.name)).toHaveCount(0);
  [deal] = (await dealsOf(pipeline.id)).filter((d) => d.title === title);
  expect(deal).toMatchObject({ value: 2500.5, currency: "EUR", assigned_to: null });

  // Per-column "Add Deal" preselects that stage.
  await column(page, "Qualified").getByRole("button", { name: "Add Deal" }).click();
  const second = dealSheet(page, "New Deal");
  const stages = await stagesOf(pipeline.id);
  await expect(selectWithOption(second, "Closing")).toHaveValue(stages[1].id);
  await second.getByPlaceholder("Deal title").fill(`Support plan ${run}`);
  await selectWithOption(second, "Select a contact").selectOption({ label: quinn.name });
  await second.getByRole("button", { name: "Create Deal" }).click();
  await expect(column(page, "Qualified").locator('[aria-roledescription="draggable"]').filter({ hasText: `Support plan ${run}` })).toBeVisible();
  await expect(card(page, `Support plan ${run}`)).toContainText("$0");
  expect((await dealsOf(pipeline.id)).find((d) => d.title === `Support plan ${run}`)!.stage_id).toBe(stages[1].id);

  // The deal shows on the contact's detail sheet.
  await page.goto("/contacts");
  await page.getByPlaceholder("Search by name, phone, or email...").fill(pia.name);
  await page.getByRole("row").filter({ hasText: pia.name }).getByRole("cell", { name: pia.name, exact: true }).click();
  const contactSheet = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: pia.name }) });
  await contactSheet.getByRole("tab", { name: "Deals" }).click();
  await expect(contactSheet.getByText(title)).toBeVisible();
  await expect(contactSheet.getByText("Lead", { exact: true })).toBeVisible();
});

test("drag a deal between stages with the mouse", async ({ browser }) => {
  const { pipeline, stages } = await createPipelineApi(`Drag ${run}`, ["One", "Two", "Three"]);
  const title = `Draggable ${run}`;
  await createDealApi(agent, { title, pipeline_id: pipeline.id, stage_id: stages[0].id, contact_id: quinn.id, value: 700 });

  const page = await openPipelines(browser, agent, pipeline.name);
  await expect(column(page, "One").locator('[aria-roledescription="draggable"]').filter({ hasText: title })).toBeVisible();

  await drag(page, card(page, title), column(page, "Three").getByText("Drop a deal here"));
  await expect(column(page, "Three").locator('[aria-roledescription="draggable"]').filter({ hasText: title })).toBeVisible();
  await expect(column(page, "One").getByText("Drop a deal here")).toBeVisible();
  await expect(column(page, "Three")).toContainText("$700");
  await expect.poll(async () => (await dealsOf(pipeline.id))[0].stage_id).toBe(stages[2].id);

  // Persists across reload; drag back to the middle.
  await page.reload();
  await selectPipeline(page, pipeline.name);
  await expect(column(page, "Three").locator('[aria-roledescription="draggable"]').filter({ hasText: title })).toBeVisible();
  await drag(page, card(page, title), column(page, "Two").getByText("Drop a deal here"));
  await expect.poll(async () => (await dealsOf(pipeline.id))[0].stage_id).toBe(stages[1].id);
  await expect(column(page, "Two").locator('[aria-roledescription="draggable"]').filter({ hasText: title })).toBeVisible();

  // A short click (no drag) opens the editor instead of moving.
  await card(page, title).click();
  await expect(dealSheet(page, "Edit Deal")).toBeVisible();
  expect((await dealsOf(pipeline.id))[0].stage_id).toBe(stages[1].id);
});

test("mark a deal won, reopen it, mark it lost, reopen again", async ({ browser }) => {
  const { pipeline } = await createPipelineApi(`Status ${run}`, ["Open", "Done"]);
  const stages = await stagesOf(pipeline.id);
  const title = `Status deal ${run}`;
  const deal = await createDealApi(agent, { title, pipeline_id: pipeline.id, stage_id: stages[0].id, contact_id: pia.id, value: 400 });
  const status = async () => (await dealsOf(pipeline.id)).find((d) => d.id === deal.id)!.status;

  const page = await openPipelines(browser, agent, pipeline.name);
  await expect(metric(page, "Won This Month")).toHaveText("0");

  await card(page, title).click();
  let sheet = dealSheet(page, "Edit Deal");
  await expect(sheet.getByRole("button", { name: "Reopen deal" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Mark as Won" }).click();
  await expect(toast(page, "Marked as won")).toBeVisible();
  await expect(sheet).toBeHidden();
  await expect(card(page, title)).toContainText("Won");
  await expect(metric(page, "Won This Month")).toHaveText("1");
  await expect(metric(page, "Total Deals")).toHaveText("1");
  expect(await status()).toBe("won");

  await card(page, title).click();
  sheet = dealSheet(page, "Edit Deal");
  await expect(sheet.getByRole("button", { name: "Mark as Won" })).toBeDisabled();
  await sheet.getByRole("button", { name: "Reopen deal" }).click();
  await expect(toast(page, "Deal reopened")).toBeVisible();
  await expect(card(page, title)).not.toContainText("Won");
  await expect(metric(page, "Won This Month")).toHaveText("0");
  expect(await status()).toBe("open");

  await card(page, title).click();
  sheet = dealSheet(page, "Edit Deal");
  await sheet.getByRole("button", { name: "Mark as Lost" }).click();
  await expect(toast(page, "Marked as lost")).toBeVisible();
  await expect(card(page, title)).toContainText("Lost");
  await expect(metric(page, "Lost This Month")).toHaveText("1");
  await expect(metric(page, "Total Deals")).toHaveText("0");
  await expect(metric(page, "Pipeline Value")).toHaveText("$0");
  expect(await status()).toBe("lost");

  await card(page, title).click();
  sheet = dealSheet(page, "Edit Deal");
  await expect(sheet.getByRole("button", { name: "Mark as Lost" })).toBeDisabled();
  await sheet.getByRole("button", { name: "Reopen deal" }).click();
  await expect(toast(page, "Deal reopened")).toBeVisible();
  await expect(metric(page, "Total Deals")).toHaveText("1");
  expect(await status()).toBe("open");
});

test("analytics strip totals, weighted value and per-stage totals", async ({ browser }) => {
  const { pipeline, stages } = await createPipelineApi(`Analytics ${run}`, ["Early", "Late", "Closed"]);
  const base = { pipeline_id: pipeline.id, contact_id: pia.id };
  await createDealApi(owner, { ...base, title: `A1 ${run}`, stage_id: stages[0].id, value: 1000 });
  await createDealApi(owner, { ...base, title: `A2 ${run}`, stage_id: stages[1].id, value: 3000 });
  const won = await createDealApi(owner, { ...base, title: `A3 ${run}`, stage_id: stages[2].id, value: 2000 });
  const lost = await createDealApi(owner, { ...base, title: `A4 ${run}`, stage_id: stages[0].id, value: 500 });
  expect((await api(owner, "PATCH", `/api/deals/${won.id}`, { status: "won" })).status).toBe(200);
  expect((await api(owner, "PATCH", `/api/deals/${lost.id}`, { status: "lost" })).status).toBe(200);

  const page = await openPipelines(browser, viewer, pipeline.name);
  // Lost excluded; won included.
  await expect(metric(page, "Total Deals")).toHaveText("3");
  await expect(metric(page, "Pipeline Value")).toHaveText("$6,000");
  await expect(metric(page, "Avg Deal Size")).toHaveText("$2,000");
  // Open deals × stage probability: 1000×10% + 3000×90% (won deals excluded).
  await expect(metric(page, "Weighted Value")).toHaveText("$2,800");
  await expect(metric(page, "Won This Month")).toHaveText("1");
  await expect(metric(page, "Lost This Month")).toHaveText("1");

  // Column headers: deal count and the stage total (every deal in it).
  await expect(column(page, "Early").locator("span.rounded-full").first()).toHaveText("2");
  await expect(column(page, "Early")).toContainText("$1,500");
  await expect(column(page, "Late")).toContainText("$3,000");

  // Explanatory tooltip.
  await page.getByRole("button", { name: "How Weighted Value is calculated" }).hover();
  await expect(page.getByText(/each open deal's value × its stage probability/)).toBeVisible();
});

test("default currency: admin switches it in Settings and totals/new deals follow", async ({ browser }) => {
  const { pipeline, stages } = await createPipelineApi(`Currency ${run}`, ["Only"]);
  await createDealApi(owner, { title: `Cur ${run}`, pipeline_id: pipeline.id, stage_id: stages[0].id, contact_id: pia.id, value: 1200 });

  // Agents see the setting read-only.
  const { context: agentCtx, page: agentPage } = await pageAs(browser, agent);
  contexts.push(agentCtx);
  await agentPage.goto("/settings?tab=deals");
  await expect(agentPage.getByText("Only account admins can change the default currency.")).toBeVisible();
  await expect(agentPage.getByRole("combobox")).toBeDisabled();
  await expect(agentPage.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  expect((await api(agent, "PATCH", "/api/deals/default-currency", { currency: "EUR" })).status).toBe(403);
  expect((await api(owner, "PATCH", "/api/deals/default-currency", { currency: "euro" })).status).toBe(400);

  try {
    const { context, page } = await pageAs(browser, owner);
    contexts.push(context);
    await page.goto("/settings?tab=deals");
    const select = page.getByRole("combobox");
    await expect(select).toHaveValue("USD");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await select.selectOption("EUR");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "Default currency updated")).toBeVisible();

    await page.goto("/pipelines");
    await selectPipeline(page, pipeline.name);
    await expect(metric(page, "Pipeline Value")).toHaveText("€1,200");
    await expect(column(page, "Only")).toContainText("€1,200");
    // The deal itself keeps the currency it was saved with.
    await expect(card(page, `Cur ${run}`)).toContainText("$1,200");

    // New deals default to EUR (fresh agent session too).
    const p2 = await openPipelines(browser, agent, pipeline.name);
    await p2.getByRole("button", { name: "Add Deal" }).first().click();
    await expect(selectWithOption(dealSheet(p2, "New Deal"), "USD")).toHaveValue("EUR");
  } finally {
    expect((await api(owner, "PATCH", "/api/deals/default-currency", { currency: "USD" })).status).toBe(200);
  }
});

test("delete a deal, then delete the whole pipeline", async ({ browser }) => {
  const { pipeline, stages } = await createPipelineApi(`Doomed ${run}`, ["S1", "S2"]);
  const keep = await createDealApi(owner, { title: `Survivor ${run}`, pipeline_id: pipeline.id, stage_id: stages[1].id, contact_id: pia.id });
  const title = `Delete deal ${run}`;
  const deal = await createDealApi(agent, { title, pipeline_id: pipeline.id, stage_id: stages[0].id, contact_id: quinn.id });

  const page = await openPipelines(browser, owner, pipeline.name);
  await card(page, title).click();
  const sheet = dealSheet(page, "Edit Deal");
  await sheet.getByRole("button", { name: "Delete Deal" }).click();
  await expect(sheet.getByText("Delete this deal?")).toBeVisible();
  await sheet.getByRole("button", { name: "Cancel" }).last().click();
  await expect(sheet.getByText("Delete this deal?")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Delete Deal" }).click();
  await sheet.getByRole("button", { name: "Confirm" }).click();
  await expect(toast(page, "Deal deleted")).toBeVisible();
  await expect(card(page, title)).toHaveCount(0);
  expect((await dealsOf(pipeline.id)).map((d) => d.id)).toEqual([keep.id]);
  expect((await api(owner, "PATCH", `/api/deals/${deal.id}`, { value: 1 })).status).toBe(404);

  // Delete the pipeline (cascades its stages and deals).
  const manage = await openManage(page);
  await manage.getByRole("button", { name: "Delete Pipeline" }).click();
  await expect(manage.getByText("This will permanently delete all deals in this pipeline. This cannot be undone.")).toBeVisible();
  await manage.getByRole("button", { name: "Cancel" }).click();
  await expect(manage.getByText("Stages")).toBeVisible();
  await manage.getByRole("button", { name: "Delete Pipeline" }).click();
  await manage.getByRole("button", { name: "Delete Pipeline" }).last().click();
  await expect(toast(page, "Pipeline deleted")).toBeVisible();
  await expect(pipelineTrigger(page)).not.toHaveText(pipeline.name);

  await pipelineTrigger(page).click();
  await expect(page.getByRole("menuitem", { name: pipeline.name, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const remaining = (await api(owner, "GET", "/api/pipelines")).body.pipelines as { id: string }[];
  expect(remaining.map((p) => p.id)).not.toContain(pipeline.id);
  expect(await dealsOf(pipeline.id)).toEqual([]);
  expect((await api(owner, "GET", `/api/pipelines/${pipeline.id}/stages`)).body.stages).toEqual([]);
});

// ------------------------------------------------------------
// roles
// ------------------------------------------------------------

test("agent: can work deals but not create or change pipelines", async ({ browser }) => {
  const { pipeline, stages } = await createPipelineApi(`Agent Gate ${run}`, ["X", "Y"]);
  const page = await openPipelines(browser, agent, pipeline.name);
  await page.waitForLoadState("networkidle");

  const addPipeline = page.getByRole("button", { name: "Add Pipeline" });
  await expect(addPipeline).toBeDisabled();
  await expect(addPipeline.locator("..")).toHaveAttribute("title", "Read-only — your role can't create pipelines");
  await expect(page.getByRole("button", { name: "Add Deal" }).first()).toBeEnabled();

  // API: pipeline/stage management is admin+, deals are agent+.
  const denied: [string, string, unknown][] = [
    ["POST", "/api/pipelines", { name: "nope", stages: [] }],
    ["PATCH", `/api/pipelines/${pipeline.id}`, { name: "nope" }],
    ["DELETE", `/api/pipelines/${pipeline.id}`, undefined],
    ["POST", `/api/pipelines/${pipeline.id}/stages`, { name: "nope", color: "#000000", position: 9 }],
    ["PUT", `/api/pipelines/${pipeline.id}/stages`, { stages: stages.map((s) => ({ ...s, name: "nope" })) }],
    ["DELETE", `/api/pipelines/${pipeline.id}/stages/${stages[1].id}`, undefined],
  ];
  for (const [method, p, body] of denied) expect((await api(agent, method, p, body)).status, `${method} ${p}`).toBe(403);
  expect((await stagesOf(pipeline.id)).map((s) => s.name)).toEqual(["X", "Y"]);

  const d = await createDealApi(agent, { title: `Agent deal ${run}`, pipeline_id: pipeline.id, stage_id: stages[0].id, contact_id: pia.id });
  expect((await api(agent, "PATCH", `/api/deals/${d.id}`, { stage_id: stages[1].id })).status).toBe(200);
  expect((await api(agent, "DELETE", `/api/deals/${d.id}`)).status).toBe(200);
});

test("viewer: board is read-only; deal cards can't be dragged", async ({ browser }) => {
  const { pipeline, stages } = await createPipelineApi(`Viewer Gate ${run}`, ["Left", "Right"]);
  const title = `Viewer deal ${run}`;
  const deal = await createDealApi(owner, { title, pipeline_id: pipeline.id, stage_id: stages[0].id, contact_id: pia.id, value: 50 });

  const page = await openPipelines(browser, viewer, pipeline.name);
  await page.waitForLoadState("networkidle");
  const addDeal = page.getByRole("button", { name: "Add Deal" }).first();
  await expect(addDeal).toBeDisabled();
  await expect(addDeal.locator("..")).toHaveAttribute("title", "Read-only — your role can't create deals");
  await expect(page.getByRole("button", { name: "Add Pipeline" })).toBeDisabled();
  await expect(card(page, title)).toContainText("$50");

  await expect(card(page, title)).toHaveAttribute("aria-disabled", "true");
  await drag(page, card(page, title), column(page, "Right").getByText("Drop a deal here"));
  await expect(column(page, "Right").getByText("Drop a deal here")).toBeVisible();
  await expect(column(page, "Left").locator('[aria-roledescription="draggable"]').filter({ hasText: title })).toBeVisible();
  expect((await dealsOf(pipeline.id))[0].stage_id).toBe(stages[0].id);

  const reads = [
    await api(viewer, "GET", "/api/pipelines"),
    await api(viewer, "GET", `/api/pipelines/${pipeline.id}/stages`),
    await api(viewer, "GET", `/api/deals?pipelineId=${pipeline.id}`),
    await api(viewer, "GET", "/api/deals/form-options"),
  ];
  for (const r of reads) expect(r.status).toBe(200);
  const denied: [string, string, unknown][] = [
    ["POST", "/api/deals", { title: "x", pipeline_id: pipeline.id, stage_id: stages[0].id }],
    ["PATCH", `/api/deals/${deal.id}`, { status: "won" }],
    ["DELETE", `/api/deals/${deal.id}`, undefined],
    ["POST", "/api/pipelines", { name: "x" }],
    ["PATCH", "/api/deals/default-currency", { currency: "EUR" }],
  ];
  for (const [method, p, body] of denied) expect((await api(viewer, method, p, body)).status, `${method} ${p}`).toBe(403);
  expect((await dealsOf(pipeline.id))[0].status).toBe("open");
});

test("viewer on an account with no pipelines sees the empty state and can't create one", async ({ browser }) => {
  const fresh = await newOwner("Fresh Owner");
  const freshViewer = await addMember(fresh, "viewer");
  const page = await openPipelines(browser, freshViewer);
  await expect(page.getByRole("heading", { name: "No pipelines yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Pipeline" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add Deal" })).toBeDisabled();
  // The viewer's visit must not have seeded anything.
  expect((await api(fresh, "GET", "/api/pipelines")).body.pipelines).toEqual([]);
});

test("pipeline and deal editors are gated for roles that can't use them", async ({ browser }) => {
  const { pipeline, stages } = await createPipelineApi(`UI Gate ${run}`, ["Only"]);
  const title = `Gated deal ${run}`;
  const deal = await createDealApi(owner, { title, pipeline_id: pipeline.id, stage_id: stages[0].id, contact_id: pia.id, value: 80 });
  expect((await api(owner, "PATCH", `/api/deals/${deal.id}`, { status: "won" })).status).toBe(200);

  // Owner (admin+) sees "Manage Pipelines".
  const ownerPage = await openPipelines(browser, owner, pipeline.name);
  await pipelineTrigger(ownerPage).click();
  await expect(ownerPage.getByRole("menuitem", { name: "Manage Pipelines" })).toBeVisible();
  await ownerPage.keyboard.press("Escape");

  // Agent: no "Manage Pipelines", but every deal write is available.
  const agentPage = await openPipelines(browser, agent, pipeline.name);
  await pipelineTrigger(agentPage).click();
  await expect(agentPage.getByRole("menuitem", { name: pipeline.name, exact: true })).toBeVisible();
  await expect(agentPage.getByRole("menuitem", { name: "Manage Pipelines" })).toHaveCount(0);
  await agentPage.keyboard.press("Escape");
  await expect(column(agentPage, "Only").getByRole("button", { name: "Add Deal" })).toBeEnabled();
  await expect(card(agentPage, title)).not.toHaveAttribute("aria-disabled", "true");
  await card(agentPage, title).click();
  const agentSheet = dealSheet(agentPage, "Edit Deal");
  await expect(agentSheet.getByPlaceholder("Deal title")).toBeEditable();
  await expect(agentSheet.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  await expect(agentSheet.getByRole("button", { name: "Mark as Lost" })).toBeEnabled();
  await expect(agentSheet.getByRole("button", { name: "Reopen deal" })).toBeVisible();
  await expect(agentSheet.getByRole("button", { name: "Delete Deal" })).toBeVisible();

  // Viewer: no "Manage Pipelines", Add Deal disabled, read-only deal sheet.
  const page = await openPipelines(browser, viewer, pipeline.name);
  await pipelineTrigger(page).click();
  await expect(page.getByRole("menuitem", { name: pipeline.name, exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Manage Pipelines" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const addDeal = column(page, "Only").getByRole("button", { name: "Add Deal" });
  await expect(addDeal).toBeDisabled();
  await expect(addDeal.locator("..")).toHaveAttribute("title", "Read-only — your role can't create deals");
  await expect(card(page, title)).toHaveAttribute("aria-disabled", "true");

  // aria-disabled only marks the card as not draggable; a click still opens
  // the (read-only) editor. Playwright treats aria-disabled as "not enabled",
  // so skip its actionability check.
  await card(page, title).click({ force: true });
  const sheet = dealSheet(page, "Edit Deal");
  await expect(sheet.getByPlaceholder("Deal title")).toHaveValue(title);
  await expect(sheet.getByPlaceholder("Deal title")).not.toBeEditable();
  await expect(sheet.getByPlaceholder("0")).not.toBeEditable();
  await expect(sheet.getByPlaceholder("Add notes...")).not.toBeEditable();
  await expect(selectWithOption(sheet, "Select a contact")).toBeDisabled();
  await expect(selectWithOption(sheet, "EUR")).toBeDisabled();
  await expect(selectWithOption(sheet, "Unassigned")).toBeDisabled();
  const save = sheet.getByRole("button", { name: "Save Changes" });
  await expect(save).toBeDisabled();
  await expect(save.locator("..")).toHaveAttribute("title", "Read-only — your role can't edit deals");
  await expect(sheet.getByRole("button", { name: "Mark as Won" })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "Mark as Lost" })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "Reopen deal" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Delete Deal" })).toHaveCount(0);
  expect((await dealsOf(pipeline.id))[0]).toMatchObject({ title, status: "won", value: 80 });
});
