// WhatsApp connection (Settings → WhatsApp) and message templates
// (Settings → Templates), driven through the real UI against the fake
// Meta Graph API.

import { randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  addMember,
  api,
  connectWhatsApp,
  newOwner,
  pageAs,
  type Connection,
  type TestUser,
} from "../support/accounts";
import { FAKES_URL } from "../support/env";
import { fakes, randomPhoneNumberId } from "../support/fakes";

// A 1x1 PNG — enough for the header-image upload.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const toast = (page: Page, text: string | RegExp) =>
  page.locator("[data-sonner-toast]").filter({ hasText: text }).first();

const uniq = () => randomUUID().replace(/-/g, "").slice(0, 8);

interface TemplateRow {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  body_text: string;
  footer_text: string | null;
  header_type: string | null;
  header_media_url: string | null;
  buttons: Array<{ type: string; text: string }> | null;
  sample_values: { body?: string[]; header?: string[] } | null;
  meta_template_id: string | null;
  rejection_reason: string | null;
  quality_score: string | null;
}

async function templates(user: TestUser): Promise<TemplateRow[]> {
  const r = await api<{ templates: TemplateRow[] }>(user, "GET", "/api/whatsapp/templates");
  expect(r.status).toBe(200);
  return r.body.templates;
}

async function fakeTemplates(): Promise<Array<{ id: string; name: string; language: string; status: string }>> {
  const r = await fetch(`${FAKES_URL}/__sim/state`);
  return (await r.json()).templates;
}

// ============================================================
// Settings → WhatsApp
// ============================================================

