// Contacts: CRUD, duplicate detection, phone validation, tags, custom
// fields, notes, CSV import (admin vs agent), search / pagination / bulk
// delete, sending a template from the contact detail sheet, and the
// viewer's read-only role — all driven through /contacts.

import path from "node:path";

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

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
import { fakes, randomCustomerPhone } from "../support/fakes";

const FIXTURES = path.join(__dirname, "..", "fixtures", "contacts");
const run = Date.now().toString(36);

let owner: TestUser;
let admin: TestUser;
let agent: TestUser;
let viewer: TestUser;
let wa: Connection;
let existingTag: { id: string; name: string };

interface ContactRow {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  company: string | null;
  tag_ids: string[];
}

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------

const contexts: BrowserContext[] = [];

async function openContacts(browser: Browser, user: TestUser): Promise<Page> {
  const { context, page } = await pageAs(browser, user);
  contexts.push(context);
  await page.goto("/contacts");
  await expect(page.getByRole("main").getByRole("heading", { name: "Contacts", level: 1 })).toBeVisible();
  await expect(page.getByText("Loading contacts...")).toHaveCount(0);
  return page;
}

async function createContactApi(user: TestUser, fields: { name?: string; phone: string; email?: string; company?: string }) {
  const r = await api(user, "POST", "/api/contacts", fields);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.contact as ContactRow;
}

async function findContacts(user: TestUser, search: string): Promise<ContactRow[]> {
  const r = await api(user, "GET", `/api/contacts?pageSize=100&search=${encodeURIComponent(search)}`);
  expect(r.status).toBe(200);
  return r.body.contacts;
}

async function contactDetail(user: TestUser, id: string) {
  return api(user, "GET", `/api/contacts/${id}`);
}

async function createTagApi(user: TestUser, name: string, color = "#22c55e") {
  const r = await api(user, "POST", "/api/tags", { name, color });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.tag as { id: string; name: string; color: string };
}

async function search(page: Page, term: string) {
  await page.getByPlaceholder("Search by name, phone, or email...").fill(term);
  await expect(page.getByText("Loading contacts...")).toHaveCount(0);
}

const row = (page: Page, text: string) => page.getByRole("row").filter({ hasText: text });

/** Click a contact row → the detail sheet. */
async function openDetail(page: Page, name: string): Promise<Locator> {
  await row(page, name).getByRole("cell", { name, exact: true }).click();
  const sheet = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("tab", { name: "Details" })).toBeVisible();
  return sheet;
}

async function rowMenu(page: Page, name: string, item: "Edit" | "Delete") {
  await row(page, name).getByRole("button").click();
  await page.getByRole("menuitem", { name: item }).click();
}

/**
 * Type a phone number in the Add/Edit form and leave the field, letting the
 * on-blur duplicate lookup finish before anything else is clicked, so the
 * validation/duplicate state is settled before the test asserts on it.
 */
async function fillPhone(dialog: Locator, value: string) {
  const input = dialog.getByLabel(/Phone Number/);
  await input.fill(value);
  await input.press("Tab");
  const submit = dialog.getByRole("button", { name: /^(Create|Update)$/ });
  const exactDup = dialog.getByText("A contact with this phone number already exists.");
  await expect.poll(async () => (await submit.isEnabled()) || (await exactDup.isVisible())).toBe(true);
}

const toast = (page: Page, text: string | RegExp) => page.locator("[data-sonner-toast]").filter({ hasText: text }).first();

test.beforeAll(async () => {
  owner = await newOwner("Cora Owner");
  [admin, agent, viewer] = await Promise.all([
    addMember(owner, "admin", "Adam Admin"),
    addMember(owner, "agent", "Agnes Agent"),
    addMember(owner, "viewer", "Vic Viewer"),
  ]);
  wa = await connectWhatsApp(owner);
  await syncTemplates(owner);
  existingTag = await createTagApi(admin, "Import Existing", "#f97316");
});

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});

// ------------------------------------------------------------
// create / edit / delete
// ------------------------------------------------------------

