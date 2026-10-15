// Broadcasts (campaigns), driven through the wizard UI against the fake
// Meta Cloud API: audiences (tags + exclusion, custom field, CSV), the
// recipient-count preview, variable mapping, media headers, send-now,
// delivery stats, failures + retry, resume of a stalled campaign,
// replies, drafts, CSV export, delete and role gates.

import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  addMember,
  api,
  connectWhatsApp,
  newOwner,
  pageAs,
  syncTemplates,
  type Connection,
  type TestUser,
} from "../support/accounts";
import {
  createContact,
  createCustomField,
  createTag,
  getBroadcast,
  type SeedContact,
} from "../support/crm-seed";
import { fakes, randomCustomerPhone, type OutboundMessage } from "../support/fakes";

const FIXTURES = path.join(__dirname, "..", "fixtures", "broadcasts");
const FAIL_DELIVERY = "+15550000999"; // accepted, then a failed status webhook (131026)
const REJECT_SEND = "+15550000998"; // rejected synchronously by the send API (131030)

test.describe.configure({ mode: "serial" });

let owner: TestUser;
let wa: Connection;
let vipTag: string;
let churnedTag: string;
let emptyTag: string;
let tierField: string;
let ann: SeedContact; // VIP, Tier=gold
let ben: SeedContact; // VIP + Churned, Tier=silver
let cal: SeedContact; // no tags, Tier=gold

/** Broadcast id of the tag campaign (sent in the "send now" test, reused after). */
let tagBroadcastId: string;
/** The CSV + image-header campaign. */
let csvBroadcastId: string;

test.beforeAll(async () => {
  owner = await newOwner("Bea Broadcaster");
  wa = await connectWhatsApp(owner);
  await syncTemplates(owner);

  vipTag = await createTag(owner, "VIP", "#f59e0b");
  churnedTag = await createTag(owner, "Churned", "#ef4444");
  emptyTag = await createTag(owner, "Nobody", "#3b82f6");
  tierField = await createCustomField(owner, "Tier");

  // Created oldest → newest; the personalize preview shows the newest.
  await createContact(owner, { name: "Fay Faildelivery", phone: FAIL_DELIVERY }, { tagIds: [vipTag] });
  await createContact(owner, { name: "Rex Rejected", phone: REJECT_SEND }, { tagIds: [vipTag] });
  cal = await createContact(owner, { name: "Cal Plain", phone: randomCustomerPhone() }, { custom: { [tierField]: "gold" } });
  ben = await createContact(
    owner,
    { name: "Ben Lapsed", phone: randomCustomerPhone() },
    { tagIds: [vipTag, churnedTag], custom: { [tierField]: "silver" } },
  );
  ann = await createContact(
    owner,
    { name: "Ann Vip", phone: randomCustomerPhone(), email: "ann@e2e.test" },
    { tagIds: [vipTag], custom: { [tierField]: "gold" } },
  );
});

// ------------------------------------------------------------
// Wizard helpers
// ------------------------------------------------------------

const nextButton = (page: Page) => page.getByRole("button", { name: "Next", exact: true });

/** The innermost box that contains `text` (a heading/label inside a card). */
const boxWith = (page: Page, text: string) =>
  page.locator("div").filter({ has: page.getByText(text, { exact: true }) }).last();

/** The "Exclude Tags" card (its title sits in a header row with an icon). */
const excludeBox = (page: Page) => page.getByText("Exclude Tags (Optional)", { exact: true }).locator("xpath=../..");

const estimate = (page: Page) => page.getByText("estimated recipients").locator("..");

async function openWizard(page: Page, template: string) {
  await page.goto("/broadcasts/new");
  await expect(page.getByRole("heading", { name: "Choose a Template" })).toBeVisible();
  await expect(nextButton(page)).toBeDisabled();
  await page.getByRole("button", { name: new RegExp(template) }).click();
  await nextButton(page).click();
  await expect(page.getByRole("heading", { name: "Select Audience" })).toBeVisible();
}

