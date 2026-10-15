// Helpers for the automation specs (08*). Builds on accounts/fakes; never
// edits shared support files.

import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { api, connectWhatsApp, newOwner, sql, type Connection, type TestUser } from "./accounts";
import { fakes, type InboundInput, type OutboundMessage } from "./fakes";

export const digits = (s: string) => s.replace(/\D/g, "");

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = Record<string, any>;

export interface AutomationEnv {
  owner: TestUser;
  wa: Connection;
  /** Name of the fake webhook receiver subscribed to `message.received`. */
  barrier: string;
}

/**
 * A fresh owner with a fake WhatsApp number and a `message.received`
 * webhook endpoint. The app emits `message.received` as the very last
 * step of inbound processing (after every automation dispatch), so a
 * delivery for a given inbound is a reliable "the app is done with this
 * message" barrier — that's what lets specs assert that something did
 * NOT happen.
 */
export async function automationEnv(ownerName = "Olivia Owner"): Promise<AutomationEnv> {
  const owner = await newOwner(ownerName);
  const wa = await connectWhatsApp(owner);
  const barrier = await subscribeBarrier(owner);
  return { owner, wa, barrier };
}

export async function subscribeBarrier(owner: TestUser): Promise<string> {
  const barrier = `auto08${randomUUID().slice(0, 8)}`;
  const key = await api(owner, "POST", "/api/account/api-keys", { name: "e2e barrier", scopes: ["webhooks:manage"] });
  expect(key.status, JSON.stringify(key.body)).toBeLessThan(300);
  const hook = await api(
    null,
    "POST",
    "/api/v1/webhooks",
    { url: fakes.hookUrl(barrier), events: ["message.received"] },
    { authorization: `Bearer ${key.body.plaintext}` },
  );
  expect(hook.status, JSON.stringify(hook.body)).toBeLessThan(300);
  return barrier;
}

/** Customer sends a message; resolves once the app finished processing it. */
export async function inboundSettled(env: AutomationEnv, input: Omit<InboundInput, "phone_number_id">) {
  const r = await fakes.inbound({ ...input, phone_number_id: env.wa.phoneNumberId });
  await fakes.waitForHooks(env.barrier, (h) => h.body?.data?.whatsapp_message_id === r.id, 1, 30_000);
  return r;
}

