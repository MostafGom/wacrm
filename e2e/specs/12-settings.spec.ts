// Settings, driven through the UI: overview landing (counts, status,
// currency), profile (name, avatar upload/remove, validation, browser
// notifications), login & security (password change, sign out
// everywhere), appearance, quick replies (CRUD + use in the inbox
// composer), fields & tags, deals & currency, API keys (create, shown
// once, copy, use, revoke → 401) and the role gates on each.
//
// WhatsApp, templates, team members and AI settings are covered by
// their own spec files.

import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  addMember,
  api,
  connectWhatsApp,
  login,
  newOwner,
  pageAs,
  syncTemplates,
  type Connection,
  type TestUser,
} from "../support/accounts";
import { BASE_URL, PASSWORD } from "../support/env";
import { createCustomField, createTag } from "../support/crm-seed";
import { fakes, randomCustomerPhone } from "../support/fakes";

const FIXTURES = path.join(__dirname, "..", "fixtures", "settings");

test.describe.configure({ mode: "serial" });

let owner: TestUser;
let wa: Connection;

test.beforeAll(async () => {
  owner = await newOwner("Sally Settings");
  wa = await connectWhatsApp(owner);
  await syncTemplates(owner);
});

const rail = (page: Page) => page.getByRole("navigation", { name: "Settings sections" });
const railItem = (page: Page, label: string) => rail(page).getByRole("button", { name: new RegExp(`^${label}`) });
const tile = (page: Page, label: string) => page.locator("section button").filter({ hasText: label });


// ------------------------------------------------------------
// Overview
// ------------------------------------------------------------