/** Map {{key}} on the personalize step. */
async function mapVariable(
  page: Page,
  key: string,
  mapping: { static: string } | { contact: "Name" | "Phone" | "Email" } | { custom: string },
) {
  const card = page
    .locator("div.rounded-xl")
    .filter({ has: page.getByText(`{{${key}}}`, { exact: true }) });
  const [typeLabel, valueLabel] =
    "static" in mapping
      ? ["Static Value", null]
      : "contact" in mapping
        ? ["Contact Field", mapping.contact]
        : ["Custom Field", mapping.custom];
  if (typeLabel !== "Static Value") {
    await card.getByRole("combobox").first().click();
    await page.getByRole("option", { name: typeLabel, exact: true }).click();
    await card.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: valueLabel!, exact: true }).click();
  } else {
    await card.getByPlaceholder("Enter value...").fill((mapping as { static: string }).static);
  }
}

/** Review step: name it, confirm, send; returns the new broadcast id. */
async function nameAndSend(page: Page, name: string, expectedReach: number): Promise<string> {
  await expect(page.getByRole("heading", { name: "Review & Send" })).toBeVisible();
  const send = page.getByRole("button", { name: "Send Broadcast" });
  await expect(send).toBeDisabled(); // no name yet
  await page.getByPlaceholder("e.g., Summer Promo").fill(name);
  await expect(page.getByText("Estimated Reach").locator("..")).toContainText(String(expectedReach));
  await send.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    `You are about to send this broadcast to ${expectedReach} ${expectedReach === 1 ? "contact" : "contacts"}`,
  );
  await dialog.getByRole("button", { name: "Send Broadcast" }).click();
  await page.waitForURL(/\/broadcasts\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  return page.url().split("/").pop()!;
}

/** The big number on the detail page's stat card labelled `label`. */
const statValue = (page: Page, label: string): Locator =>
  page.locator("p", { hasText: new RegExp(`^${label}$`) }).locator("xpath=preceding-sibling::p[1]");

async function expectStats(page: Page, stats: Partial<Record<"Total Recipients" | "Sent" | "Delivered" | "Read" | "Replied" | "Failed", number>>) {
  for (const [label, value] of Object.entries(stats)) {
    await expect(statValue(page, label), `stat ${label}`).toHaveText(String(value));
  }
}

const recipientRow = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });

const templateParams = (m: OutboundMessage): string[] =>
  (m.body.template?.components ?? [])
    .filter((c: { type: string }) => c.type === "body")
    .flatMap((c: { parameters: { text: string }[] }) => c.parameters.map((p) => p.text));

// ------------------------------------------------------------
// Tests
// ------------------------------------------------------------