export async function createAutomation(user: TestUser, body: Json): Promise<Json> {
  const r = await api(user, "POST", "/api/automations", body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.automation;
}

export async function getAutomation(user: TestUser, id: string): Promise<{ automation: Json; steps: Json[] }> {
  const r = await api(user, "GET", `/api/automations/${id}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

export async function logsOf(user: TestUser, id: string): Promise<Json[]> {
  const r = await api(user, "GET", `/api/automations/${id}/logs`);
  expect(r.status).toBe(200);
  return r.body.logs;
}

/** Poll an automation's logs until `predicate` holds for at least `count` rows. */
export async function waitForLogs(
  user: TestUser,
  id: string,
  predicate: (l: Json) => boolean = () => true,
  count = 1,
  timeout = 20_000,
): Promise<Json[]> {
  let found: Json[] = [];
  await expect
    .poll(
      async () => {
        found = (await logsOf(user, id)).filter(predicate);
        return found.length;
      },
      { timeout, message: `waiting for ${count} automation log(s)` },
    )
    .toBeGreaterThanOrEqual(count);
  return found;
}

/** The If/Else entry's detail ("branch=yes"/"branch=no") of a run log. */
export const conditionDetail = (log: Json): string | undefined =>
  (log.steps_executed as Json[]).find((s) => s.step_type === "condition")?.detail;

export async function conversationFor(user: TestUser, phone: string): Promise<Json | undefined> {
  const r = await api(user, "GET", "/api/conversations");
  return (r.body.conversations as Json[]).find((c) => digits(c.contact?.phone ?? "") === digits(phone));
}

export async function contactFor(user: TestUser, phone: string): Promise<Json> {
  const conv = await conversationFor(user, phone);
  if (conv) return conv.contact;
  const r = await api(user, "GET", `/api/contacts?search=${digits(phone)}`);
  const c = (r.body.contacts as Json[] | undefined)?.find((x) => digits(x.phone ?? "") === digits(phone));
  if (!c) throw new Error(`no contact for ${phone}`);
  return c;
}

export async function contactDetail(user: TestUser, contactId: string): Promise<Json> {
  const r = await api(user, "GET", `/api/contacts/${contactId}`);
  expect(r.status).toBe(200);
  return r.body;
}

export async function createTag(user: TestUser, name: string, color = "#22c55e"): Promise<Json> {
  const r = await api(user, "POST", "/api/tags", { name, color });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.tag;
}

/** Outbound messages to `phone` from this env's business number. */
export function sentTo(env: AutomationEnv, phone: string): Promise<OutboundMessage[]> {
  return fakes.outbound({ to: phone, phoneNumberId: env.wa.phoneNumberId });
}

export const textsOf = (msgs: OutboundMessage[]) => msgs.filter((m) => m.type === "text").map((m) => m.body.text.body as string);

export async function waitForText(env: AutomationEnv, phone: string, text: string | RegExp, count = 1) {
  return fakes.waitForOutbound(
    { to: phone, phoneNumberId: env.wa.phoneNumberId },
    (m) => m.type === "text" && (typeof text === "string" ? m.body.text.body === text : text.test(m.body.text.body)),
    count,
  );
}

// ------------------------------------------------------------
// Builder UI
// ------------------------------------------------------------

/** The control rendered right after a builder field label (labels aren't
 *  associated with their inputs, so `getByLabel` can't find them). */
export function fieldControl(scope: Page | Locator, label: string): Locator {
  return scope
    .locator(`xpath=.//label[normalize-space(.)=${JSON.stringify(label)}]/following-sibling::*[1]`)
    .locator("xpath=descendant-or-self::*[self::select or self::input or self::textarea][1]");
}

export async function openTriggerCard(page: Page) {
  const triggerType = fieldControl(page, "Trigger type");
  if (!(await triggerType.isVisible())) await page.getByRole("button", { name: /^Trigger/ }).click();
  await expect(triggerType).toBeVisible();
}

export async function closeTriggerCard(page: Page) {
  if (await fieldControl(page, "Trigger type").isVisible()) await page.getByRole("button", { name: /^Trigger/ }).click();
}

export async function setTrigger(page: Page, label: string) {
  await openTriggerCard(page);
  await fieldControl(page, "Trigger type").selectOption({ label });
}

/** Pick a step type from an "Add step" (+) connector. `which` = index among
 *  all + buttons on the canvas, or "last" to append at the end of the root. */
export async function addStep(page: Page, stepLabel: string, which: number | "last" | Locator = "last") {
  const plus =
    typeof which === "object"
      ? which
      : which === "last"
        ? page.getByRole("button", { name: "Add step" }).last()
        : page.getByRole("button", { name: "Add step" }).nth(which);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await plus.click();
  await page.getByRole("menu").getByRole("menuitem", { name: stepLabel, exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}

/** The Yes / No column of the (only) condition on the canvas. */
export function branch(page: Page, which: "Yes" | "No"): Locator {
  return page.locator(`xpath=//div[contains(@class,"mb-2") and normalize-space(text())="${which}"]/..`).first();
}

/** Save the builder; returns the automation id (creating redirects to /edit). */
export async function saveBuilder(page: Page, expectToast: string | RegExp = /Automation (created|saved)/): Promise<string> {
  const isNew = page.url().includes("/automations/new");
  await clearToasts(page);
  await page.getByRole("button", { name: isNew ? "Save Draft" : "Save", exact: true }).click();
  await expect(page.getByText(expectToast).first()).toBeVisible();
  if (isNew) await page.waitForURL(/\/automations\/[0-9a-f-]{36}\/edit/);
  return /automations\/([0-9a-f-]{36})\/edit/.exec(page.url())![1];
}

/** Wait out any visible toast (they sit over the builder's Save button, and
 *  a stale "saved" toast would satisfy the next assertion). */
export async function clearToasts(page: Page) {
  await page.mouse.move(5, 400); // hovering a toast pauses its timer
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 15_000 });
}

export async function setName(page: Page, name: string) {
  await page.getByPlaceholder("Untitled automation").fill(name);
}

export async function setActive(page: Page, on: boolean) {
  const sw = page.getByRole("switch", { name: "Active" });
  if ((await sw.getAttribute("aria-checked")) !== String(on)) await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", String(on));
}

/** Expand a step card on the canvas by its step label (e.g. "Send Message").
 *  No-op when it's already open (a freshly added step opens itself). */
export async function expandStep(page: Page, stepLabel: string, nth = 0): Promise<Locator> {
  const header = page.getByRole("button", { name: new RegExp(`^(Action|Wait|Condition)\\s*${escapeRe(stepLabel)}`) }).nth(nth);
  const cardBox = header.locator("xpath=..");
  const del = cardBox.locator("xpath=./div").getByRole("button", { name: "Delete", exact: true });
  if (!(await del.isVisible())) await header.click();
  await expect(del).toBeVisible();
  return cardBox;
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Backdate an automation's parked runs so the cron treats them as due. */
export function backdatePending(automationId: string, status: "pending" | "awaiting_reply" = "pending"): string {
  if (!/^[0-9a-f-]{36}$/.test(automationId)) throw new Error("bad id");
  return sql(
    `UPDATE automation_pending_executions SET run_at = now() - interval '1 minute' WHERE automation_id = '${automationId}' AND status = '${status}' RETURNING id`,
  );
}

/** Statuses of an automation's parked runs, oldest first. */
export function pendingStatuses(automationId: string): string[] {
  if (!/^[0-9a-f-]{36}$/.test(automationId)) throw new Error("bad id");
  const out = sql(`SELECT status FROM automation_pending_executions WHERE automation_id = '${automationId}' ORDER BY created_at`);
  return out ? out.split("\n") : [];
}