test("overview: identity, live status tiles and counts; tiles deep-link to sections", async ({ browser }) => {
  await createTag(owner, "Lead", "#3b82f6");
  await createTag(owner, "Customer", "#10b981");
  await createCustomField(owner, "Region");
  const inv = await api(owner, "POST", "/api/account/invitations", { role: "agent", label: "pending" });
  expect(inv.status).toBe(201);

  const { page } = await pageAs(browser, owner);
  await page.goto("/settings");
  await expect(page.getByRole("main").getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(railItem(page, "Overview")).toHaveAttribute("aria-current", "page");

  const identity = page.locator("section").first();
  await expect(identity).toContainText("Sally Settings");
  await expect(identity).toContainText(owner.email);
  await expect(identity).toContainText("Owner");

  await expect(tile(page, "WhatsApp")).toContainText("Connected");
  await expect(tile(page, "Team members")).toContainText("1 member · 1 pending invite");
  // The fake WABA's template list is shared by every spec, so the synced
  // count isn't fixed — compare against what this account synced.
  const synced = (await api(owner, "GET", "/api/whatsapp/templates")).body.templates.length as number;
  expect(synced).toBeGreaterThanOrEqual(3);
  await expect(tile(page, "Templates")).toContainText(`${synced} templates`);
  await expect(tile(page, "Deals & currency")).toContainText("USD — US Dollar");
  await expect(tile(page, "Fields & tags")).toContainText("2 tags · 1 custom field");
  await expect(tile(page, "Appearance")).toContainText("Dark mode · Violet accent");

  // The same counts from the API.
  const overview = await api(owner, "GET", "/api/settings/overview");
  expect(overview.body).toMatchObject({ templates: synced, tags: 2, custom_fields: 1, whatsapp_configured: true });

  await tile(page, "Fields & tags").click();
  await expect(page).toHaveURL(/tab=fields/);
  await expect(page.getByRole("main").getByRole("heading", { name: "Fields & tags" })).toBeVisible();
  await expect(railItem(page, "Fields & tags")).toHaveAttribute("aria-current", "page");

  // Legacy and unknown ?tab= values resolve sensibly.
  await page.goto("/settings?tab=custom-fields");
  await expect(page.getByRole("main").getByRole("heading", { name: "Fields & tags" })).toBeVisible();
  await page.goto("/settings?tab=nonsense");
  await expect(tile(page, "Team members")).toBeVisible();

  await api(owner, "DELETE", `/api/account/invitations/${inv.body.invitation.id}`);
});

test("overview counts are account-wide for every admin", async () => {
  // Tags/templates created by the owner count for a second admin too.
  const admin = await addMember(owner, "admin");
  const mine = await api(owner, "GET", "/api/settings/overview");
  const theirs = await api(admin, "GET", "/api/settings/overview");
  expect(mine.body.tags).toBeGreaterThan(0);
  expect(mine.body.templates).toBeGreaterThan(0);
  expect(theirs.body).toMatchObject({ tags: mine.body.tags, templates: mine.body.templates, custom_fields: mine.body.custom_fields });
});

// ------------------------------------------------------------
// Profile
// ------------------------------------------------------------

test("profile: change the display name; validation; Save only when dirty", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await page.goto("/settings?tab=profile");
  await expect(page.getByRole("main").getByRole("heading", { name: "Your profile" })).toBeVisible();
  const nameInput = page.getByLabel("Display name");
  await expect(nameInput).toHaveValue("Sally Settings");
  await expect(page.getByLabel("Email")).toHaveValue(owner.email);
  const save = page.getByRole("button", { name: "Save changes" });
  await expect(save).toBeDisabled();
  await expect(page.getByText(owner.userId)).toBeVisible();

  // Whitespace-only name.
  await nameInput.fill("   ");
  await save.click();
  await expect(page.getByText("Display name is required")).toBeVisible();

  // Malformed email (passes the browser's check, not ours).
  await nameInput.fill("Sally Renamed");
  await page.getByLabel("Email").fill("sally@nodot");
  await save.click();
  await expect(page.getByText("Enter a valid email address")).toBeVisible();
  await page.getByLabel("Email").fill(owner.email);

  await save.click();
  await expect(page.getByText("Profile saved")).toBeVisible();
  await expect(save).toBeDisabled();
  // The header picks the new name up without a reload.
  await expect(page.locator("header")).toContainText("Sally Renamed");

  const me = await api(owner, "GET", "/api/me");
  expect(me.body.profile.full_name).toBe("Sally Renamed");
  await page.reload();
  await expect(page.getByLabel("Display name")).toHaveValue("Sally Renamed");
});