test("wizard validation: template, audience and variable gates", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await page.goto("/broadcasts");
  await expect(page.getByRole("heading", { name: "Broadcasts" })).toBeVisible();
  await expect(page.getByText("No broadcasts yet")).toBeVisible();
  await page.getByRole("button", { name: "New Broadcast" }).first().click();
  await expect(page).toHaveURL(/\/broadcasts\/new$/);

  // Only APPROVED templates are offered.
  for (const name of ["order_update", "promo_image", "appointment_confirm"]) {
    await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  }
  await expect(nextButton(page)).toBeDisabled();
  await page.getByRole("button", { name: /order_update/ }).click();
  await nextButton(page).click();

  // "All Contacts" is the default and counts everyone.
  await expect(estimate(page)).toContainText("5");
  // Tags selected → Next blocked until a tag is picked.
  await page.getByRole("button", { name: /Filter by Tags/ }).click();
  await expect(nextButton(page)).toBeDisabled();
  await boxWith(page, "Select Tags").getByRole("button", { name: "Nobody" }).click();
  await expect(estimate(page)).toContainText("0");
  await expect(nextButton(page)).toBeEnabled();
  await nextButton(page).click();

  // Personalize: both placeholders must be mapped.
  await expect(page.getByRole("heading", { name: "Personalize Variables" })).toBeVisible();
  await expect(page.getByText(/Map every placeholder before continuing/)).toContainText("{{1}}, {{2}}");
  await expect(nextButton(page)).toBeDisabled();
  await mapVariable(page, "1", { static: "Friend" });
  await expect(page.getByText(/Map every placeholder before continuing/)).toContainText("{{2}}");
  await mapVariable(page, "2", { static: "#1" });
  await expect(page.getByText(/Map every placeholder/)).toHaveCount(0);
  // Live preview substitutes the static values.
  await expect(page.getByText("Hi Friend, your order #1 has shipped!")).toBeVisible();
  await nextButton(page).click();

  // An audience that resolves to nobody is refused with a clear message.
  await page.getByPlaceholder("e.g., Summer Promo").fill("Nobody campaign");
  await page.getByRole("button", { name: "Send Broadcast" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send Broadcast" }).click();
  await expect(page.getByText("No contacts found for this audience.")).toBeVisible();
  await expect(page).toHaveURL(/\/broadcasts\/new$/);

  // Back navigation keeps earlier choices.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Personalize Variables" })).toBeVisible();
  await expect(page.getByPlaceholder("Enter value...").first()).toHaveValue("Friend");

  const list = await api(owner, "GET", "/api/broadcasts");
  expect(list.body.broadcasts).toHaveLength(0);
  const count = await api(owner, "POST", "/api/broadcasts/audience-count", { audience: { type: "tags", tagIds: [emptyTag] } });
  expect(count.body.count).toBe(0);
});

test("tag audience with an excluded tag: count preview, per-contact variables, send now, stats", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await openWizard(page, "order_update");

  await page.getByRole("button", { name: /Filter by Tags/ }).click();
  await boxWith(page, "Select Tags").getByRole("button", { name: "VIP" }).click();
  // VIP = Ann, Ben, Fay, Rex.
  await expect(estimate(page)).toContainText("4");
  await excludeBox(page).getByRole("button", { name: "Churned" }).click();
  // …minus Ben (Churned).
  await expect(estimate(page)).toContainText("3");
  await nextButton(page).click();

  await mapVariable(page, "1", { contact: "Name" });
  await mapVariable(page, "2", { static: "#ORD-42" });
  // Preview renders against the newest contact (Ann).
  await expect(page.getByText("Hi Ann Vip, your order #ORD-42 has shipped!")).toBeVisible();
  await nextButton(page).click();
  await expect(page.getByText("Filtered by tags")).toBeVisible();

  tagBroadcastId = await nameAndSend(page, "VIP order update", 3);

  // The fake Meta got one template per recipient that it accepted, each
  // with that contact's own {{1}}.
  const [toAnn] = await fakes.waitForOutbound({ to: ann.phone, phoneNumberId: wa.phoneNumberId }, (m) => m.type === "template");
  expect(toAnn.body.template.name).toBe("order_update");
  expect(templateParams(toAnn)).toEqual(["Ann Vip", "#ORD-42"]);
  const [toFay] = await fakes.waitForOutbound({ to: FAIL_DELIVERY, phoneNumberId: wa.phoneNumberId }, (m) => m.type === "template");
  expect(templateParams(toFay)).toEqual(["Fay Faildelivery", "#ORD-42"]);
  // Rex was rejected by the send API; Ben was excluded.
  expect(await fakes.outbound({ to: REJECT_SEND, phoneNumberId: wa.phoneNumberId })).toHaveLength(0);
  expect(await fakes.outbound({ to: ben.phone, phoneNumberId: wa.phoneNumberId })).toHaveLength(0);

  // Statuses settle: Ann delivered, Fay failed (status webhook), Rex failed (rejected).
  await expect
    .poll(async () => {
      const { broadcast, recipients } = await getBroadcast(owner, tagBroadcastId);
      return {
        status: broadcast.status,
        total: broadcast.total_recipients,
        sent: broadcast.sent_count,
        delivered: broadcast.delivered_count,
        failed: broadcast.failed_count,
        byName: Object.fromEntries(recipients.map((r) => [r.contact?.name, r.status])),
      };
    }, { timeout: 30_000 })
    .toEqual({
      status: "sent",
      total: 3,
      sent: 1,
      delivered: 1,
      failed: 2,
      byName: { "Ann Vip": "delivered", "Fay Faildelivery": "failed", "Rex Rejected": "failed" },
    });
  const { recipients } = await getBroadcast(owner, tagBroadcastId);
  expect(recipients.find((r) => r.contact?.name === "Ann Vip")?.template_params).toEqual(["Ann Vip", "#ORD-42"]);

  // The detail page shows it.
  await page.reload();
  await expect(page.getByRole("heading", { name: "VIP order update" })).toBeVisible();
  await expect(page.getByText("Template: order_update")).toBeVisible();
  await expectStats(page, { "Total Recipients": 3, Sent: 1, Delivered: 1, Read: 0, Replied: 0, Failed: 2 });
  await expect(page.getByRole("heading", { name: "Recipients (3)" })).toBeVisible();
  await expect(recipientRow(page, "Ann Vip")).toContainText("Delivered");
  await expect(recipientRow(page, "Fay Faildelivery")).toContainText("Failed");
  await expect(recipientRow(page, "Fay Faildelivery")).toContainText(/undeliverable|131026/i);
  await expect(recipientRow(page, "Rex Rejected")).toContainText("Failed");
  await expect(recipientRow(page, "Rex Rejected")).toContainText(/131030|not in allowed list/i);

  // Filter the table by status.
  await page.getByRole("button", { name: "All statuses" }).click();
  await page.getByRole("menuitem", { name: "Failed" }).click();
  await expect(page.getByRole("heading", { name: "Recipients (2 of 3)" })).toBeVisible();
  await expect(recipientRow(page, "Ann Vip")).toHaveCount(0);

  // The list page shows the campaign with its numbers.
  await page.goto("/broadcasts");
  const row = page.getByRole("row").filter({ hasText: "VIP order update" });
  await expect(row).toContainText("order_update");
  await expect(row).toContainText("3");
  await expect(row).toContainText("Sent");
});