test("agent creates a contact with tags through the Add Contact form", async ({ browser }) => {
  const tag = await createTagApi(admin, `Lead ${run}`, "#3b82f6");
  const phone = randomCustomerPhone();
  const name = `Create Person ${run}`;
  const page = await openContacts(browser, agent);

  await page.getByRole("button", { name: "Add Contact" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Contact" });
  await expect(dialog.getByText("Include country code, e.g. +1 for US")).toBeVisible();
  await dialog.getByLabel("Name").fill(name);
  await fillPhone(dialog, phone);
  await dialog.getByLabel("Email").fill("create.person@example.test");
  await dialog.getByLabel("Company").fill("Create Co");
  await dialog.getByRole("button", { name: tag.name, exact: true }).click();
  await dialog.getByRole("button", { name: "Create" }).click();

  await expect(toast(page, "Contact created successfully")).toBeVisible();
  await expect(dialog).toBeHidden();
  const r = row(page, name);
  await expect(r).toContainText(phone);
  await expect(r).toContainText("create.person@example.test");
  await expect(r).toContainText("Create Co");
  await expect(r).toContainText(tag.name);

  const [saved] = await findContacts(agent, name);
  expect(saved).toMatchObject({ name, phone, email: "create.person@example.test", company: "Create Co" });
  expect(saved.tag_ids).toEqual([tag.id]);
});

test("phone validation: required, needs + and country code, too short", async ({ browser }) => {
  const page = await openContacts(browser, agent);
  await page.getByRole("button", { name: "Add Contact" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Contact" });
  const name = `Invalid Phone ${run}`;
  await dialog.getByLabel("Name").fill(name);

  // Empty phone
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(toast(page, "Phone number is required")).toBeVisible();

  // National format without + (issue #586 — would go to the wrong country)
  await fillPhone(dialog, "4155551212");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(toast(page, "Include the country code — the number must start with +")).toBeVisible();

  // Too short even with +
  await fillPhone(dialog, "+1234");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(toast(page, "Include the country code").nth(0)).toBeVisible();
  await expect(dialog).toBeVisible();

  // Letters
  await fillPhone(dialog, "+1 555 CALL NOW");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeVisible();

  // Formatting noise is accepted: spaces, dashes, parentheses
  const digits = randomCustomerPhone().slice(2); // drop "+1"
  const formatted = `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  await fillPhone(dialog, formatted);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(toast(page, "Contact created successfully")).toBeVisible();
  await expect(row(page, name)).toBeVisible();

  // Nothing invalid reached the database; the API enforces the same rule.
  expect((await findContacts(agent, name)).map((c) => c.phone)).toEqual([formatted]);
  for (const bad of ["4155551212", "+1234", "", "+1 555 CALL NOW"]) {
    const r = await api(agent, "POST", "/api/contacts", { name: "API bad", phone: bad });
    expect(r.status, `phone ${JSON.stringify(bad)}`).toBe(400);
  }
});

test("Create works on the first click right after typing the phone", async ({ browser }) => {
  const name = `First Click ${run}`;
  const page = await openContacts(browser, agent);
  await page.getByRole("button", { name: "Add Contact" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Contact" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel(/Phone Number/).fill(randomCustomerPhone());
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(toast(page, "Contact created successfully")).toBeVisible();
  expect(await findContacts(agent, name)).toHaveLength(1);
});

test("exact duplicate phone blocks creation and links to the existing contact", async ({ browser }) => {
  const phone = randomCustomerPhone();
  const existingName = `Existing Dup ${run}`;
  const existing = await createContactApi(owner, { name: existingName, phone });
  const page = await openContacts(browser, agent);

  await page.getByRole("button", { name: "Add Contact" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Contact" });
  await dialog.getByLabel("Name").fill(`Would Be Dup ${run}`);
  // Same number, different formatting → still an exact (normalised) match.
  const d = phone.slice(2);
  await dialog.getByLabel(/Phone Number/).fill(`+1 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`);
  await dialog.getByLabel("Email").click(); // blur → duplicate check

  await expect(dialog.getByText("A contact with this phone number already exists.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create" })).toBeDisabled();

  // "View <name>" jumps to the existing record.
  await dialog.getByRole("button", { name: `View ${existingName}` }).click();
  await expect(dialog).toBeHidden();
  const sheet = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: existingName }) });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(phone.replace("+", ""), { exact: false }).first()).toBeVisible();

  // Server backstop: 409 duplicate_phone with the existing contact.
  const r = await api(agent, "POST", "/api/contacts", { name: "dup", phone });
  expect(r.status).toBe(409);
  expect(r.body.code).toBe("duplicate_phone");
  expect(r.body.existing.id).toBe(existing.id);
  expect((await findContacts(agent, phone.slice(-8))).length).toBe(1);
});

test("a similar (trunk-variant) number only warns and can still be saved", async ({ browser }) => {
  const phone = randomCustomerPhone(); // +1555xxxxxxx
  const existingName = `Similar Base ${run}`;
  await createContactApi(owner, { name: existingName, phone });
  // Different country code, same last 8 digits → fuzzy match, not exact.
  const similar = `+44${phone.slice(-8)}`;
  const page = await openContacts(browser, agent);

  await page.getByRole("button", { name: "Add Contact" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Contact" });
  const name = `Similar New ${run}`;
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel(/Phone Number/).fill(similar);
  await dialog.getByLabel("Email").click();

  await expect(dialog.getByText("A contact with a very similar number already exists.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: `View ${existingName}` })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(toast(page, "Contact created successfully")).toBeVisible();

  const both = await findContacts(agent, phone.slice(-8));
  expect(both.map((c) => c.phone).sort()).toEqual([phone, similar].sort());
});

test("edit a contact from the row menu (fields + tags) and from the detail sheet", async ({ browser }) => {
  const tagA = await createTagApi(admin, `EditA ${run}`, "#ec4899");
  const tagB = await createTagApi(admin, `EditB ${run}`, "#14b8a6");
  const name = `Edit Me ${run}`;
  const contact = await createContactApi(agent, { name, phone: randomCustomerPhone(), company: "Old Co" });
  await api(agent, "POST", `/api/contacts/${contact.id}/tags`, { tag_id: tagA.id });
  const other = await createContactApi(agent, { name: `Edit Other ${run}`, phone: randomCustomerPhone() });

  const page = await openContacts(browser, agent);
  await search(page, `Edit Me ${run}`);
  await rowMenu(page, name, "Edit");
  const dialog = page.getByRole("dialog", { name: "Edit Contact" });
  await expect(dialog.getByLabel("Name")).toHaveValue(name);
  await expect(dialog.getByLabel("Company")).toHaveValue("Old Co");

  const renamed = `Edited Person ${run}`;
  await dialog.getByLabel("Name").fill(renamed);
  await dialog.getByLabel("Company").fill("New Co");
  await dialog.getByRole("button", { name: tagA.name, exact: true }).click(); // remove A
  await dialog.getByRole("button", { name: tagB.name, exact: true }).click(); // add B
  await dialog.getByRole("button", { name: "Update" }).click();
  await expect(toast(page, "Contact updated successfully")).toBeVisible();

  let detail = await contactDetail(agent, contact.id);
  expect(detail.body.contact).toMatchObject({ name: renamed, company: "New Co" });
  expect(detail.body.tag_ids).toEqual([tagB.id]);

  // Editing to another contact's number is refused (unique per account).
  await search(page, renamed);
  await rowMenu(page, renamed, "Edit");
  await fillPhone(dialog, other.phone);
  await dialog.getByRole("button", { name: "Update" }).click();
  await expect(toast(page, "A contact with this phone number already exists")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await contactDetail(agent, contact.id)).body.contact.phone).toBe(contact.phone);

  // Detail sheet → Details tab.
  const sheet = await openDetail(page, renamed);
  const fields = sheet.getByRole("tabpanel").getByRole("textbox");
  await expect(fields.nth(0)).toHaveValue(renamed);
  await fields.nth(2).fill("edited@example.test");
  // Invalid phone is rejected client-side.
  await fields.nth(1).fill("0044 7700 900000");
  await sheet.getByRole("button", { name: "Save Changes" }).click();
  await expect(toast(page, "Include the country code")).toBeVisible();
  await fields.nth(1).fill(contact.phone);
  await sheet.getByRole("button", { name: "Save Changes" }).click();
  await expect(toast(page, "Contact updated")).toBeVisible();
  await expect(sheet.getByText("edited@example.test").first()).toBeVisible();
  detail = await contactDetail(agent, contact.id);
  expect(detail.body.contact.email).toBe("edited@example.test");

  // A duplicate number via the sheet fails too.
  await fields.nth(1).fill(other.phone);
  await sheet.getByRole("button", { name: "Save Changes" }).click();
  await expect(toast(page, "Failed to update contact")).toBeVisible();
  expect((await contactDetail(agent, contact.id)).body.contact.phone).toBe(contact.phone);
});

test("delete a contact from the row menu (cancel, then confirm)", async ({ browser }) => {
  const name = `Delete Me ${run}`;
  const contact = await createContactApi(agent, { name, phone: randomCustomerPhone() });
  const page = await openContacts(browser, agent);
  await search(page, name);

  await rowMenu(page, name, "Delete");
  const confirm = page.getByRole("dialog", { name: "Delete Contact" });
  await expect(confirm).toContainText(`Are you sure you want to delete ${name}? This action cannot be undone.`);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await expect(row(page, name)).toBeVisible();
  expect((await contactDetail(agent, contact.id)).status).toBe(200);

  await rowMenu(page, name, "Delete");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(toast(page, "Contact deleted")).toBeVisible();
  await expect(row(page, name)).toHaveCount(0);
  await expect(page.getByText("No contacts match your filters.")).toBeVisible();
  expect((await contactDetail(agent, contact.id)).status).toBe(404);
});

// ------------------------------------------------------------
// tags, custom fields, notes
// ------------------------------------------------------------

test("tags: add and remove on the detail sheet, then filter the list by tag", async ({ browser }) => {
  const hot = await createTagApi(admin, `Hot ${run}`, "#f43f5e");
  const cold = await createTagApi(admin, `Cold ${run}`, "#06b6d4");
  const prefix = `Tagged ${run}`;
  const alpha = await createContactApi(agent, { name: `${prefix} Alpha`, phone: randomCustomerPhone() });
  const beta = await createContactApi(agent, { name: `${prefix} Beta`, phone: randomCustomerPhone() });
  await createContactApi(agent, { name: `${prefix} Gamma`, phone: randomCustomerPhone() });
  await api(agent, "POST", `/api/contacts/${beta.id}/tags`, { tag_id: cold.id });

  const page = await openContacts(browser, agent);
  await search(page, prefix);
  await expect(page.getByRole("row")).toHaveCount(4); // header + 3

  // Add "Hot" to Alpha via the Tags tab.
  const sheet = await openDetail(page, `${prefix} Alpha`);
  await sheet.getByRole("tab", { name: "Tags" }).click();
  await expect(sheet.getByText("Click a tag to add or remove it from this contact.")).toBeVisible();
  await sheet.getByRole("button", { name: hot.name, exact: true }).click();
  await expect.poll(async () => (await contactDetail(agent, alpha.id)).body.tag_ids).toEqual([hot.id]);

  // Add then remove "Cold" on Alpha.
  await sheet.getByRole("button", { name: cold.name, exact: true }).click();
  await expect.poll(async () => (await contactDetail(agent, alpha.id)).body.tag_ids.sort()).toEqual([hot.id, cold.id].sort());
  await sheet.getByRole("button", { name: cold.name, exact: true }).click();
  await expect.poll(async () => (await contactDetail(agent, alpha.id)).body.tag_ids).toEqual([hot.id]);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(row(page, `${prefix} Alpha`)).toContainText(hot.name);
  await expect(row(page, `${prefix} Alpha`)).not.toContainText(cold.name);

  // Filter by Hot → only Alpha.
  await page.getByRole("button", { name: "Filter by tags" }).click();
  await page.getByRole("checkbox", { name: `Filter by ${hot.name}` }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(row(page, `${prefix} Alpha`)).toBeVisible();

  // OR semantics: Hot + Cold → Alpha and Beta.
  await page.getByRole("checkbox", { name: `Filter by ${cold.name}` }).click();
  await expect(page.getByRole("row")).toHaveCount(3);
  await expect(row(page, `${prefix} Beta`)).toBeVisible();
  await expect(row(page, `${prefix} Gamma`)).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Chip removal and Clear all.
  await page.getByRole("button", { name: `Remove ${cold.name} filter` }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await page.getByRole("main").getByRole("button", { name: "Clear all" }).click();
  await expect(page.getByRole("row")).toHaveCount(4);

  // API agrees with the UI filter.
  const r = await api(agent, "GET", `/api/contacts?search=${encodeURIComponent(prefix)}&tag=${hot.id}&tag=${cold.id}`);
  expect(r.body.contacts.map((c: ContactRow) => c.name).sort()).toEqual([`${prefix} Alpha`, `${prefix} Beta`]);
  expect(r.body.total).toBe(2);
});

test("custom fields: admin defines/renames/deletes them, agent sets values on a contact", async ({ browser }) => {
  const adminPage = await openContacts(browser, admin);
  await adminPage.getByRole("button", { name: "Custom fields" }).click();
  const dlg = adminPage.getByRole("dialog", { name: "Custom fields" });
  const input = dlg.getByPlaceholder("New field name…");
  const lead = `Lead Source ${run}`;
  const zip = `ZIP ${run}`;
  const temp = `Temp Field ${run}`;

  await input.fill(lead);
  await input.press("Enter");
  await expect(toast(adminPage, `Created "${lead}".`)).toBeVisible();
  await input.fill(zip);
  await dlg.getByRole("button", { name: "Add" }).click();
  await expect(toast(adminPage, `Created "${zip}".`)).toBeVisible();
  await input.fill(temp);
  await dlg.getByRole("button", { name: "Add" }).click();
  await expect(dlg.getByRole("textbox", { name: `Rename ${temp}` })).toBeVisible();

  // Case-insensitive duplicate is refused client-side.
  await input.fill(lead.toUpperCase());
  await dlg.getByRole("button", { name: "Add" }).click();
  await expect(toast(adminPage, `A field named "${lead.toUpperCase()}" already exists.`)).toBeVisible();

  // Rename ZIP → Postal Code.
  const postal = `Postal Code ${run}`;
  const zipBox = dlg.getByRole("textbox", { name: `Rename ${zip}` });
  await zipBox.fill(postal);
  await zipBox.press("Enter");
  await expect(dlg.getByRole("textbox", { name: `Rename ${postal}` })).toBeVisible();

  // Delete the temp field (native confirm).
  adminPage.once("dialog", (d) => d.accept());
  await dlg.getByRole("listitem").filter({ has: adminPage.getByRole("textbox", { name: `Rename ${temp}` }) }).getByRole("button", { name: "Delete field" }).click();
  await expect(toast(adminPage, `Deleted "${temp}".`)).toBeVisible();
  await expect(dlg.getByRole("textbox", { name: `Rename ${temp}` })).toHaveCount(0);

  const defs = (await api(agent, "GET", "/api/custom-fields")).body.fields as { id: string; field_name: string; field_type: string }[];
  const names = defs.map((f) => f.field_name);
  expect(names).toEqual(expect.arrayContaining([lead, postal]));
  expect(names).not.toContain(temp);
  expect(names).not.toContain(zip);
  const leadId = defs.find((f) => f.field_name === lead)!.id;
  const postalId = defs.find((f) => f.field_name === postal)!.id;

  // Agent: no "Custom fields" manager button, but can fill values.
  const name = `Custom Values ${run}`;
  const contact = await createContactApi(agent, { name, phone: randomCustomerPhone() });
  const page = await openContacts(browser, agent);
  await expect(page.getByRole("button", { name: "Custom fields" })).toHaveCount(0);
  await search(page, name);
  const sheet = await openDetail(page, name);
  await sheet.getByRole("tab", { name: "Custom Fields" }).click();
  await sheet.getByPlaceholder(`Enter ${lead}...`).fill("Trade show");
  await sheet.getByPlaceholder(`Enter ${postal}...`).fill("94107");
  await sheet.getByRole("button", { name: "Save Custom Fields" }).click();
  await expect(toast(page, "Custom fields saved")).toBeVisible();

  const values = async () =>
    Object.fromEntries(
      ((await contactDetail(agent, contact.id)).body.custom_values as { custom_field_id: string; value: string }[]).map((v) => [
        v.custom_field_id,
        v.value,
      ]),
    );
  expect(await values()).toEqual({ [leadId]: "Trade show", [postalId]: "94107" });

  // Values persist across reopening; clearing one removes it.
  await page.keyboard.press("Escape");
  const again = await openDetail(page, name);
  await again.getByRole("tab", { name: "Custom Fields" }).click();
  await expect(again.getByPlaceholder(`Enter ${lead}...`)).toHaveValue("Trade show");
  await again.getByPlaceholder(`Enter ${postal}...`).fill("");
  await again.getByRole("button", { name: "Save Custom Fields" }).click();
  await expect(toast(page, "Custom fields saved").last()).toBeVisible();
  await expect.poll(values).toEqual({ [leadId]: "Trade show" });
});

test("notes: add and delete internal notes on a contact", async ({ browser }) => {
  const name = `Notes Person ${run}`;
  const contact = await createContactApi(agent, { name, phone: randomCustomerPhone() });
  const page = await openContacts(browser, agent);
  await search(page, name);
  const sheet = await openDetail(page, name);
  await sheet.getByRole("tab", { name: "Notes" }).click();
  await expect(sheet.getByText("No notes yet.")).toBeVisible();

  const addBtn = sheet.getByRole("button", { name: "Add Note" });
  await expect(addBtn).toBeDisabled();
  await sheet.getByPlaceholder("Write a note...").fill("   ");
  await expect(addBtn).toBeDisabled();

  await sheet.getByPlaceholder("Write a note...").fill("Called — wants a demo\nnext Tuesday");
  await addBtn.click();
  await expect(toast(page, "Note added")).toBeVisible();
  await expect(sheet.getByPlaceholder("Write a note...")).toHaveValue("");
  await sheet.getByPlaceholder("Write a note...").fill("Second note");
  await addBtn.click();
  await expect(sheet.locator("div.group").filter({ hasText: "Second note" })).toBeVisible();
  await expect(sheet.locator("div.group").filter({ hasText: /Called — wants a demo/ })).toBeVisible();

  const noteTexts = async () =>
    ((await contactDetail(agent, contact.id)).body.notes as { note_text: string }[]).map((n) => n.note_text).sort();
  await expect.poll(noteTexts).toEqual(["Called — wants a demo\nnext Tuesday", "Second note"]);

  const card = sheet.locator("div.group").filter({ hasText: "Second note" });
  await card.hover();
  await card.getByRole("button").click();
  await expect(toast(page, "Note deleted")).toBeVisible();
  await expect(sheet.getByText("Second note")).toHaveCount(0);
  await expect.poll(noteTexts).toEqual(["Called — wants a demo\nnext Tuesday"]);

  // Persisted: reopen the sheet.
  await page.keyboard.press("Escape");
  const again = await openDetail(page, name);
  await again.getByRole("tab", { name: "Notes" }).click();
  await expect(again.getByText(/Called — wants a demo/)).toBeVisible();
});

// ------------------------------------------------------------
// CSV import
// ------------------------------------------------------------

test("CSV import as admin: in-file dups, existing numbers, invalid phones, new tags created", async ({ browser }) => {
  await createContactApi(owner, { name: "Already There Original", phone: "+447700900099" });
  const page = await openContacts(browser, admin);

  // A file without a phone column is refused.
  await page.getByRole("button", { name: "Import" }).click();
  const dlg = page.getByRole("dialog", { name: "Import Contacts" });
  await expect(dlg.getByText("Click to choose a CSV file")).toBeVisible();
  await dlg.locator('input[type="file"]').setInputFiles(path.join(FIXTURES, "no-phone-column.csv"));
  await expect(toast(page, 'No valid rows found. Ensure CSV has a "phone" column header.')).toBeVisible();
  await expect(dlg.getByRole("button", { name: /^Import \d/ })).toBeDisabled();

  await dlg.locator('input[type="file"]').setInputFiles(path.join(FIXTURES, "import-admin.csv"));
  await expect(dlg.getByText("import-admin.csv")).toBeVisible();
  await expect(dlg.getByText(/^8 rows? ready$/)).toBeVisible();
  await expect(dlg.getByText("Preview · first 5")).toBeVisible();
  await expect(dlg.getByText(/^\+ 3 more rows? not shown$/)).toBeVisible();
  await expect(dlg.getByText(/^2 tags? · 2 contacts?$/)).toBeVisible();
  const preview = dlg.getByRole("table");
  await expect(preview.getByRole("row")).toHaveCount(6);
  await expect(preview).toContainText("Ada Import");
  await expect(preview).toContainText("Acme Ltd");
  // Unknown tag is flagged as "will be created".
  await expect(preview.getByTitle("Import Fresh (will be created on import)")).toBeVisible();
  await expect(preview.getByTitle("Import Existing", { exact: true }).first()).toBeVisible();

  await dlg.getByRole("button", { name: /^Import 8 contacts?$/ }).click();
  await expect(dlg.getByText("Import complete")).toBeVisible();
  await expect(dlg.getByText(/^3 imported$/)).toBeVisible();
  await expect(dlg.getByText(/^3 tags? assigned$/)).toBeVisible();
  await expect(dlg.getByText(/^2 skipped$/)).toBeVisible();
  await expect(dlg.getByText(/^3 invalid phones?$/)).toBeVisible();
  await expect(dlg.getByText(/Phone numbers must start with \+ and a country code/)).toBeVisible();
  await expect(dlg.getByText(/failed$/)).toHaveCount(0);
  await expect(toast(page, /3 contacts? imported/)).toBeVisible();
  await expect(toast(page, /2 duplicates? skipped/)).toBeVisible();
  await expect(toast(page, /3 contacts? had no usable phone number/)).toBeVisible();

  await dlg.locator('[data-slot="button"]').filter({ hasText: /^Close$/ }).click();
  await search(page, "Import");
  for (const n of ["Ada Import", "Ben Import", "Cy Import"]) await expect(row(page, n)).toBeVisible();
  for (const n of ["Ada Duplicate", "No Country Code", "Too Short", "Blank Phone"]) await expect(row(page, n)).toHaveCount(0);

  // Persisted state.
  const tags = (await api(admin, "GET", "/api/tags")).body.tags as { id: string; name: string; color: string }[];
  const fresh = tags.find((t) => t.name === "Import Fresh");
  expect(fresh, "admin import creates missing tags").toBeTruthy();
  expect(fresh!.color).toBe("#3b82f6");
  const byName = Object.fromEntries((await findContacts(admin, "+4477009000")).map((c) => [c.name, c]));
  expect(byName["Ada Import"]).toMatchObject({ phone: "+447700900001", email: "ada@import.test", company: "Acme Ltd" });
  expect(byName["Ada Import"].tag_ids.sort()).toEqual([existingTag.id, fresh!.id].sort());
  expect(byName["Ben Import"].tag_ids).toEqual([existingTag.id]);
  expect(byName["Cy Import"]).toMatchObject({ company: "Globex", tag_ids: [] });
  expect(byName["Already There Original"]).toBeTruthy();
  expect(byName["Already There"]).toBeUndefined();
});

test("CSV import as agent: unknown tags are skipped, not created", async ({ browser }) => {
  await createContactApi(owner, { name: "Existing For Agent Original", phone: "+447700900199" });
  const page = await openContacts(browser, agent);
  await page.getByRole("button", { name: "Import" }).click();
  const dlg = page.getByRole("dialog", { name: "Import Contacts" });
  await dlg.locator('input[type="file"]').setInputFiles(path.join(FIXTURES, "import-agent.csv"));
  await expect(dlg.getByText(/^5 rows? ready$/)).toBeVisible();
  await expect(dlg.getByText(/^2 tags? · 3 contacts?$/)).toBeVisible();
  await dlg.getByRole("button", { name: /^Import 5 contacts?$/ }).click();

  await expect(dlg.getByText(/^3 imported$/)).toBeVisible();
  await expect(dlg.getByText(/^2 tags? assigned$/)).toBeVisible();
  await expect(dlg.getByText(/^2 skipped$/)).toBeVisible();
  await expect(dlg.getByText(/invalid phone/)).toHaveCount(0);
  await expect(toast(page, "Unknown tags skipped (create them in Settings first): Agent Unknown")).toBeVisible();

  const tags = (await api(agent, "GET", "/api/tags")).body.tags as { name: string }[];
  expect(tags.map((t) => t.name)).not.toContain("Agent Unknown");
  const byName = Object.fromEntries((await findContacts(agent, "+4477009001")).map((c) => [c.name, c]));
  expect(byName["Dee Agent Import"].tag_ids).toEqual([existingTag.id]);
  expect(byName["Eve Agent Import"].tag_ids).toEqual([existingTag.id]);
  expect(byName["Fay Agent Import"].tag_ids).toEqual([]);
  expect(byName["Dee Again"]).toBeUndefined();
  expect(byName["Existing For Agent"]).toBeUndefined();
  expect(byName["Existing For Agent Original"]).toBeTruthy();
});

test("CSV import UI copy uses correct plurals", async ({ browser }) => {
  const page = await openContacts(browser, admin);
  await page.getByRole("button", { name: "Import" }).click();
  const dlg = page.getByRole("dialog", { name: "Import Contacts" });
  await dlg.locator('input[type="file"]').setInputFiles(path.join(FIXTURES, "import-admin.csv"));
  await expect(dlg.getByText("8 rows ready", { exact: true })).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Import 8 contacts", exact: true })).toBeVisible();
  await expect(dlg.getByText("+ 3 more rows not shown", { exact: true })).toBeVisible();
});

// ------------------------------------------------------------
// search, pagination, bulk delete
// ------------------------------------------------------------

test("search by name/phone/email and paginate 25 per page", async ({ browser }) => {
  const prefix = `Pager ${run}`;
  const made: ContactRow[] = [];
  for (let i = 1; i <= 30; i++) {
    made.push(
      await createContactApi(agent, {
        name: `${prefix} ${String(i).padStart(2, "0")}`,
        phone: randomCustomerPhone(),
        email: `pager${i}.${run}@example.test`,
      }),
    );
  }
  const page = await openContacts(browser, agent);
  await search(page, prefix);
  await expect(page.getByText("Manage your contact list. 30 total contacts.")).toBeVisible();
  await expect(page.getByText("Showing 1-25 of 30")).toBeVisible();
  await expect(page.getByText("Page 1 of 2")).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(26);
  // Newest first.
  await expect(page.getByRole("row").nth(1)).toContainText(`${prefix} 30`);

  const pager = page.getByText("Page 1 of 2").locator("..");
  await expect(pager.getByRole("button").first()).toBeDisabled();
  await pager.getByRole("button").last().click();
  await expect(page.getByText("Showing 26-30 of 30")).toBeVisible();
  await expect(page.getByText("Page 2 of 2")).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(6);
  await expect(page.getByRole("row").nth(5)).toContainText(`${prefix} 01`);
  const pager2 = page.getByText("Page 2 of 2").locator("..");
  await expect(pager2.getByRole("button").last()).toBeDisabled();
  await pager2.getByRole("button").first().click();
  await expect(page.getByText("Showing 1-25 of 30")).toBeVisible();

  // Search by phone and by email; changing the query resets to page 1.
  await pager.getByRole("button").last().click();
  await expect(page.getByText("Page 2 of 2")).toBeVisible();
  await search(page, made[6].phone);
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(row(page, `${prefix} 07`)).toBeVisible();
  await expect(page.getByText(/Page \d of/)).toHaveCount(0);
  await search(page, `pager12.${run}@example.test`);
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(row(page, `${prefix} 12`)).toBeVisible();
  // Case-insensitive.
  await search(page, prefix.toUpperCase());
  await expect(page.getByText("Showing 1-25 of 30")).toBeVisible();

  await search(page, `nobody-matches-${run}`);
  await expect(page.getByText("No contacts match your filters.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add your first contact" })).toHaveCount(0);

  const apiPage = await api(agent, "GET", `/api/contacts?page=1&pageSize=25&search=${encodeURIComponent(prefix)}`);
  expect(apiPage.body.total).toBe(30);
  expect(apiPage.body.contacts).toHaveLength(5);
});

test("bulk select and delete contacts", async ({ browser }) => {
  const prefix = `Bulk ${run}`;
  const made: ContactRow[] = [];
  for (let i = 1; i <= 4; i++) made.push(await createContactApi(agent, { name: `${prefix} ${i}`, phone: randomCustomerPhone() }));
  const page = await openContacts(browser, agent);
  await search(page, prefix);
  await expect(page.getByRole("row")).toHaveCount(5);

  // Select two, then clear.
  await page.getByRole("checkbox", { name: `Select ${prefix} 1` }).click();
  await page.getByRole("checkbox", { name: `Select ${prefix} 2` }).click();
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText(/\d+ selected/)).toHaveCount(0);

  // Select two and delete them.
  await page.getByRole("checkbox", { name: `Select ${prefix} 1` }).click();
  await page.getByRole("checkbox", { name: `Select ${prefix} 3` }).click();
  await page.getByRole("button", { name: "Delete selected" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete Contacts" });
  await expect(confirm).toContainText("Are you sure you want to delete 2 selected contacts?");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(toast(page, "2 contacts deleted")).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(3);
  expect((await contactDetail(agent, made[0].id)).status).toBe(404);
  expect((await contactDetail(agent, made[2].id)).status).toBe(404);

  // Select-all on the page → delete the rest.
  await page.getByRole("checkbox", { name: "Select all contacts on this page" }).click();
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Delete selected" }).click();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No contacts match your filters.")).toBeVisible();
  expect(await findContacts(agent, prefix)).toEqual([]);
});

// ------------------------------------------------------------
// messaging from the contact
// ------------------------------------------------------------

test("send a template from contact detail starts a conversation", async ({ browser }) => {
  const phone = randomCustomerPhone();
  const name = `Template Target ${run}`;
  const contact = await createContactApi(agent, { name, phone });
  const page = await openContacts(browser, agent);
  await search(page, name);
  const sheet = await openDetail(page, name);

  await sheet.getByRole("button", { name: "Send template" }).click();
  const picker = page.getByRole("dialog", { name: "Send template" });
  await expect(picker.getByText("Pick an approved WhatsApp template to send to this contact.")).toBeVisible();
  await expect(picker.getByRole("button", { name: /order_update/ })).toBeVisible();
  await expect(picker.getByRole("button", { name: /appointment_confirm/ })).toBeVisible();
  await picker.getByRole("button", { name: /order_update/ }).click();

  const flow = page.getByRole("dialog", { name: "order_update" });
  await expect(flow.getByText("Fill in the placeholders to render this template.", { exact: false })).toBeVisible();
  const send = flow.getByRole("button", { name: "Send template" });
  await expect(send).toBeDisabled();
  await flow.getByPlaceholder("Value for {{1}}").fill("Jamie");
  await flow.getByPlaceholder("Value for {{2}}").fill("#A-42");
  await expect(flow.getByText("Hi Jamie, your order #A-42 has shipped!")).toBeVisible();
  await send.click();
  await expect(toast(page, 'Template "order_update" sent')).toBeVisible();

  const [msg] = await fakes.waitForOutbound({ to: phone, phoneNumberId: wa.phoneNumberId }, (m) => m.type === "template");
  expect(msg.body.template.name).toBe("order_update");
  expect(msg.body.template.language.code).toBe("en_US");
  const bodyComp = (msg.body.template.components as { type: string; parameters: { text: string }[] }[]).find((c) => c.type === "body");
  expect(bodyComp!.parameters.map((p) => p.text)).toEqual(["Jamie", "#A-42"]);

  // A conversation now exists for this contact and shows in the inbox.
  await expect
    .poll(async () => {
      const r = await api(agent, "GET", "/api/conversations");
      return (r.body.conversations as { contact_id: string }[]).some((c) => c.contact_id === contact.id);
    })
    .toBe(true);
  await page.goto("/inbox");
  await expect(page.getByText(name).first()).toBeVisible();
});

test("template without variables sends immediately", async ({ browser }) => {
  const phone = randomCustomerPhone();
  const name = `Template Simple ${run}`;
  await createContactApi(agent, { name, phone });
  const page = await openContacts(browser, agent);
  await search(page, name);
  const sheet = await openDetail(page, name);
  await sheet.getByRole("button", { name: "Send template" }).click();
  await page.getByRole("dialog", { name: "Send template" }).getByRole("button", { name: /appointment_confirm/ }).click();
  await expect(toast(page, 'Template "appointment_confirm" sent')).toBeVisible();
  const [msg] = await fakes.waitForOutbound({ to: phone, phoneNumberId: wa.phoneNumberId }, (m) => m.type === "template");
  expect(msg.body.template.name).toBe("appointment_confirm");
});

// ------------------------------------------------------------
// viewer role
// ------------------------------------------------------------

test("viewer: list is visible but add/import/bulk-delete are read-only", async ({ browser }) => {
  const name = `Viewer Sees ${run}`;
  await createContactApi(agent, { name, phone: randomCustomerPhone() });
  const page = await openContacts(browser, viewer);
  await page.waitForLoadState("networkidle");
  await search(page, name);
  await expect(row(page, name)).toBeVisible();

  for (const label of ["Add Contact", "Import"]) {
    const btn = page.getByRole("button", { name: label, exact: true });
    await expect(btn).toBeDisabled();
    await expect(btn.locator("..")).toHaveAttribute("title", "Read-only — your role can't add or import contacts");
  }
  await expect(page.getByRole("button", { name: "Custom fields" })).toHaveCount(0);

  await page.getByRole("checkbox", { name: `Select ${name}` }).click();
  const del = page.getByRole("button", { name: "Delete selected" });
  await expect(del).toBeDisabled();
  await expect(del.locator("..")).toHaveAttribute("title", "Read-only — your role can't delete contacts");

  // Detail sheet still opens for reading.
  const sheet = await openDetail(page, name);
  await sheet.getByRole("tab", { name: "Notes" }).click();
  await expect(sheet.getByText("No notes yet.")).toBeVisible();
});

test("viewer: every contact write is rejected by the API", async () => {
  const c = await createContactApi(agent, { name: `Viewer API ${run}`, phone: randomCustomerPhone() });
  const field = (await api(admin, "POST", "/api/custom-fields", { field_name: `ViewerField ${run}` })).body.field;
  const reads = [
    await api(viewer, "GET", "/api/contacts"),
    await api(viewer, "GET", `/api/contacts/${c.id}`),
    await api(viewer, "GET", "/api/tags"),
    await api(viewer, "GET", "/api/custom-fields"),
    await api(viewer, "GET", `/api/contacts/duplicate?phone=${encodeURIComponent(c.phone)}`),
  ];
  for (const r of reads) expect(r.status).toBe(200);

  const writes: [string, string, unknown][] = [
    ["POST", "/api/contacts", { name: "x", phone: randomCustomerPhone() }],
    ["PATCH", `/api/contacts/${c.id}`, { name: "hacked" }],
    ["DELETE", `/api/contacts/${c.id}`, undefined],
    ["DELETE", "/api/contacts", { ids: [c.id] }],
    ["POST", `/api/contacts/${c.id}/notes`, { note_text: "nope" }],
    ["POST", `/api/contacts/${c.id}/tags`, { tag_id: existingTag.id }],
    ["PUT", `/api/contacts/${c.id}/custom-values`, { values: [{ custom_field_id: field.id, value: "x" }] }],
    ["POST", "/api/contacts/import", { rows: [{ phone: randomCustomerPhone(), tagNames: [] }] }],
    ["POST", "/api/tags", { name: "viewer tag" }],
    ["POST", "/api/custom-fields", { field_name: "viewer field" }],
    ["POST", "/api/whatsapp/send", { contact_id: c.id, message_type: "template", template_name: "appointment_confirm", template_language: "en" }],
  ];
  for (const [method, p, body] of writes) {
    const r = await api(viewer, method, p, body);
    expect(r.status, `${method} ${p}`).toBe(403);
  }
  const after = await contactDetail(agent, c.id);
  expect(after.body.contact.name).toBe(`Viewer API ${run}`);
  expect(after.body.notes).toEqual([]);
  expect(after.body.tag_ids).toEqual([]);

  // Agents can't manage tag / custom-field definitions either (admin+).
  expect((await api(agent, "POST", "/api/tags", { name: "agent tag" })).status).toBe(403);
  expect((await api(agent, "POST", "/api/custom-fields", { field_name: "agent field" })).status).toBe(403);
  expect((await api(agent, "DELETE", `/api/custom-fields/${field.id}`)).status).toBe(403);
});

test("viewer: contact detail sheet and row menu are read-only", async ({ browser }) => {
  const name = `Viewer Sheet ${run}`;
  const c = await createContactApi(agent, { name, phone: randomCustomerPhone() });
  // Something to see (and not delete) on the Tags / Notes / Custom tabs.
  await api(agent, "POST", `/api/contacts/${c.id}/notes`, { note_text: `Viewer note ${run}` });
  await api(agent, "POST", `/api/contacts/${c.id}/tags`, { tag_id: existingTag.id });
  await api(admin, "POST", "/api/custom-fields", { field_name: `ViewerSheetField ${run}` });

  const page = await openContacts(browser, viewer);
  await search(page, name);
  await row(page, name).getByRole("button").click();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem")).toHaveCount(0);

  const sheet = await openDetail(page, name);
  const gated = async (label: string, reason: string) => {
    const btn = sheet.getByRole("button", { name: label, exact: true });
    await expect(btn).toBeDisabled();
    await expect(btn.locator("..")).toHaveAttribute("title", `Read-only — your role can't ${reason}`);
  };
  await gated("Send template", "send messages");

  // Details: inputs are read-only, Save Changes is gated.
  await gated("Save Changes", "edit contacts");
  const nameInput = sheet.locator("input").first();
  await expect(nameInput).toHaveValue(name);
  await expect(nameInput).toHaveAttribute("readonly", "");

  // Tags: toggles are disabled.
  await sheet.getByRole("tab", { name: "Tags" }).click();
  const tagBtn = sheet.getByRole("button", { name: existingTag.name });
  await expect(tagBtn).toBeDisabled();
  await expect(tagBtn).toHaveAttribute("title", "Read-only — your role can't edit contacts");

  // Notes: textarea read-only, Add Note gated, no delete button on notes.
  await sheet.getByRole("tab", { name: "Notes" }).click();
  await expect(sheet.getByText(`Viewer note ${run}`)).toBeVisible();
  await expect(sheet.locator("textarea")).toHaveAttribute("readonly", "");
  await gated("Add Note", "edit contacts");
  const note = sheet.locator("div.group").filter({ hasText: `Viewer note ${run}` });
  await expect(note.getByRole("button")).toHaveCount(0);

  // Custom fields: inputs read-only, Save Custom Fields gated.
  await sheet.getByRole("tab", { name: "Custom" }).click();
  const customInput = sheet.getByPlaceholder(new RegExp(`ViewerSheetField ${run}`, "i"));
  await expect(customInput).toHaveAttribute("readonly", "");
  await gated("Save Custom Fields", "edit contacts");

  // Nothing changed server-side.
  const after = await contactDetail(agent, c.id);
  expect(after.body.contact.name).toBe(name);
  expect(after.body.notes).toHaveLength(1);
  expect(after.body.tag_ids).toEqual([existingTag.id]);
});

// ------------------------------------------------------------
// known upstream gaps
// ------------------------------------------------------------

test("tags can be renamed", async () => {
  test.fixme(true, "GAP: tags can't be renamed (no PATCH /api/tags/[id], no rename UI in Settings → Fields & tags)");
});

test("custom fields support types other than free text", async () => {
  test.fixme(true, "GAP: custom fields are name-only — every field is free text (field_type is always 'text'); no number/date/select types or validation");
});