test("profile: upload an avatar, then remove it", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await page.goto("/settings?tab=profile");
  await expect(page.getByRole("button", { name: "Upload photo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  const fileInput = page.locator('input[type="file"][accept^="image/"]');

  // Non-images are refused client-side.
  await fileInput.setInputFiles(path.join(FIXTURES, "not-an-image.txt"));
  await expect(page.getByText("Unsupported image type")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();

  await fileInput.setInputFiles(path.join(FIXTURES, "avatar.png"));
  await expect(page.getByRole("button", { name: "Change photo" })).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Profile saved")).toBeVisible();

  let avatarUrl = "";
  await expect
    .poll(async () => {
      avatarUrl = (await api(owner, "GET", "/api/me")).body.profile.avatar_url ?? "";
      return avatarUrl;
    })
    .toMatch(/avatar-\d+\.png$/);
  // The stored file is served back as the same PNG.
  const img = await fetch(new URL(avatarUrl, BASE_URL));
  expect(img.status).toBe(200);
  expect(img.headers.get("content-type")).toContain("image/png");
  expect(Buffer.from(await img.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
  // …and rendered in the header.
  await page.reload();
  await expect(page.locator("header img").first()).toHaveAttribute("src", avatarUrl);

  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("button", { name: "Upload photo" })).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Profile saved")).toBeVisible();
  await expect.poll(async () => (await api(owner, "GET", "/api/me")).body.profile.avatar_url).toBeNull();
  await page.reload();
  await expect(page.getByRole("button", { name: "Upload photo" })).toBeVisible();
  await expect(page.locator("header img")).toHaveCount(0);
});

test("profile: browser notifications switch (device-scoped)", async ({ browser }) => {
  // Headless Chromium reports notifications as blocked: the card says so
  // and the switch is locked.
  const blocked = (await pageAs(browser, owner)).page;
  await blocked.goto("/settings?tab=profile");
  await expect(blocked.getByText("Blocked in browser settings")).toBeVisible();
  await expect(blocked.getByRole("switch", { name: "Notify me about new customer messages" })).toBeDisabled();
  await expect(blocked.getByRole("button", { name: "Send test notification" })).toBeDisabled();

  // A browser that has granted permission (Notification API stubbed).
  const { context, page } = await pageAs(browser, owner);
  await context.addInitScript(() => {
    class FakeNotification {
      static permission = "granted";
      static requestPermission = async () => "granted";
      constructor(title: string) {
        (window as unknown as { __notified: string[] }).__notified ??= [];
        (window as unknown as { __notified: string[] }).__notified.push(title);
      }
    }
    Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true, writable: true });
  });
  await page.goto("/settings?tab=profile");
  const toggle = page.getByRole("switch", { name: "Notify me about new customer messages" });
  await expect(page.getByText("Allowed by your browser.")).toBeVisible();
  const sendTest = page.getByRole("button", { name: "Send test notification" });
  await expect(toggle).not.toBeChecked();
  await expect(sendTest).toBeDisabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await sendTest.click();
  expect(await page.evaluate(() => (window as unknown as { __notified?: string[] }).__notified)).toEqual(["Test notification"]);
  // Saved to this device.
  await page.reload();
  await expect(page.getByRole("switch", { name: "Notify me about new customer messages" })).toBeChecked();
  await page.getByRole("switch", { name: "Notify me about new customer messages" }).click();
  await expect(page.getByRole("switch", { name: "Notify me about new customer messages" })).not.toBeChecked();
  await expect(sendTest).toBeDisabled();
});

// ------------------------------------------------------------
// Login & security
// ------------------------------------------------------------

test("security: change password (with validation), then sign out everywhere", async ({ browser }) => {
  const user = await newOwner("Pat Password");
  const { page } = await pageAs(browser, user);
  await page.goto("/settings?tab=security");
  await expect(page.getByRole("main").getByRole("heading", { name: "Login & security" })).toBeVisible();
  const update = page.getByRole("button", { name: "Update password" });
  await expect(update).toBeDisabled();

  const fill = async (current: string, next: string, confirm: string) => {
    await page.getByLabel("Current password").fill(current);
    await page.getByLabel("New password", { exact: true }).fill(next);
    await page.getByLabel("Confirm new password").fill(confirm);
  };

  await fill(PASSWORD, "N3w-passw0rd!", "N3w-passw0rd?");
  await update.click();
  await expect(page.getByText("New password and confirmation do not match")).toBeVisible();

  await fill("wrong-password", "N3w-passw0rd!", "N3w-passw0rd!");
  await update.click();
  await expect(page.getByText("Current password is incorrect")).toBeVisible();

  await fill(PASSWORD, "N3w-passw0rd!", "N3w-passw0rd!");
  await update.click();
  await expect(page.getByText("Password updated")).toBeVisible();
  await expect(page.getByLabel("Current password")).toHaveValue("");
  // Still signed in here; the new password works and the old one doesn't.
  expect((await api(user, "GET", "/api/me")).status).toBe(200);
  await expect(login(user.email, PASSWORD)).rejects.toThrow(/failed/);
  const fresh = await login(user.email, "N3w-passw0rd!");

  await page.getByRole("button", { name: "Sign out of all devices" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Sign out everywhere?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out of all devices" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(page).toHaveURL(/\/login/);

  // Every session — this one and the one minted separately — is gone.
  expect((await api(user, "GET", "/api/me")).status).toBe(401);
  expect((await api({ session: fresh, ip: user.ip }, "GET", "/api/me")).status).toBe(401);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/login/);
});

// ------------------------------------------------------------
// Appearance
// ------------------------------------------------------------

test("appearance: mode and accent apply live and persist on this device", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await page.goto("/settings?tab=appearance");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-mode", "dark");
  await expect(html).toHaveAttribute("data-theme", "violet");
  await expect(page.getByRole("radio", { name: "Use dark mode" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("radio", { name: "Use light mode" }).click();
  await expect(html).toHaveAttribute("data-mode", "light");
  await expect(page.getByRole("radio", { name: "Use light mode" })).toHaveAttribute("aria-checked", "true");
  await expect(railItem(page, "Appearance")).toContainText("Light");

  await page.getByRole("button", { name: "Use Emerald theme" }).click();
  await expect(html).toHaveAttribute("data-theme", "emerald");
  await expect(page.getByRole("button", { name: "Use Emerald theme" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Use Violet theme" })).toHaveAttribute("aria-pressed", "false");

  // Survives a reload (localStorage) and shows on the overview tile.
  await page.goto("/settings");
  await expect(html).toHaveAttribute("data-mode", "light");
  await expect(html).toHaveAttribute("data-theme", "emerald");
  await expect(tile(page, "Appearance")).toContainText("Light mode · Emerald accent");
  // Other pages use it too.
  await page.goto("/dashboard");
  await expect(html).toHaveAttribute("data-theme", "emerald");

  // A fresh device starts from the defaults.
  const other = await pageAs(browser, owner);
  await other.page.goto("/settings?tab=appearance");
  await expect(other.page.locator("html")).toHaveAttribute("data-mode", "dark");
  await expect(other.page.locator("html")).toHaveAttribute("data-theme", "violet");
});

// ------------------------------------------------------------
// Quick replies
// ------------------------------------------------------------

test("quick replies: create, edit, delete — and insert one from the inbox composer", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await page.goto("/settings?tab=quick-replies");
  await expect(page.getByRole("main").getByRole("heading", { name: "Quick replies" })).toBeVisible();
  await expect(page.getByText("No quick replies yet. Create one to reuse it across conversations.")).toBeVisible();

  // Name is required.
  await page.getByRole("button", { name: "New quick reply" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Give the quick reply a name.")).toBeVisible();

  await dialog.getByPlaceholder("e.g. Business hours").fill("Hours");
  await dialog.getByPlaceholder("The message text to insert").fill("We are open 9-5, Mon-Fri.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Quick reply created.")).toBeVisible();
  const item = page.getByRole("main").getByRole("listitem").filter({ hasText: "Hours" });
  await expect(item).toContainText("We are open 9-5, Mon-Fri.");

  // A second one to delete later.
  await page.getByRole("button", { name: "New quick reply" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("e.g. Business hours").fill("Temporary");
  await dialog.getByPlaceholder("The message text to insert").fill("Delete me");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("main").getByRole("listitem").filter({ hasText: "Temporary" })).toBeVisible();

  // Edit (first icon button on the row).
  await item.getByRole("button").first().click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Edit quick reply" })).toBeVisible();
  await expect(dialog.getByPlaceholder("e.g. Business hours")).toHaveValue("Hours");
  await dialog.getByPlaceholder("e.g. Business hours").fill("Opening hours");
  await dialog.getByPlaceholder("The message text to insert").fill("We are open 9-6, Mon-Sat.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Quick reply updated.")).toBeVisible();
  const edited = page.getByRole("main").getByRole("listitem").filter({ hasText: "Opening hours" });
  await expect(edited).toContainText("We are open 9-6, Mon-Sat.");

  // Delete — cancel the confirm first, then accept.
  const temp = page.getByRole("main").getByRole("listitem").filter({ hasText: "Temporary" });
  page.once("dialog", (d) => void d.dismiss());
  await temp.getByRole("button").nth(1).click();
  await expect(temp).toBeVisible();
  page.once("dialog", (d) => {
    expect(d.message()).toBe("Delete this quick reply?");
    void d.accept();
  });
  await temp.getByRole("button").nth(1).click();
  await expect(temp).toHaveCount(0);
  const list = await api(owner, "GET", "/api/quick-replies");
  expect(list.body.quick_replies.map((q: { title: string }) => q.title)).toEqual(["Opening hours"]);

  // Use it in the inbox composer.
  const customer = randomCustomerPhone();
  await fakes.inbound({ from: customer, name: "Quentin Quick", phone_number_id: wa.phoneNumberId, text: "When are you open?" });
  await page.goto("/inbox");
  await page.getByText("Quentin Quick").first().click();
  await expect(page.getByText("When are you open?").last()).toBeVisible();
  const box = page.getByPlaceholder(/type a message/i);
  await box.fill("Hi!");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Quick replies" }).click();
  const picker = page.getByRole("dialog");
  await expect(picker.getByRole("heading", { name: "Quick replies" })).toBeVisible();
  await picker.getByRole("button", { name: /Opening hours/ }).click();
  await expect(picker).toHaveCount(0);
  await expect(box).toHaveValue("Hi!\nWe are open 9-6, Mon-Sat.");
  await box.press("Enter");
  const [sent] = await fakes.waitForOutbound({ to: customer, phoneNumberId: wa.phoneNumberId }, (m) => m.type === "text");
  expect(sent.body.text.body).toBe("Hi!\nWe are open 9-6, Mon-Sat.");
});

test("quick replies: role gates", async () => {
  const viewer = await addMember(owner, "viewer");
  const agent = await addMember(owner, "agent");
  expect((await api(viewer, "GET", "/api/quick-replies")).status).toBe(200);
  expect((await api(viewer, "POST", "/api/quick-replies", { title: "x", kind: "text", content_text: "y" })).status).toBe(403);
  const created = await api(agent, "POST", "/api/quick-replies", { title: "Agent snippet", kind: "text", content_text: "From an agent" });
  expect(created.status).toBeLessThan(300);
  const id = created.body.quick_reply.id;
  expect((await api(viewer, "DELETE", `/api/quick-replies/${id}`)).status).toBe(403);
  expect((await api(agent, "DELETE", `/api/quick-replies/${id}`)).status).toBeLessThan(300);
});

// ------------------------------------------------------------
// Fields & tags
// ------------------------------------------------------------

test("fields & tags: create and delete tags, add/rename/delete custom fields", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await page.goto("/settings?tab=fields");
  await expect(page.getByRole("main").getByRole("heading", { name: "Fields & tags" })).toBeVisible();

  // Tags.
  const tagName = page.getByPlaceholder("e.g. Newsletter");
  await expect(page.getByRole("button", { name: "Add tag" })).toBeDisabled();
  await tagName.fill("Newsletter");
  await page.getByRole("button", { name: "Use Violet" }).click();
  await expect(page.getByRole("button", { name: "Use Violet" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Add tag" }).click();
  await expect(page.getByText("Tag created")).toBeVisible();
  await expect(tagName).toHaveValue("");
  await expect(page.getByRole("button", { name: "Delete Newsletter" })).toBeVisible();
  const tags = (await api(owner, "GET", "/api/tags")).body.tags as { name: string; color: string }[];
  expect(tags.find((t) => t.name === "Newsletter")?.color).toBe("#8b5cf6");

  // Enter also adds.
  await tagName.fill("Throwaway");
  await tagName.press("Enter");
  await expect(page.getByRole("button", { name: "Delete Throwaway" })).toBeVisible();
  await page.getByRole("button", { name: "Delete Throwaway" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText('Delete the tag "Throwaway"? This removes it from all contacts and cannot be undone.');
  await confirm.getByRole("button", { name: "Delete tag" }).click();
  await expect(page.getByText("Tag deleted")).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete Throwaway" })).toHaveCount(0);
  expect(((await api(owner, "GET", "/api/tags")).body.tags as { name: string }[]).map((t) => t.name)).not.toContain("Throwaway");

  // Custom fields.
  const fieldName = page.getByPlaceholder("New field name…");
  await fieldName.fill("Lead source");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText('Created "Lead source".')).toBeVisible();
  const row = page.getByLabel("Rename Lead source");
  await expect(row).toHaveValue("Lead source");
  // Duplicate names are refused.
  await fieldName.fill("Lead source");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText('A field named "Lead source" already exists.')).toBeVisible();
  await fieldName.fill("");
  // Rename inline (commit on Enter).
  await row.fill("Acquisition channel");
  await row.press("Enter");
  await expect.poll(async () => ((await api(owner, "GET", "/api/custom-fields")).body.fields as { field_name: string }[]).map((f) => f.field_name)).toContain("Acquisition channel");
  // Delete (native confirm).
  page.once("dialog", (d) => void d.accept());
  await page.getByLabel("Rename Acquisition channel").locator("xpath=..").getByTitle("Delete field").click();
  await expect(page.getByText('Deleted "Acquisition channel".')).toBeVisible();
  expect(((await api(owner, "GET", "/api/custom-fields")).body.fields as { field_name: string }[]).map((f) => f.field_name)).not.toContain("Acquisition channel");
});

test("fields & tags: agents see tags but not the custom-field catalogue, and can't write either", async ({ browser }) => {
  const agent = await addMember(owner, "agent");
  const { page } = await pageAs(browser, agent);
  await page.goto("/settings?tab=fields");
  await expect(page.getByRole("button", { name: "Delete Newsletter" })).toBeVisible();
  await expect(page.getByText("Custom fields", { exact: true })).toHaveCount(0);
  expect((await api(agent, "POST", "/api/tags", { name: "AgentTag", color: "#ef4444" })).status).toBe(403);
  expect((await api(agent, "POST", "/api/custom-fields", { field_name: "AgentField" })).status).toBe(403);
});

// ------------------------------------------------------------
// Deals & currency
// ------------------------------------------------------------

test("deals & currency: admins change the default currency; everyone sees it", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await page.goto("/settings?tab=deals");
  await expect(page.getByRole("main").getByRole("heading", { name: "Deals & currency" })).toBeVisible();
  const select = page.locator("select");
  await expect(select).toHaveValue("USD");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await select.selectOption("EUR");
  await save.click();
  await expect(page.getByText("Default currency updated")).toBeVisible();
  await expect(railItem(page, "Deals & currency")).toContainText("EUR");
  await expect(save).toBeDisabled();
  expect((await api(owner, "GET", "/api/me")).body.account.default_currency).toBe("EUR");

  await railItem(page, "Overview").click();
  await expect(tile(page, "Deals & currency")).toContainText("EUR — Euro");

  // Agents see it read-only and the API refuses them.
  const agent = await addMember(owner, "agent");
  const agentPage = (await pageAs(browser, agent)).page;
  await agentPage.goto("/settings?tab=deals");
  await expect(agentPage.locator("select")).toHaveValue("EUR");
  await expect(agentPage.locator("select")).toBeDisabled();
  await expect(agentPage.getByText("Only account admins can change the default currency.")).toBeVisible();
  await expect(agentPage.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  expect((await api(agent, "PATCH", "/api/deals/default-currency", { currency: "GBP" })).status).toBe(403);
  // Bad codes are refused.
  expect((await api(owner, "PATCH", "/api/deals/default-currency", { currency: "euro" })).status).toBe(400);

  await page.goto("/settings?tab=deals");
  await page.locator("select").selectOption("USD");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Default currency updated")).toBeVisible();
});

// ------------------------------------------------------------
// API keys
// ------------------------------------------------------------

test("API keys: create (shown once), copy, use, revoke → 401", async ({ browser }) => {
  const { page } = await pageAs(browser, owner);
  await page.goto("/settings?tab=api");
  await expect(page.getByRole("main").getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(page.getByText("No API keys yet.")).toBeVisible();

  await page.getByRole("button", { name: "New API key" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByText("Give the key a name")).toBeVisible();
  await dialog.getByLabel("Name").fill("Zapier sync");
  await dialog.getByText("contacts:read", { exact: true }).click();
  await dialog.getByRole("button", { name: "Create key" }).click();

  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Copy your API key" })).toBeVisible();
  await expect(dialog).toContainText("This is the only time the full key is shown.");
  const keyInput = dialog.locator("input[readonly]");
  const plaintext = await keyInput.inputValue();
  expect(plaintext.length).toBeGreaterThan(20);
  await dialog.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByText("API key copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(plaintext);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);

  // Listed by name + prefix only; the plaintext never comes back.
  const item = page.getByRole("main").getByRole("listitem").filter({ hasText: "Zapier sync" });
  await expect(item).toContainText("contacts:read");
  await expect(item).toContainText("never used");
  const listed = await api(owner, "GET", "/api/account/api-keys");
  const key = listed.body.keys.find((k: { name: string }) => k.name === "Zapier sync");
  expect(plaintext.startsWith(key.key_prefix)).toBe(true);
  expect(JSON.stringify(listed.body)).not.toContain(plaintext);
  await expect(item).toContainText(`${key.key_prefix}…`);

  // The key works against the public API, within its scopes.
  const bearer = { authorization: `Bearer ${plaintext}` };
  const me = await api(null, "GET", "/api/v1/me", undefined, bearer);
  expect(me.status).toBe(200);
  expect((await api(null, "GET", "/api/v1/contacts", undefined, bearer)).status).toBe(200);
  expect((await api(null, "POST", "/api/v1/contacts", { phone: randomCustomerPhone() }, bearer)).status).toBe(403);
  await page.reload();
  await expect(page.getByRole("main").getByRole("listitem").filter({ hasText: "Zapier sync" })).toContainText("last used");

  // Revoke.
  await page.getByRole("main").getByRole("listitem").filter({ hasText: "Zapier sync" }).getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText('Revoked "Zapier sync"')).toBeVisible();
  await expect(page.getByRole("main").getByRole("listitem").filter({ hasText: "Zapier sync" })).toContainText("Revoked");
  await expect(page.getByRole("main").getByRole("listitem").filter({ hasText: "Zapier sync" }).getByRole("button", { name: "Revoke" })).toHaveCount(0);
  expect((await api(null, "GET", "/api/v1/me", undefined, bearer)).status).toBe(401);
  expect((await api(null, "GET", "/api/v1/contacts", undefined, bearer)).status).toBe(401);
  // A made-up key is refused too.
  expect((await api(null, "GET", "/api/v1/me", undefined, { authorization: `Bearer ${key.key_prefix}notarealkey` })).status).toBe(401);
});

test("API keys: only admins can create or revoke", async ({ browser }) => {
  const agent = await addMember(owner, "agent");
  const created = await api(owner, "POST", "/api/account/api-keys", { name: "Admin made", scopes: [] });
  expect(created.status).toBeLessThan(300);

  const { page } = await pageAs(browser, agent);
  await page.goto("/settings?tab=api");
  await expect(page.getByRole("main").getByRole("listitem").filter({ hasText: "Admin made" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New API key" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);

  expect((await api(agent, "POST", "/api/account/api-keys", { name: "Agent key", scopes: [] })).status).toBe(403);
  expect((await api(agent, "DELETE", `/api/account/api-keys/${created.body.key.id}`)).status).toBe(403);
  // A no-scope key can still verify itself.
  const own = await api(null, "GET", "/api/v1/me", undefined, { authorization: `Bearer ${created.body.plaintext}` });
  expect(own.status).toBe(200);
});