test("retry failed recipients re-sends them from the server", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await page.goto(`/broadcasts/${tagBroadcastId}`);
  await expect(page.getByText("Some recipients need another attempt")).toBeVisible();
  await expect(page.getByText("2 recipients failed.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume sending/ })).toHaveCount(0);

  const before = (await fakes.outbound({ to: FAIL_DELIVERY, phoneNumberId: wa.phoneNumberId })).length;
  await page.getByRole("button", { name: "Retry failed (2)" }).click();
  await expect(page.getByText("Sending 2 recipients in the background.")).toBeVisible();

  // Fay is attempted again with the same frozen params…
  const again = await fakes.waitForOutbound(
    { to: FAIL_DELIVERY, phoneNumberId: wa.phoneNumberId },
    (m) => m.type === "template",
    before + 1,
  );
  expect(templateParams(again[again.length - 1])).toEqual(["Fay Faildelivery", "#ORD-42"]);
  // …and both fail again, so the campaign ends with the same tallies.
  await expect
    .poll(async () => {
      const { broadcast } = await getBroadcast(owner, tagBroadcastId);
      return [broadcast.status, broadcast.sent_count, broadcast.failed_count];
    }, { timeout: 30_000 })
    .toEqual(["sent", 1, 2]);
  // Ann (already delivered) was not messaged twice.
  expect(await fakes.outbound({ to: ann.phone, phoneNumberId: wa.phoneNumberId })).toHaveLength(1);

  // A second retry while nothing is running is accepted again (the lock was released).
  const retry = await api(owner, "POST", `/api/whatsapp/broadcast/${tagBroadcastId}/resume`, { scope: "failed" });
  expect(retry.status).toBe(202);
  expect(retry.body.resuming).toBe(2);
});

test("a customer reply marks that recipient as replied", async ({ browser }) => {
  await fakes.inbound({ from: ann.phone, name: "Ann Vip", phone_number_id: wa.phoneNumberId, text: "Thanks, got it!" });
  await expect
    .poll(async () => {
      const { broadcast, recipients } = await getBroadcast(owner, tagBroadcastId);
      return [broadcast.replied_count, recipients.find((r) => r.contact?.name === "Ann Vip")?.status];
    }, { timeout: 20_000 })
    .toEqual([1, "replied"]);

  const { page } = await pageAs(browser, owner);
  await page.goto(`/broadcasts/${tagBroadcastId}`);
  await expectStats(page, { Replied: 1, Read: 1, Delivered: 1, Sent: 1 });
  await expect(recipientRow(page, "Ann Vip")).toContainText("Replied");
});

test("custom-field audience with a custom-field variable", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await openWizard(page, "order_update");

  await page.getByRole("button", { name: /Custom Field/ }).click();
  const box = boxWith(page, "Custom Field");
  await expect(nextButton(page)).toBeDisabled();
  await box.locator("select").first().selectOption({ label: "Tier" });
  await box.getByPlaceholder("Value to match").fill("gold");
  await expect(estimate(page)).toContainText("2"); // Ann + Cal
  await box.locator("select").nth(1).selectOption({ label: "Is not" });
  await expect(estimate(page)).toContainText("1"); // Ben
  await box.locator("select").nth(1).selectOption({ label: "Contains" });
  await box.getByPlaceholder("Value to match").fill("l"); // gold, gold, silver
  await expect(estimate(page)).toContainText("3");
  await box.locator("select").nth(1).selectOption({ label: "Is" });
  await box.getByPlaceholder("Value to match").fill("gold");
  await expect(estimate(page)).toContainText("2");
  await nextButton(page).click();

  await mapVariable(page, "1", { contact: "Name" });
  await mapVariable(page, "2", { custom: "Tier" });
  // Ann is the preview contact; her Tier is gold.
  await expect(page.getByText("Hi Ann Vip, your order gold has shipped!")).toBeVisible();
  await nextButton(page).click();
  await expect(page.getByText("Filtered by custom field")).toBeVisible();

  const id = await nameAndSend(page, "Gold tier", 2);
  const [toCal] = await fakes.waitForOutbound({ to: cal.phone, phoneNumberId: wa.phoneNumberId }, (m) => m.type === "template");
  expect(templateParams(toCal)).toEqual(["Cal Plain", "gold"]);
  const annSends = await fakes.waitForOutbound({ to: ann.phone, phoneNumberId: wa.phoneNumberId }, (m) => m.type === "template", 2);
  expect(templateParams(annSends[annSends.length - 1])).toEqual(["Ann Vip", "gold"]);
  expect(await fakes.outbound({ to: ben.phone, phoneNumberId: wa.phoneNumberId })).toHaveLength(0);

  await expect
    .poll(async () => {
      const { broadcast } = await getBroadcast(owner, id);
      return [broadcast.status, broadcast.total_recipients, broadcast.delivered_count, broadcast.failed_count];
    }, { timeout: 30_000 })
    .toEqual(["sent", 2, 2, 0]);
  await page.reload();
  await expectStats(page, { "Total Recipients": 2, Sent: 2, Delivered: 2, Failed: 0 });
  // Nothing failed → no retry panel.
  await expect(page.getByText("Some recipients need another attempt")).toHaveCount(0);
});