test.describe("Settings → WhatsApp connection", () => {
  test.describe.configure({ mode: "serial" });

  let owner: TestUser;
  let agent: TestUser;
  let page: Page;
  const phoneNumberId = randomPhoneNumberId();
  const wabaId = `2${phoneNumberId.slice(1)}`;

  const phoneInput = () => page.getByPlaceholder("e.g. 100234567890123");
  const wabaInput = () => page.getByPlaceholder("e.g. 100234567890456");
  const tokenInput = () => page.getByPlaceholder("Enter your access token");
  const verifyInput = () => page.getByPlaceholder("Create a custom verify token");
  const pinInput = () => page.getByPlaceholder("6-digit PIN from Meta WhatsApp Manager");
  const saveButton = () => page.getByRole("button", { name: "Save Configuration" });

  test.beforeAll(async ({ browser }) => {
    owner = await newOwner("WhatsApp Owner");
    agent = await addMember(owner, "agent");
    ({ page } = await pageAs(browser, owner));
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("not-connected state and client-side form validation", async () => {
    await page.goto("/settings?tab=whatsapp");
    await expect(page.getByRole("heading", { name: "WhatsApp connection" })).toBeVisible();
    await expect(page.getByText("Not Connected", { exact: true })).toBeVisible();
    await expect(page.getByText(/Configure your Meta API credentials below/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Test API Connection" })).toBeDisabled();
    // No reset / registration / attachment UI until something is saved.
    await expect(page.getByRole("button", { name: "Reset Configuration" })).toHaveCount(0);
    await expect(page.getByText("Attachment Storage")).toHaveCount(0);

    await saveButton().click();
    await expect(toast(page, "Phone Number ID is required")).toBeVisible();

    await phoneInput().fill("+1 555 0100");
    await saveButton().click();
    await expect(toast(page, "Phone Number ID must contain only digits")).toBeVisible();

    await phoneInput().fill(phoneNumberId);
    await wabaInput().fill("my-waba");
    await saveButton().click();
    await expect(toast(page, "WhatsApp Business Account ID must contain only digits")).toBeVisible();

    await wabaInput().fill(wabaId);
    await saveButton().click();
    await expect(toast(page, "Access Token is required for initial setup")).toBeVisible();

    // PIN field strips non-digits (and is capped at 6 characters).
    await pinInput().fill("12ab56");
    await expect(pinInput()).toHaveValue("1256");
    await expect(pinInput()).toHaveAttribute("maxlength", "6");

    const view = await api(owner, "GET", "/api/whatsapp/config/settings");
    expect(view.body.config).toBeNull();
  });

  test("a bad access token shows Meta's error with the details to quote", async () => {
    await page.goto("/settings?tab=whatsapp");
    await phoneInput().fill(phoneNumberId);
    await wabaInput().fill(wabaId);
    await tokenInput().fill("bad-token");
    await saveButton().click();

    const failure = page.getByRole("alert").filter({ hasText: "Last save failed" });
    await expect(failure).toBeVisible();
    await expect(failure).toContainText("Meta rejected the access token as invalid");
    await expect(failure).toContainText("Meta error code: 190");
    await expect(failure).toContainText("Step: verify_number");
    await expect(failure).toContainText("Quote these details when contacting Meta support.");
    await expect(page.getByText("Not Connected", { exact: true })).toBeVisible();

    // Nothing was stored.
    const view = await api(owner, "GET", "/api/whatsapp/config/settings");
    expect(view.body.config).toBeNull();
    const health = await api(owner, "GET", "/api/whatsapp/config");
    expect(health.body).toMatchObject({ connected: false, reason: "no_config" });
  });

  test("connect a fresh number through the form", async () => {
    await page.goto("/settings?tab=whatsapp");
    await phoneInput().fill(phoneNumberId);
    await wabaInput().fill(wabaId);
    await tokenInput().fill("e2e-access-token");
    await verifyInput().fill(`verify-${phoneNumberId}`);
    await pinInput().fill("123456");
    await saveButton().click();

    await expect(toast(page, "Live — Fake Business can now receive events.")).toBeVisible();
    await expect(page.getByText("Credentials valid")).toBeVisible();
    await expect(page.getByText("Registered — Meta will deliver events to wacrm")).toBeVisible();
    await expect(page.getByText(/WhatsApp Business Account is subscribed to this app/)).toBeVisible();
    await expect(page.getByText("Last save failed")).toHaveCount(0);

    // Secrets are masked after save; the PIN is cleared.
    await expect(page.getByText("Token is hidden for security. Re-enter it to update configuration.")).toBeVisible();
    await expect(page.getByText("Saved. Leave as is to keep it, or enter a new value to rotate.")).toBeVisible();
    await expect(tokenInput()).not.toHaveValue("e2e-access-token");
    await expect(pinInput()).toHaveValue("");
    await expect(phoneInput()).toHaveValue(phoneNumberId);
    await expect(wabaInput()).toHaveValue(wabaId);

    // Persisted: the connection survives a reload and the API agrees.
    await page.reload();
    await expect(page.getByText("Credentials valid")).toBeVisible();
    await expect(phoneInput()).toHaveValue(phoneNumberId);

    const view = await api(owner, "GET", "/api/whatsapp/config/settings");
    expect(view.status).toBe(200);
    expect(view.body.config).toMatchObject({
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      has_verify_token: true,
    });
    expect(view.body.config.registered_at).toBeTruthy();
    expect(JSON.stringify(view.body)).not.toContain("e2e-access-token");

    const health = await api(owner, "GET", "/api/whatsapp/config");
    expect(health.body).toMatchObject({
      connected: true,
      phone_info: { id: phoneNumberId, verified_name: "Fake Business" },
      waba_subscription: { checked: true, subscribed: true },
    });

    // Teammates see the same saved connection.
    const agentView = await api(agent, "GET", "/api/whatsapp/config/settings");
    expect(agentView.body.config.phone_number_id).toBe(phoneNumberId);
  });

  test("Test API Connection and Verify with Meta", async () => {
    await page.goto("/settings?tab=whatsapp");
    await page.getByRole("button", { name: "Test API Connection" }).click();
    await expect(toast(page, "Connected to Fake Business")).toBeVisible();

    await page.getByRole("button", { name: "Verify with Meta" }).click();
    await expect(toast(page, "Number is fully wired — Meta is delivering events.")).toBeVisible();
    await expect(page.getByText("Registered — Meta will deliver events to wacrm")).toBeVisible();

    const probe = await api(owner, "GET", "/api/whatsapp/config/verify-registration");
    expect(probe.body.live).toBe(true);
    expect(probe.body.checks).toMatchObject({ phone_metadata_ok: true, waba_subscribed_to_app: true, locally_marked_registered: true });
  });

  test("Verify with Meta keeps its per-check diagnostic on screen", async () => {
    await page.goto("/settings?tab=whatsapp");
    await page.getByRole("button", { name: "Verify with Meta" }).click();
    await expect(toast(page, "Number is fully wired — Meta is delivering events.")).toBeVisible();
    const diag = page.getByText("Diagnostic — last run:");
    await expect(diag).toContainText("live");
    await expect(diag).not.toContainText("not live");
    for (const check of ["phone_metadata_ok", "waba_subscribed_to_app", "locally_marked_registered"]) {
      await expect(page.locator("code", { hasText: check })).toBeVisible();
    }
  });

  test("copy the webhook callback URL", async () => {
    await page.goto("/settings?tab=whatsapp");
    const expected = "http://localhost:3000/api/whatsapp/webhook";
    const urlInput = page.locator(`input[readonly][value="${expected}"]`);
    await expect(urlInput).toBeVisible();
    await urlInput.locator("xpath=..").getByRole("button").click();
    await expect(toast(page, "Webhook URL copied to clipboard")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
  });

  test("toggle inbound-media mirroring (persists)", async () => {
    await page.goto("/settings?tab=whatsapp");
    const toggle = page.getByRole("switch", { name: "Keep inbound attachments" });
    await expect(toggle).toBeChecked();
    await expect(page.getByText(/New attachments will stop being copied/)).toHaveCount(0);

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText(/New attachments will stop being copied/)).toBeVisible();
    await expect
      .poll(async () => (await api(owner, "GET", "/api/whatsapp/config/settings")).body.config.mirror_inbound_media)
      .toBe(false);

    await page.reload();
    await expect(page.getByRole("switch", { name: "Keep inbound attachments" })).not.toBeChecked();

    await page.getByRole("switch", { name: "Keep inbound attachments" }).click();
    await expect(page.getByRole("switch", { name: "Keep inbound attachments" })).toBeChecked();
    await expect
      .poll(async () => (await api(owner, "GET", "/api/whatsapp/config/settings")).body.config.mirror_inbound_media)
      .toBe(true);
  });

  test("re-saving an existing connection asks for the token again", async () => {
    await page.goto("/settings?tab=whatsapp");
    await expect(page.getByText("Credentials valid")).toBeVisible();
    await saveButton().click();
    await expect(toast(page, "Please re-enter the Access Token to save changes")).toBeVisible();

    // Rotating the token (no PIN → registration left untouched) works.
    await tokenInput().click();
    await tokenInput().fill("e2e-rotated-token");
    await saveButton().click();
    await expect(toast(page, /Live — Fake Business|Credentials saved and verified/)).toBeVisible();
    await expect(page.getByText("Registered — Meta will deliver events to wacrm")).toBeVisible();
  });

  test("agents see the connection but cannot change it", async ({ browser }) => {
    const { context, page: agentPage } = await pageAs(browser, agent);
    await agentPage.goto("/settings?tab=whatsapp");
    await expect(agentPage.getByText("Credentials valid")).toBeVisible();
    await expect(agentPage.getByRole("switch", { name: "Keep inbound attachments" })).toBeDisabled();
    await context.close();

    const post = await api(agent, "POST", "/api/whatsapp/config", {
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      access_token: "e2e-access-token",
    });
    expect(post.status).toBe(403);
    expect((await api(agent, "PATCH", "/api/whatsapp/config/settings", { mirror_inbound_media: false })).status).toBe(403);
    expect((await api(agent, "DELETE", "/api/whatsapp/config")).status).toBe(403);

    const view = await api(owner, "GET", "/api/whatsapp/config/settings");
    expect(view.body.config).toMatchObject({ phone_number_id: phoneNumberId, mirror_inbound_media: true });
  });

  test("another account cannot claim the same number", async () => {
    const other = await newOwner("Number Thief");
    const r = await api(other, "POST", "/api/whatsapp/config", {
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      access_token: "e2e-access-token",
      pin: "123456",
    });
    expect(r.status).toBe(409);
    expect((await api(other, "GET", "/api/whatsapp/config/settings")).body.config).toBeNull();
  });

  test("disconnect (Reset Configuration) with confirmation", async () => {
    await page.goto("/settings?tab=whatsapp");
    await expect(page.getByText("Credentials valid")).toBeVisible();

    // Dismissing the confirm keeps everything.
    page.once("dialog", (d) => void d.dismiss());
    await page.getByRole("button", { name: "Reset Configuration" }).click();
    await expect(page.getByText("Credentials valid")).toBeVisible();
    expect((await api(owner, "GET", "/api/whatsapp/config/settings")).body.config).not.toBeNull();

    page.once("dialog", (d) => {
      expect(d.message()).toContain("This will delete the current WhatsApp config");
      void d.accept();
    });
    await page.getByRole("button", { name: "Reset Configuration" }).click();
    await expect(toast(page, "Configuration cleared. You can now re-enter your credentials.")).toBeVisible();
    await expect(page.getByText("Not Connected", { exact: true })).toBeVisible();
    await expect(phoneInput()).toHaveValue("");
    await expect(page.getByRole("button", { name: "Reset Configuration" })).toHaveCount(0);

    expect((await api(owner, "GET", "/api/whatsapp/config/settings")).body.config).toBeNull();
    expect((await api(owner, "GET", "/api/whatsapp/config")).body).toMatchObject({ connected: false, reason: "no_config" });

    // The number is free again — the same account can reconnect it.
    await page.reload();
    await phoneInput().fill(phoneNumberId);
    await wabaInput().fill(wabaId);
    await tokenInput().fill("e2e-access-token");
    await pinInput().fill("123456");
    await saveButton().click();
    await expect(page.getByText("Credentials valid")).toBeVisible();
  });
});

// ============================================================
// Settings → Templates
// ============================================================

test.describe("Settings → Message templates", () => {
  test.describe.configure({ mode: "serial" });

  let owner: TestUser;
  let agent: TestUser;
  let wa: Connection;
  let page: Page;
  const suffix = uniq();
  const textName = `e2e_text_${suffix}`;
  const buttonsName = `e2e_buttons_${suffix}`;
  const imageName = `e2e_image_${suffix}`;

  const card = (name: string): Locator =>
    page.locator('[data-slot="card"]').filter({ has: page.getByRole("heading", { name, exact: true }) });
  const dialog = () => page.getByRole("dialog");

  async function openNewTemplate() {
    await page.getByRole("button", { name: "New Template" }).click();
    await expect(dialog().getByRole("heading", { name: "New Message Template" })).toBeVisible();
  }

  async function pickOption(trigger: Locator, option: string) {
    await trigger.click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }

  async function waitForStatus(name: string, status: string) {
    await expect
      .poll(async () => (await templates(owner)).find((t) => t.name === name)?.status, { timeout: 20_000 })
      .toBe(status);
  }

  test.beforeAll(async ({ browser }) => {
    owner = await newOwner("Template Owner");
    agent = await addMember(owner, "agent");
    wa = await connectWhatsApp(owner);
    ({ page } = await pageAs(browser, owner));
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("empty state, then Sync from Meta pulls the approved fixtures", async () => {
    await page.goto("/settings?tab=templates");
    await expect(page.getByRole("heading", { name: "Message templates" })).toBeVisible();
    await expect(page.getByText("No templates yet.")).toBeVisible();
    await expect(page.getByText("Create your first message template to get started.")).toBeVisible();

    await page.getByRole("button", { name: "Sync from Meta" }).click();
    await expect(toast(page, /Synced \d+ templates? from Meta/)).toBeVisible();

    const expectations = [
      { name: "order_update", category: "Utility", lang: "en_US", quality: "GREEN", body: "Hi {{1}}, your order {{2}} has shipped!" },
      { name: "promo_image", category: "Marketing", lang: "en_US", quality: "GREEN", body: "Hello {{1}}! This week only: {{2}} off everything." },
      { name: "appointment_confirm", category: "Utility", lang: "en", quality: null, body: "Can you make it to your appointment tomorrow?" },
    ];
    for (const e of expectations) {
      const c = card(e.name);
      await expect(c).toBeVisible();
      await expect(c).toContainText(e.category);
      await expect(c).toContainText("Approved");
      await expect(c).toContainText(e.lang);
      await expect(c).toContainText(e.body);
      if (e.quality) await expect(c).toContainText(e.quality);
      // Approved templates can be edited; all can be deleted.
      await expect(c.getByRole("button", { name: "Edit template" })).toBeVisible();
      await expect(c.getByRole("button", { name: "Delete template from Meta and locally" })).toBeVisible();
    }
    await expect(card("order_update")).toContainText("Fake Business"); // footer

    const rows = await templates(owner);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.order_update).toMatchObject({ status: "APPROVED", category: "Utility", language: "en_US", meta_template_id: "700000000000001", quality_score: "GREEN" });
    expect(byName.order_update.sample_values?.body).toEqual(["Jane", "#1001"]);
    expect(byName.promo_image).toMatchObject({ status: "APPROVED", category: "Marketing", header_type: "image" });
    expect(byName.appointment_confirm).toMatchObject({ status: "APPROVED", category: "Utility", language: "en" });
    expect(byName.appointment_confirm.buttons).toEqual([
      { type: "QUICK_REPLY", text: "Yes" },
      { type: "QUICK_REPLY", text: "No" },
    ]);

    // Sync is idempotent: a second run updates rather than duplicating.
    await page.getByRole("button", { name: "Sync from Meta" }).click();
    await expect(toast(page, /Synced \d+ templates? from Meta.*updated/)).toBeVisible();
    const again = await templates(owner);
    expect(again.filter((t) => t.name === "order_update")).toHaveLength(1);
  });

  test("validation errors in the New Template dialog", async () => {
    await page.goto("/settings?tab=templates");
    await openNewTemplate();
    const submit = dialog().getByRole("button", { name: "Submit for Approval" });
    const name = dialog().getByPlaceholder("e.g. order_confirmation");
    const body = dialog().getByPlaceholder("Hello {{1}}, your order {{2}} is confirmed.");

    await submit.click();
    await expect(toast(page, "Template name is required.")).toBeVisible();

    await name.fill("Bad Name!");
    await submit.click();
    await expect(toast(page, "Template name must use only lowercase letters, digits, and underscores")).toBeVisible();

    await name.fill(`e2e_invalid_${suffix}`);
    await submit.click();
    await expect(toast(page, "Body text is required.")).toBeVisible();

    await body.fill("Hello {{1}} and {{3}}");
    await submit.click();
    await expect(toast(page, "Body variables must be contiguous starting at {{1}}")).toBeVisible();

    // One sample row per variable; an empty sample is rejected.
    await body.fill("Hello {{1}}, meet {{2}}");
    await expect(dialog().getByLabel("Sample value for body variable {{1}}")).toBeVisible();
    await expect(dialog().getByLabel("Sample value for body variable {{2}}")).toBeVisible();
    await dialog().getByLabel("Sample value for body variable {{1}}").fill("Jane");
    await submit.click();
    await expect(toast(page, "Body sample value #2 is empty.")).toBeVisible();
    await dialog().getByLabel("Sample value for body variable {{2}}").fill("Bob");

    // Footer can't carry variables.
    await dialog().getByPlaceholder("Optional footer text (max 60 chars)").fill("Bye {{1}}");
    await submit.click();
    await expect(toast(page, "Footer text cannot contain {{N}} variables")).toBeVisible();
    await dialog().getByPlaceholder("Optional footer text (max 60 chars)").fill("");

    // A button without a label.
    await dialog().getByRole("button", { name: "Add Button" }).click();
    await submit.click();
    await expect(toast(page, "Button #1 (QUICK_REPLY) is missing text.")).toBeVisible();

    // URL button with a variable needs an example.
    const typeTriggers = dialog().getByRole("combobox");
    await pickOption(typeTriggers.nth(3), "URL");
    await dialog().getByPlaceholder("Button label").fill("Track");
    await dialog().getByPlaceholder("https://example.com/path or with {{1}} suffix").fill("https://example.com/t/{{1}}");
    await submit.click();
    await expect(toast(page, "URL button #1 uses {{1}} — Meta requires an example value.")).toBeVisible();

    // Authentication can't be built here: warning + disabled submit.
    await pickOption(typeTriggers.nth(0), "Authentication");
    await expect(dialog().getByText(/AUTHENTICATION templates have a fixed body/)).toBeVisible();
    await expect(submit).toBeDisabled();

    await dialog().getByRole("button", { name: "Cancel" }).click();
    await expect(dialog()).toHaveCount(0);

    // Nothing was created locally or on Meta.
    expect((await templates(owner)).some((t) => t.name === `e2e_invalid_${suffix}`)).toBe(false);
    expect((await fakeTemplates()).some((t) => t.name === `e2e_invalid_${suffix}`)).toBe(false);
    // The server enforces the same rules.
    const bad = await api(owner, "POST", "/api/whatsapp/templates/submit", {
      name: "Bad Name",
      category: "Utility",
      language: "en_US",
      body_text: "hi",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("Template name must use only lowercase");
  });

  test("submit a text template with variables → PENDING → APPROVED by Meta", async () => {
    await page.goto("/settings?tab=templates");
    await openNewTemplate();
    await pickOption(dialog().getByRole("combobox").nth(0), "Utility");
    await dialog().getByPlaceholder("e.g. order_confirmation").fill(textName);
    await pickOption(dialog().getByRole("combobox").nth(2), "Text");
    await dialog().getByLabel("Header text").fill("Order {{1}}");
    await dialog().getByLabel("Sample value for header variable").fill("#42");
    await dialog()
      .getByPlaceholder("Hello {{1}}, your order {{2}} is confirmed.")
      .fill("Hi {{1}}, your parcel {{2}} is on its way.");
    await dialog().getByLabel("Sample value for body variable {{1}}").fill("Jane");
    await dialog().getByLabel("Sample value for body variable {{2}}").fill("PX-1");
    await dialog().getByPlaceholder("Optional footer text (max 60 chars)").fill("E2E Shop");
    await dialog().getByRole("button", { name: "Submit for Approval" }).click();

    await expect(toast(page, "Submitted to Meta — typical review time is 24 hours.")).toBeVisible();
    await expect(dialog()).toHaveCount(0);
    const c = card(textName);
    await expect(c).toContainText("Pending");
    await expect(c).toContainText("Utility");
    await expect(c).toContainText("Hi {{1}}, your parcel {{2}} is on its way.");
    await expect(c).toContainText("E2E Shop");
    // Pending templates can't be edited yet.
    await expect(c.getByRole("button", { name: "Edit template" })).toHaveCount(0);

    // Meta received it with the components + examples.
    const onMeta = (await fakeTemplates()).find((t) => t.name === textName);
    expect(onMeta).toMatchObject({ language: "en_US" });

    const row = (await templates(owner)).find((t) => t.name === textName)!;
    expect(row).toMatchObject({
      status: expect.stringMatching(/PENDING|APPROVED/),
      category: "Utility",
      header_type: "text",
      footer_text: "E2E Shop",
      meta_template_id: onMeta!.id,
    });
    expect(row.sample_values).toEqual({ body: ["Jane", "PX-1"], header: ["#42"] });

    // The fake reviews it and sends the status webhook → APPROVED.
    await waitForStatus(textName, "APPROVED");
    await page.reload();
    await expect(card(textName)).toContainText("Approved");
    await expect(card(textName).getByRole("button", { name: "Edit template" })).toBeVisible();
  });

  test("submit a quick-reply buttons template", async () => {
    await page.goto("/settings?tab=templates");
    await openNewTemplate();
    await dialog().getByPlaceholder("e.g. order_confirmation").fill(buttonsName);
    await dialog().getByPlaceholder("Hello {{1}}, your order {{2}} is confirmed.").fill("Would you like a callback?");
    await dialog().getByRole("button", { name: "Add Button" }).click();
    await dialog().getByRole("button", { name: "Add Button" }).click();
    await dialog().getByPlaceholder("Button label").nth(0).fill("Yes please");
    await dialog().getByPlaceholder("Button label").nth(1).fill("No thanks");
    await dialog().getByRole("button", { name: "Submit for Approval" }).click();
    await expect(toast(page, "Submitted to Meta")).toBeVisible();
    await expect(card(buttonsName)).toContainText("Marketing");

    await waitForStatus(buttonsName, "APPROVED");
    const row = (await templates(owner)).find((t) => t.name === buttonsName)!;
    expect(row.category).toBe("Marketing");
    expect(row.buttons).toEqual([
      { type: "QUICK_REPLY", text: "Yes please" },
      { type: "QUICK_REPLY", text: "No thanks" },
    ]);
    await page.reload();
    await expect(card(buttonsName)).toContainText("Approved");
  });

  test("IMAGE header: upload a sample image in the dialog", async () => {
    await page.goto("/settings?tab=templates");
    await openNewTemplate();
    await pickOption(dialog().getByRole("combobox").nth(2), "Image");
    await expect(dialog().getByRole("button", { name: "Upload image" })).toBeVisible();

    // Wrong type is refused client-side.
    await dialog().locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await expect(toast(page, "Header image must be a JPEG or PNG.")).toBeVisible();

    await dialog().locator('input[type="file"]').setInputFiles({ name: "header.png", mimeType: "image/png", buffer: PNG_1X1 });
    await expect(toast(page, "File uploaded.")).toBeVisible();
    const urlBox = dialog().getByPlaceholder("https://… (or paste a public image link)");
    await expect(urlBox).toHaveValue(/^http.+\.png$/);
    await expect(dialog().getByRole("img", { name: "Header sample" })).toBeVisible();

    // The uploaded file is served back.
    const res = await page.request.get(await urlBox.inputValue());
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    await dialog().getByRole("button", { name: "Cancel" }).click();
  });

  test("IMAGE header: submit goes through Meta's resumable upload", async () => {
    // The submit route fetches the uploaded header image server-side (the
    // stack allow-lists localhost), uploads it to Meta's resumable upload
    // and submits the template with the returned handle.
    await page.goto("/settings?tab=templates");
    await openNewTemplate();
    await dialog().getByPlaceholder("e.g. order_confirmation").fill(imageName);
    await pickOption(dialog().getByRole("combobox").nth(2), "Image");
    await dialog().locator('input[type="file"]').setInputFiles({ name: "header.png", mimeType: "image/png", buffer: PNG_1X1 });
    await expect(toast(page, "File uploaded.")).toBeVisible();
    await expect(dialog().getByPlaceholder("https://… (or paste a public image link)")).toHaveValue(
      /^http:\/\/localhost:3000\/api\/storage\/public\/.+\.png$/,
    );
    await dialog().getByPlaceholder("Hello {{1}}, your order {{2}} is confirmed.").fill("Look at this!");
    await dialog().getByRole("button", { name: "Submit for Approval" }).click();
    await expect(toast(page, "Submitted to Meta")).toBeVisible();
    await expect(dialog()).toHaveCount(0);
    await expect(card(imageName)).toContainText("Pending");

    // Meta received an IMAGE header whose example is the resumable-upload handle.
    const res = await fetch(`${FAKES_URL}/v21.0/${wa.wabaId}/message_templates`, {
      headers: { authorization: "Bearer e2e-access-token" },
    });
    const onMeta = ((await res.json()).data as Array<{ id: string; name: string; components: Array<Record<string, any>> }>).find( // eslint-disable-line @typescript-eslint/no-explicit-any
      (t) => t.name === imageName,
    );
    expect(onMeta).toBeTruthy();
    const header = onMeta!.components.find((c) => c.type === "HEADER");
    expect(header).toMatchObject({ format: "IMAGE" });
    expect(header!.example.header_handle[0]).toMatch(/^4::fakehandle/);

    await waitForStatus(imageName, "APPROVED");
    const row = (await templates(owner)).find((t) => t.name === imageName)!;
    expect(row).toMatchObject({ header_type: "image", meta_template_id: onMeta!.id });
    expect(row.header_media_url).toMatch(/\/api\/storage\/public\/.+\.png$/);
    await page.reload();
    await expect(card(imageName)).toContainText("Approved");
  });

  test("edit an approved template → resubmitted as PENDING", async () => {
    await page.goto("/settings?tab=templates");
    await card(textName).getByRole("button", { name: "Edit template" }).click();
    await expect(dialog().getByRole("heading", { name: "Edit Message Template" })).toBeVisible();
    await expect(dialog().getByPlaceholder("e.g. order_confirmation")).toBeDisabled();
    await expect(dialog().getByPlaceholder("e.g. order_confirmation")).toHaveValue(textName);
    await expect(dialog().getByText("Name is fixed once a template exists on Meta")).toBeVisible();
    await expect(dialog().getByLabel("Sample value for body variable {{1}}")).toHaveValue("Jane");

    const body = dialog().getByPlaceholder("Hello {{1}}, your order {{2}} is confirmed.");
    await body.fill("Hi {{1}}, parcel {{2}} arrives tomorrow.");
    await dialog().getByLabel("Sample value for body variable {{2}}").fill("PX-2");
    await dialog().getByRole("button", { name: "Save & Resubmit" }).click();
    await expect(toast(page, "Edit submitted — Meta typically reviews within 24 hours.")).toBeVisible();
    await expect(card(textName)).toContainText("Pending");
    await expect(card(textName)).toContainText("Hi {{1}}, parcel {{2}} arrives tomorrow.");

    const row = (await templates(owner)).find((t) => t.name === textName)!;
    expect(row.status).toBe("PENDING");
    expect(row.body_text).toBe("Hi {{1}}, parcel {{2}} arrives tomorrow.");
    expect(row.sample_values?.body).toEqual(["Jane", "PX-2"]);
  });

  test("a REJECTED status webhook shows the reason and a Resubmit action", async () => {
    const row = (await templates(owner)).find((t) => t.name === buttonsName)!;
    const event = {
      template_id: row.meta_template_id!,
      name: buttonsName,
      language: "en_US",
      event: "REJECTED",
      waba_id: wa.wabaId,
      reason: "INVALID_FORMAT",
    };
    await fakes.templateStatus(event);
    await waitForStatus(buttonsName, "REJECTED");

    await page.goto("/settings?tab=templates");
    const c = card(buttonsName);
    await expect(c).toContainText("Rejected");
    await expect(c).toContainText("INVALID_FORMAT");
    await expect(c.getByRole("button", { name: "Edit and resubmit template" })).toBeVisible();
    await expect(c.getByRole("button", { name: "Edit template" })).toHaveCount(0);

    // Resubmitting clears the rejection and goes back to review.
    await c.getByRole("button", { name: "Edit and resubmit template" }).click();
    await dialog().getByPlaceholder("Button label").nth(1).fill("Not now");
    await dialog().getByRole("button", { name: "Save & Resubmit" }).click();
    await expect(toast(page, "Edit submitted")).toBeVisible();
    await expect(card(buttonsName)).toContainText("Pending");
    await expect(card(buttonsName)).not.toContainText("INVALID_FORMAT");
    const after = (await templates(owner)).find((t) => t.name === buttonsName)!;
    expect(after).toMatchObject({ status: "PENDING", rejection_reason: null });
    expect(after.buttons?.[1]).toEqual({ type: "QUICK_REPLY", text: "Not now" });
  });

  test("delete a template (with confirmation) from Meta and locally", async () => {
    await page.goto("/settings?tab=templates");
    await card(textName).getByRole("button", { name: "Delete template from Meta and locally" }).click();
    await expect(dialog().getByRole("heading", { name: "Delete template?" })).toBeVisible();
    await expect(dialog()).toContainText(`"${textName}" will be deleted from Meta and from wacrm.`);
    await dialog().getByRole("button", { name: "Cancel" }).click();
    await expect(card(textName)).toBeVisible();

    await card(textName).getByRole("button", { name: "Delete template from Meta and locally" }).click();
    await dialog().getByRole("button", { name: "Delete", exact: true }).click();
    await expect(toast(page, "Template deleted")).toBeVisible();
    await expect(card(textName)).toHaveCount(0);

    expect((await templates(owner)).some((t) => t.name === textName)).toBe(false);
    expect((await fakeTemplates()).some((t) => t.name === textName)).toBe(false);
    await page.reload();
    await expect(card(textName)).toHaveCount(0);
    await expect(card(buttonsName)).toBeVisible();
  });

  test("only admins can submit, sync or delete templates", async () => {
    const submit = await api(agent, "POST", "/api/whatsapp/templates/submit", {
      name: `e2e_agent_${suffix}`,
      category: "Utility",
      language: "en_US",
      body_text: "Hello",
    });
    expect(submit.status).toBe(403);
    expect((await api(agent, "POST", "/api/whatsapp/templates/sync")).status).toBe(403);
    const target = (await templates(owner)).find((t) => t.name === buttonsName)!;
    expect((await api(agent, "DELETE", `/api/whatsapp/templates/${target.id}`)).status).toBe(403);
    expect((await fakeTemplates()).some((t) => t.name === `e2e_agent_${suffix}`)).toBe(false);
    // The agent can still read the catalog (it powers the inbox picker).
    const list = await api(agent, "GET", "/api/whatsapp/templates?status=APPROVED");
    expect(list.status).toBe(200);
    expect(list.body.templates.map((t: TemplateRow) => t.name)).toContain("order_update");
  });

  test("submitting without a WhatsApp connection explains why", async () => {
    const lonely = await newOwner("No WhatsApp");
    const r = await api(lonely, "POST", "/api/whatsapp/templates/submit", {
      name: `e2e_nowa_${suffix}`,
      category: "Utility",
      language: "en_US",
      body_text: "Hello",
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/whatsapp|connect/i);
  });
});
