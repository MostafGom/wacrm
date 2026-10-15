// Plumbing check: account → fake WhatsApp number → customer message →
// live inbox → reply reaches the fake phone. If this fails, nothing
// else in the suite can pass.

import { expect, test } from "@playwright/test";

import { api, connectWhatsApp, newOwner, pageAs, syncTemplates } from "../support/accounts";
import { fakes, randomCustomerPhone } from "../support/fakes";

test("customer message appears live and the reply reaches the phone", async ({ browser }) => {
  const owner = await newOwner();
  const wa = await connectWhatsApp(owner);
  await syncTemplates(owner);
  const templates = await api(owner, "GET", "/api/whatsapp/templates?status=APPROVED");
  expect(templates.body.templates.map((t: { name: string }) => t.name)).toEqual(
    expect.arrayContaining(["order_update", "promo_image", "appointment_confirm"]),
  );

  const { page } = await pageAs(browser, owner);
  await page.goto("/inbox");
  await expect(page.getByText(/whatsapp.*not connected/i)).toHaveCount(0);

  const customer = randomCustomerPhone();
  await fakes.inbound({ from: customer, name: "Smoke Customer", phone_number_id: wa.phoneNumberId, text: "Hello there!" });

  // Realtime: no reload needed.
  await page.getByText("Smoke Customer").first().click();
  // .last(): the list preview shows the text too; the bubble comes after it.
  await expect(page.getByText("Hello there!").last()).toBeVisible();

  const box = page.getByPlaceholder(/type a message/i);
  await box.fill("Hi! How can we help?");
  await box.press("Enter");

  const [sent] = await fakes.waitForOutbound({ to: customer, phoneNumberId: wa.phoneNumberId }, (m) => m.type === "text");
  expect(sent.body.text.body).toBe("Hi! How can we help?");
});