test("CSV audience + image header (promo_image): uploads, validates and sends with the image URL", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await openWizard(page, "promo_image");
  await page.getByRole("button", { name: /Upload CSV/ }).first().click();
  await expect(nextButton(page)).toBeDisabled();

  // A file without a phone column is refused.
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(path.join(FIXTURES, "no-phone-column.csv"));
  await expect(page.getByText("CSV must have a 'phone' column.")).toBeVisible();
  await expect(nextButton(page)).toBeDisabled();

  // The real file: 2 valid rows, a duplicate and a national-format number.
  await fileInput.setInputFiles(path.join(FIXTURES, "audience.csv"));
  await expect(page.getByText("1 row(s) skipped: phone numbers must start with + and a country code")).toBeVisible();
  await expect(page.getByText("3 valid contact(s) found in CSV.")).toBeVisible();
  await expect(page.getByText("audience.csv")).toBeVisible();
  await expect(estimate(page)).toContainText("3");
  await nextButton(page).click();

  // Media header: required, must be an http(s) URL, previewed when valid.
  await expect(page.getByText("Header Image", { exact: true })).toBeVisible();
  const url = page.getByPlaceholder("https://example.com/image.jpg");
  await expect(url).toHaveValue("");
  await expect(page.getByText("A media URL is required to send this template.")).toBeVisible();
  await mapVariable(page, "1", { contact: "Name" });
  await mapVariable(page, "2", { static: "30%" });
  await expect(nextButton(page)).toBeDisabled();
  await url.fill("not a url");
  await expect(page.getByText("Enter a valid http(s) URL.")).toBeVisible();
  await expect(nextButton(page)).toBeDisabled();
  const imageUrl = "https://cdn.example.com/e2e/promo-banner.png";
  await url.fill(imageUrl);
  await expect(page.getByRole("img", { name: "Header preview" })).toHaveAttribute("src", imageUrl);
  await expect(nextButton(page)).toBeEnabled();
  await nextButton(page).click();
  await expect(page.getByText("CSV upload")).toBeVisible();

  csvBroadcastId = await nameAndSend(page, "CSV promo", 3);
  const id = csvBroadcastId;

  const csvRows = [
    { phone: "+15553010001", name: "Csv Carla" },
    { phone: "+15553010002", name: "Csv Dan" },
  ];
  for (const r of csvRows) {
    const [m] = await fakes.waitForOutbound({ to: r.phone, phoneNumberId: wa.phoneNumberId }, (x) => x.type === "template");
    expect(m.body.template.name).toBe("promo_image");
    const header = m.body.template.components.find((c: { type: string }) => c.type === "header");
    expect(header.parameters[0]).toEqual({ type: "image", image: { link: imageUrl } });
    expect(templateParams(m)).toEqual([r.name, "30%"]);
  }

  // CSV numbers the account lacked became contacts.
  const contacts = await api(owner, "GET", "/api/contacts?page=0&pageSize=50&search=Csv");
  expect(contacts.body.contacts.map((c: { name: string }) => c.name).sort()).toEqual(["Csv Carla", "Csv Dan"]);
  // +15550000999 was already a contact (Fay): reused, not duplicated.
  const fays = await api(owner, "GET", "/api/contacts?page=0&pageSize=50&search=0000999");
  expect(fays.body.contacts).toHaveLength(1);

  await expect
    .poll(async () => {
      const { broadcast } = await getBroadcast(owner, id);
      return [broadcast.delivered_count, broadcast.failed_count];
    }, { timeout: 30_000 })
    .toEqual([2, 1]);
  // The wizard's header URL is stored on the campaign (used by retry/resume).
  const stored = (await api(owner, "GET", `/api/broadcasts/${id}`)).body.broadcast as { header_media_url?: string | null };
  expect(stored.header_media_url).toBe(imageUrl);
});

test("retrying a failed image-header recipient re-sends the header image", async () => {
  const before = (await fakes.outbound({ to: FAIL_DELIVERY, phoneNumberId: wa.phoneNumberId })).length;
  const retry = await api(owner, "POST", `/api/whatsapp/broadcast/${csvBroadcastId}/resume`, { scope: "failed" });
  expect(retry.status).toBe(202);
  expect(retry.body.resuming).toBe(1);
  await expect
    .poll(async () => (await getBroadcast(owner, csvBroadcastId)).broadcast.status, { timeout: 30_000 })
    .toBe("sent");
  const { recipients } = await getBroadcast(owner, csvBroadcastId);
  const fay = recipients.find((r) => r.contact?.phone === FAIL_DELIVERY)!;
  expect(fay.error_message ?? "").not.toMatch(/media|header/i);
  const sends = await fakes.waitForOutbound({ to: FAIL_DELIVERY, phoneNumberId: wa.phoneNumberId }, (m) => m.type === "template", before + 1);
  const last = sends[sends.length - 1];
  expect(last.body.template.name).toBe("promo_image");
  const header = last.body.template.components.find((c: { type: string }) => c.type === "header");
  expect(header.parameters[0]).toEqual({ type: "image", image: { link: "https://cdn.example.com/e2e/promo-banner.png" } });
});

test("save as draft, then reopen it", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await openWizard(page, "appointment_confirm");
  await nextButton(page).click(); // all contacts
  // No variables and no media header → nothing to map.
  await expect(page.getByText("Preview not available.")).toBeVisible();
  await expect(page.getByText("Can you make it to your appointment tomorrow?").first()).toBeVisible();
  await nextButton(page).click();

  const draft = page.getByRole("button", { name: "Save as Draft" });
  await expect(draft).toBeDisabled();
  await page.getByPlaceholder("e.g., Summer Promo").fill("Appointment reminder draft");
  await draft.click();
  await expect(page.getByText("Draft saved")).toBeVisible();
  await expect(page).toHaveURL(/\/broadcasts$/);

  const row = page.getByRole("row").filter({ hasText: "Appointment reminder draft" });
  await expect(row).toContainText("Draft");
  await expect(row).toContainText("appointment_confirm");
  // Nothing was sent.
  const list = await api(owner, "GET", "/api/broadcasts");
  const saved = list.body.broadcasts.find((b: { name: string }) => b.name === "Appointment reminder draft");
  expect(saved).toMatchObject({ status: "draft", total_recipients: 0 });

  await row.click();
  await expect(page.getByRole("heading", { name: "Appointment reminder draft" })).toBeVisible();
  await expect(page.getByText("No recipients found.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeDisabled();
});

test("GAP: a saved draft can be edited and sent", async () => {
  test.fixme(true, "GAP: drafts cannot be reopened in the wizard — the detail page has no Edit/Send action (new/page.tsx: 'A full resume-draft UX is a future polish')");
});

test("export results as CSV", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await page.goto(`/broadcasts/${tagBroadcastId}`);
  await expect(page.getByRole("heading", { name: "VIP order update" })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  expect(download.suggestedFilename()).toBe(`broadcast-vip-order-update-${tagBroadcastId.slice(0, 8)}.csv`);
  const csv = readFileSync((await download.path())!, "utf8");
  const lines = csv.split("\n");
  expect(lines[0]).toBe('"Contact","Phone","Status","Sent","Delivered","Read","Error"');
  expect(lines).toHaveLength(4);
  const byName = Object.fromEntries(lines.slice(1).map((l) => [l.split('","')[0].replace(/^"/, ""), l]));
  expect(byName["Ann Vip"]).toContain(`"${ann.phone}","replied"`);
  expect(byName["Fay Faildelivery"]).toContain(`"${FAIL_DELIVERY}","failed"`);
  expect(byName["Rex Rejected"]).toContain(`"${REJECT_SEND}","failed"`);
  expect(byName["Rex Rejected"]).toMatch(/131030|allowed list/i);
});

test("a stalled campaign: delete is blocked while sending, Resume finishes it, then it can be deleted", async ({ browser }) => {
  // A campaign whose browser tab went away mid-send: created (status
  // 'sending', recipients pending) but never fanned out.
  const created = await api(owner, "POST", "/api/broadcasts", {
    name: "Stalled campaign",
    template_name: "order_update",
    template_language: "en_US",
    template_variables: { "1": { type: "field", value: "name" }, "2": { type: "static", value: "#STALL" } },
    audience: { type: "custom_field", customField: { fieldId: tierField, operator: "is", value: "silver" } },
  });
  expect(created.status).toBe(201);
  const id = created.body.broadcast.id as string;
  expect(created.body.recipients).toHaveLength(1); // Ben

  const { page } = await pageAs(browser, owner);
  await page.goto(`/broadcasts/${id}`);
  await expect(page.getByText("Sending", { exact: true })).toBeVisible();
  await expect(page.getByText("This campaign stopped part-way")).toBeVisible();
  const del = page.getByRole("button", { name: "Delete" });
  await expect(del).toBeDisabled();
  await expect(del).toHaveAttribute("title", "Cannot delete while a broadcast is actively sending");
  await expect(recipientRow(page, "Ben Lapsed")).toContainText("Pending");

  await page.getByRole("button", { name: "Resume sending (1)" }).click();
  await expect(page.getByText("Sending 1 recipients in the background.")).toBeVisible();
  const [toBen] = await fakes.waitForOutbound({ to: ben.phone, phoneNumberId: wa.phoneNumberId }, (m) => m.type === "template");
  expect(templateParams(toBen)).toEqual(["Ben Lapsed", "#STALL"]);
  await expect
    .poll(async () => {
      const { broadcast } = await getBroadcast(owner, id);
      return [broadcast.status, broadcast.delivered_count];
    }, { timeout: 30_000 })
    .toEqual(["sent", 1]);

  // Nothing left to resume.
  const again = await api(owner, "POST", `/api/whatsapp/broadcast/${id}/resume`, { scope: "pending" });
  expect(again.status).toBe(400);

  await page.reload();
  await expect(page.getByText("This campaign stopped part-way")).toHaveCount(0);
  await expect(del).toBeEnabled();
  await del.click();
  await expect(page.getByText("Delete this broadcast?")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Delete this broadcast?")).toHaveCount(0);
  await del.click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Broadcast deleted")).toBeVisible();
  await expect(page).toHaveURL(/\/broadcasts$/);
  await expect(page.getByRole("row").filter({ hasText: "Stalled campaign" })).toHaveCount(0);
  expect((await api(owner, "GET", `/api/broadcasts/${id}`)).status).toBe(404);
});

test("the API refuses to delete a broadcast that is still sending", async () => {
  const created = await api(owner, "POST", "/api/broadcasts", {
    name: "Still sending",
    template_name: "order_update",
    template_variables: { "1": { type: "static", value: "x" }, "2": { type: "static", value: "y" } },
    audience: { type: "tags", tagIds: [churnedTag] },
  });
  expect(created.status).toBe(201);
  expect(created.body.broadcast.status).toBe("sending");
  const del = await api(owner, "DELETE", `/api/broadcasts/${created.body.broadcast.id}`);
  expect(del.status).toBe(409);
  expect((await api(owner, "GET", `/api/broadcasts/${created.body.broadcast.id}`)).status).toBe(200);
});

test("role gates: viewers can look but not create, send, resume or delete; agents can run campaigns", async ({ browser }) => {
  const viewer = await addMember(owner, "viewer");
  const agent = await addMember(owner, "agent");

  const { page } = await pageAs(browser, viewer);
  await page.goto("/broadcasts");
  await expect(page.getByRole("row").filter({ hasText: "VIP order update" })).toBeVisible();
  const create = page.getByRole("button", { name: "New Broadcast" });
  await expect(create).toBeDisabled();
  await expect(page.locator('span[title="Read-only — your role can\'t create broadcasts"]')).toBeVisible();

  // Viewers can read…
  expect((await api(viewer, "GET", "/api/broadcasts")).status).toBe(200);
  expect((await api(viewer, "GET", `/api/broadcasts/${tagBroadcastId}`)).status).toBe(200);
  expect((await api(viewer, "POST", "/api/broadcasts/audience-count", { audience: { type: "all" } })).body.count).toBe(7); // 5 seeded + 2 new from the CSV
  // …but every write is refused.
  const body = {
    name: "Viewer blast",
    template_name: "order_update",
    template_variables: {},
    audience: { type: "all" },
  };
  expect((await api(viewer, "POST", "/api/broadcasts", body)).status).toBe(403);
  expect((await api(viewer, "POST", "/api/broadcasts", { ...body, draft: true })).status).toBe(403);
  expect(
    (
      await api(viewer, "POST", "/api/whatsapp/broadcast", {
        recipients: [{ phone: ann.phone, params: ["a", "b"] }],
        template_name: "order_update",
      })
    ).status,
  ).toBe(403);
  expect((await api(viewer, "POST", `/api/whatsapp/broadcast/${tagBroadcastId}/resume`, { scope: "failed" })).status).toBe(403);
  expect((await api(viewer, "PATCH", `/api/broadcasts/${tagBroadcastId}`, { status: "failed" })).status).toBe(403);
  expect((await api(viewer, "DELETE", `/api/broadcasts/${tagBroadcastId}`)).status).toBe(403);
  expect((await api(owner, "GET", `/api/broadcasts/${tagBroadcastId}`)).status).toBe(200);

  // An agent can run a campaign end to end through the wizard.
  const agentPage = (await pageAs(browser, agent)).page;
  await agentPage.goto("/broadcasts");
  await expect(agentPage.getByRole("button", { name: "New Broadcast" })).toBeEnabled();
  await openWizard(agentPage, "appointment_confirm");
  await agentPage.getByRole("button", { name: /Filter by Tags/ }).click();
  await boxWith(agentPage, "Select Tags").getByRole("button", { name: "Churned" }).click();
  await expect(estimate(agentPage)).toContainText("1");
  await nextButton(agentPage).click();
  await nextButton(agentPage).click();
  await nameAndSend(agentPage, "Agent check-in", 1);
  await fakes.waitForOutbound(
    { to: ben.phone, phoneNumberId: wa.phoneNumberId },
    (m) => m.type === "template" && m.body.template.name === "appointment_confirm",
  );

  // Another account cannot see this account's campaigns.
  const stranger = await newOwner("Stranger");
  expect((await api(stranger, "GET", `/api/broadcasts/${tagBroadcastId}`)).status).toBe(404);
  await api(stranger, "DELETE", `/api/broadcasts/${tagBroadcastId}`);
  expect((await api(owner, "GET", `/api/broadcasts/${tagBroadcastId}`)).status).toBe(200);
});

test("GAP: schedule a broadcast for later", async () => {
  test.fixme(true, "GAP: broadcasts have no scheduling — the 'Review & Send' step only offers Send now / Save as draft");
});
