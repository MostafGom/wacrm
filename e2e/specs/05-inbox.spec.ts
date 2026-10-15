// Inbox: live inbound, every outbound message kind (checked on the fake
// Meta side), every inbound kind, delivery ticks, conversation
// management, the 24-hour window, the contact sidebar, search + filters.

import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { addMember, api, connectWhatsApp, newOwner, pageAs, sql, syncTemplates, type Connection, type TestUser } from "../support/accounts";
import { fakes, randomCustomerPhone, type OutboundMessage } from "../support/fakes";
import {
  assignMenu,
  conversationItem,
  listFilter,
  listMessages,
  messageRow,
  openConversation,
  sendButton,
  sendText,
  statusMenu,
  threadArea,
  threadHeader,
  waitForConversation,
  waitForMessage,
} from "../support/inbox";

const FIXTURES = path.join(__dirname, "..", "fixtures", "inbox");

// Tests share one owner + business number (set up once per worker) but each
// uses its own customer, so they don't depend on each other's outcome.
let owner: TestUser;
let agent: TestUser;
let wa: Connection;
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  owner = await newOwner("Inbox Owner");
  agent = await addMember(owner, "agent", "Andy Agent");
  wa = await connectWhatsApp(owner);
  await syncTemplates(owner);
  ({ context, page } = await pageAs(browser, owner));
  // Wide enough for list + thread + contact panel side by side (at 1280px
  // the thread header squeezes the contact name to zero width).
  await page.setViewportSize({ width: 1600, height: 1000 });
});

test.afterAll(async () => {
  await context?.close();
});

/** A customer writes in; returns phone + display name + inbound wamid. */
async function customerSays(text: string, name = `Cust ${Math.random().toString(36).slice(2, 7)}`) {
  const phone = randomCustomerPhone();
  const { id } = await fakes.inbound({ from: phone, name, phone_number_id: wa.phoneNumberId, text });
  return { phone, name, wamid: id };
}

const outboundTo = (phone: string, pred: (m: OutboundMessage) => boolean = () => true, count = 1) =>
  fakes.waitForOutbound({ to: phone, phoneNumberId: wa.phoneNumberId }, pred, count);

// ------------------------------------------------------------
// Inbound
// ------------------------------------------------------------

test("an inbound text appears live and bumps the unread count", async () => {
  await page.goto("/inbox");
  await expect(page.getByPlaceholder("Search conversations...")).toBeVisible();

  const phone = randomCustomerPhone();
  const name = `Live ${Date.now().toString(36)}`;
  await fakes.inbound({ from: phone, name, phone_number_id: wa.phoneNumberId, text: "First ping" });

  // No reload: the new conversation surfaces with its preview + badge "1".
  const row = conversationItem(page, name);
  await expect(row).toBeVisible();
  await expect(row).toContainText("First ping");
  await expect(row.getByText("1", { exact: true })).toBeVisible();

  await fakes.inbound({ from: phone, name, phone_number_id: wa.phoneNumberId, text: "Second ping" });
  await expect(row).toContainText("Second ping");
  await expect(row.getByText("2", { exact: true })).toBeVisible();

  const conv = await waitForConversation(owner, phone);
  expect(conv.unread_count).toBe(2);

  // The sidebar's Inbox entry carries an unread dot while elsewhere.
  await page.goto("/dashboard");
  await expect(page.getByLabel(/unread conversations?/)).toBeVisible();

  // Opening the thread clears the badge, server-side too.
  await openConversation(page, name);
  await expect(threadArea(page).getByText("Second ping")).toBeVisible();
  await expect(row.getByText("2", { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await waitForConversation(owner, phone)).unread_count).toBe(0);

  // A message arriving while the thread is open shows up in it directly.
  await fakes.inbound({ from: phone, name, phone_number_id: wa.phoneNumberId, text: "Third ping" });
  await expect(threadArea(page).getByText("Third ping")).toBeVisible();
});

// ------------------------------------------------------------
// Outbound
// ------------------------------------------------------------

test("a text reply reaches the customer", async () => {
  const c = await customerSays("Do you ship to Spain?");
  await openConversation(page, c.name);
  await sendText(page, "Yes, we ship to all of the EU.");

  const [sent] = await outboundTo(c.phone, (m) => m.type === "text");
  expect(sent.body.text.body).toBe("Yes, we ship to all of the EU.");
  expect(sent.body.to).toBe(c.phone.replace(/\D/g, ""));
  await expect(messageRow(page, "Yes, we ship to all of the EU.")).toBeVisible();

  const conv = await waitForConversation(owner, c.phone);
  const stored = await waitForMessage(owner, conv.id, (m) => m.content_text === "Yes, we ship to all of the EU.");
  expect(stored.sender_type).toBe("agent");
  expect(stored.message_id).toBe(sent.id);
});

test("a quoted reply sends context.message_id", async () => {
  const c = await customerSays("Where is my order #4411?");
  await openConversation(page, c.name);

  const inbound = messageRow(page, "Where is my order #4411?");
  await inbound.hover();
  await inbound.getByRole("button", { name: "Reply" }).click();
  // The composer shows the quote chip.
  await expect(page.getByRole("button", { name: "Cancel reply" })).toBeVisible();
  await sendText(page, "It left the warehouse this morning.");
  await expect(page.getByRole("button", { name: "Cancel reply" })).toHaveCount(0);

  const [sent] = await outboundTo(c.phone, (m) => m.type === "text");
  expect(sent.body.text.body).toBe("It left the warehouse this morning.");
  expect(sent.body.context?.message_id).toBe(c.wamid);

  // The bubble renders the quote above the reply.
  const reply = messageRow(page, "It left the warehouse this morning.");
  await expect(reply).toContainText("Where is my order #4411?");
});

test("image and document uploads are sent as public links that serve the bytes", async () => {
  const c = await customerSays("Can you send me the price list?");
  await openConversation(page, c.name);

  // --- image ---
  const imageChooser = page.waitForEvent("filechooser");
  await page.getByTitle("Attach media").click();
  await page.getByRole("menuitem", { name: "Photo" }).click();
  await (await imageChooser).setFiles(path.join(FIXTURES, "photo.png"));
  const caption = page.getByPlaceholder("Add a caption…");
  await expect(caption).toBeVisible();
  await caption.fill("Our storefront");
  await caption.press("Enter");

  const [img] = await outboundTo(c.phone, (m) => m.type === "image");
  expect(img.body.image.caption).toBe("Our storefront");
  const imgRes = await fetch(img.body.image.link);
  expect(imgRes.status).toBe(200);
  expect(Buffer.from(await imgRes.arrayBuffer()).equals(readFileSync(path.join(FIXTURES, "photo.png")))).toBe(true);
  await expect(messageRow(page, "Our storefront").getByRole("img", { name: "Shared image" })).toBeVisible();

  // --- document ---
  const docChooser = page.waitForEvent("filechooser");
  await page.getByTitle("Attach media").click();
  await page.getByRole("menuitem", { name: "Document" }).click();
  await (await docChooser).setFiles(path.join(FIXTURES, "price-list.pdf"));
  await expect(page.getByText("price-list.pdf")).toBeVisible();
  await sendButton(page).click();

  const [doc] = await outboundTo(c.phone, (m) => m.type === "document");
  expect(doc.body.document.filename).toBe("price-list.pdf");
  const docRes = await fetch(doc.body.document.link);
  expect(docRes.status).toBe(200);
  expect(Buffer.from(await docRes.arrayBuffer()).equals(readFileSync(path.join(FIXTURES, "price-list.pdf")))).toBe(true);
  await expect(messageRow(page, "price-list.pdf").getByRole("link", { name: /price-list\.pdf/ })).toBeVisible();
});

test("a recorded voice note is sent as Ogg/Opus audio", async () => {
  const c = await customerSays("Could you explain by voice?");
  await openConversation(page, c.name);

  await page.getByTitle("Attach media").click();
  await page.getByRole("menuitem", { name: "Voice note" }).click();
  await expect(page.getByText(/Recording… 0:0[1-9]/)).toBeVisible();
  await page.getByTitle("Stop and attach").click();

  // Staged as an audio draft (no caption field for audio).
  await expect(page.getByRole("button", { name: "Remove attachment" })).toBeVisible();
  await expect(page.getByPlaceholder("Add a caption…")).toHaveCount(0);
  await sendButton(page).click();

  const [voice] = await outboundTo(c.phone, (m) => m.type === "audio");
  expect(voice.body.audio.caption).toBeUndefined();
  const res = await fetch(voice.body.audio.link);
  expect(res.status).toBe(200);
  const bytes = Buffer.from(await res.arrayBuffer());
  expect(bytes.subarray(0, 4).toString("ascii")).toBe("OggS");
  expect(bytes.includes(Buffer.from("OpusHead"))).toBe(true);
  await expect(threadArea(page).locator("audio")).toHaveCount(1);
});

test("a template with variables is sent with its parameters", async () => {
  const c = await customerSays("Any update on my parcel?");
  await openConversation(page, c.name);

  await page.getByTitle("Send template").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /order_update/ }).click();
  const send = dialog.getByRole("button", { name: "Send template" });
  await expect(send).toBeDisabled();
  await dialog.getByPlaceholder("Value for {{1}}").fill("Jane");
  await expect(send).toBeDisabled();
  await dialog.getByPlaceholder("Value for {{2}}").fill("#7781");
  await expect(dialog).toContainText("Hi Jane, your order #7781 has shipped!");
  await send.click();
  await expect(dialog).toHaveCount(0);

  const [tpl] = await outboundTo(c.phone, (m) => m.type === "template");
  expect(tpl.body.template.name).toBe("order_update");
  expect(tpl.body.template.language.code).toBe("en_US");
  const body = tpl.body.template.components.find((x: { type: string }) => x.type === "body");
  expect(body.parameters.map((p: { text: string }) => p.text)).toEqual(["Jane", "#7781"]);
  await expect(messageRow(page, "Hi Jane, your order #7781 has shipped!")).toContainText("Template");
});

test("interactive reply buttons and an interactive list are sent", async () => {
  const c = await customerSays("What are my options?");
  await openConversation(page, c.name);

  // --- reply buttons ---
  await page.getByTitle("More").click();
  await page.getByRole("menuitem", { name: "Interactive message" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("What the customer reads above the options").fill("Pick a delivery slot");
  await dialog.getByPlaceholder("Button label").fill("Morning");
  await dialog.getByRole("button", { name: "Add button" }).click();
  await dialog.getByPlaceholder("Button label").nth(1).fill("Evening");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const [buttons] = await outboundTo(c.phone, (m) => m.type === "interactive" && m.body.interactive.type === "button");
  expect(buttons.body.interactive.body.text).toBe("Pick a delivery slot");
  expect(buttons.body.interactive.action.buttons.map((b: { reply: { title: string } }) => b.reply.title)).toEqual(["Morning", "Evening"]);

  // --- list ---
  await page.getByTitle("More").click();
  await page.getByRole("menuitem", { name: "Interactive message" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "List", exact: true }).click();
  await dialog.getByPlaceholder("What the customer reads above the options").fill("Choose a plan");
  await dialog.getByPlaceholder("Row title").fill("Basic");
  await dialog.getByRole("button", { name: "Add row" }).click();
  await dialog.getByPlaceholder("Row title").nth(1).fill("Pro");
  await dialog.getByPlaceholder("Description (optional)").nth(1).fill("Everything included");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const [list] = await outboundTo(c.phone, (m) => m.type === "interactive" && m.body.interactive.type === "list");
  expect(list.body.interactive.body.text).toBe("Choose a plan");
  expect(list.body.interactive.action.button).toBe("Menu");
  const rows = list.body.interactive.action.sections.flatMap((s: { rows: { title: string; description?: string }[] }) => s.rows);
  expect(rows.map((r: { title: string }) => r.title)).toEqual(["Basic", "Pro"]);
  expect(rows[1].description).toBe("Everything included");

  await expect(messageRow(page, "Pick a delivery slot")).toContainText("Morning");
  await expect(messageRow(page, "Choose a plan")).toBeVisible();
});

test("a quick reply fills the composer and is sent", async () => {
  const title = `Hours ${Date.now().toString(36)}`;
  const text = "We are open 9am-6pm, Monday to Saturday.";
  const created = await api(owner, "POST", "/api/quick-replies", { title, kind: "text", content_text: text });
  expect(created.status).toBeLessThan(300);

  const c = await customerSays("When are you open?");
  await openConversation(page, c.name);
  await page.getByTitle("More").click();
  await page.getByRole("menuitem", { name: "Quick replies" }).click();
  await page.getByRole("dialog").getByRole("button", { name: new RegExp(title) }).click();
  const box = page.getByPlaceholder(/type a message/i);
  await expect(box).toHaveValue(text);
  await box.press("Enter");

  const [sent] = await outboundTo(c.phone, (m) => m.type === "text");
  expect(sent.body.text.body).toBe(text);
});

test("an emoji reaction is sent to the customer's message", async () => {
  const c = await customerSays("Thanks, that worked!");
  await openConversation(page, c.name);

  const row = messageRow(page, "Thanks, that worked!");
  await row.hover();
  await row.getByRole("button", { name: "React" }).click();
  await page.getByRole("button", { name: "React with ❤️" }).click();

  const [reaction] = await outboundTo(c.phone, (m) => m.type === "reaction");
  expect(reaction.body.reaction).toEqual({ message_id: c.wamid, emoji: "❤️" });
  await expect(row.getByRole("button", { name: /❤️/ })).toHaveAttribute("aria-pressed", "true");
});

// ------------------------------------------------------------
// Inbound message kinds
// ------------------------------------------------------------

test("inbound image, document, audio and video are mirrored and viewable", async () => {
  const c = await customerSays("Sending you some files");
  await openConversation(page, c.name);
  const conv = await waitForConversation(owner, c.phone);

  await fakes.inbound({ from: c.phone, phone_number_id: wa.phoneNumberId, media: { kind: "image", caption: "Broken part photo" } });
  await fakes.inbound({ from: c.phone, phone_number_id: wa.phoneNumberId, media: { kind: "document", filename: "invoice.pdf" } });
  await fakes.inbound({ from: c.phone, phone_number_id: wa.phoneNumberId, media: { kind: "audio" } });
  await fakes.inbound({ from: c.phone, phone_number_id: wa.phoneNumberId, media: { kind: "video", caption: "Unboxing clip" } });

  const mirrored = (kind: string) =>
    waitForMessage(owner, conv.id, (m) => m.content_type === kind && !!m.media_url, `inbound ${kind}`);
  const [image, document, audio, video] = [await mirrored("image"), await mirrored("document"), await mirrored("audio"), await mirrored("video")];

  // Mirrored into the app's own public storage (not the Meta proxy).
  for (const m of [image, document, audio, video]) {
    expect(m.media_url).toContain("/api/storage/public/chat-media/");
    const res = await fetch(m.media_url!);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }
  expect(Buffer.from(await (await fetch(document.media_url!)).arrayBuffer()).subarray(0, 4).toString("ascii")).toBe("%PDF");
  expect(Buffer.from(await (await fetch(image.media_url!)).arrayBuffer()).subarray(1, 4).toString("ascii")).toBe("PNG");

  // Image: inline, and opens in the viewer.
  const imageRow = messageRow(page, "Broken part photo");
  await expect(imageRow.getByRole("img", { name: "Shared image" })).toBeVisible();
  await imageRow.getByRole("button", { name: "View image" }).click();
  const viewer = page.getByRole("dialog");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);

  // Document: a link to the mirrored file.
  await expect(messageRow(page, "invoice.pdf").getByRole("link", { name: /invoice\.pdf/ })).toHaveAttribute("href", document.media_url!);
  // Audio + video: native players on the mirrored URLs.
  await expect(threadArea(page).locator(`audio[src="${audio.media_url}"]`)).toHaveCount(1);
  const videoRow = messageRow(page, "Unboxing clip");
  await expect(videoRow.locator(`video[src="${video.media_url}"]`)).toHaveCount(1);
  await videoRow.getByRole("button", { name: "Expand video" }).click();
  await expect(page.getByRole("dialog").locator("video")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("inbound location, reaction, button_reply and list_reply render", async () => {
  const c = await customerSays("Hi, quick question");
  await openConversation(page, c.name);
  await sendText(page, "Sure, ask away!");
  const [ours] = await outboundTo(c.phone, (m) => m.type === "text");

  await fakes.inbound({ from: c.phone, phone_number_id: wa.phoneNumberId, location: { latitude: 52.52, longitude: 13.405, name: "Alexanderplatz" } });
  await expect(threadArea(page).getByText("Alexanderplatz - 52.52,13.405")).toBeVisible();

  await fakes.inbound({ from: c.phone, phone_number_id: wa.phoneNumberId, reaction: { message_id: ours.id, emoji: "👍" } });
  await expect(messageRow(page, "Sure, ask away!").getByRole("button", { name: /👍/ })).toBeVisible();

  await fakes.inbound({ from: c.phone, phone_number_id: wa.phoneNumberId, button_reply: { id: "slot_am", title: "Morning slot" } });
  const btn = messageRow(page, "Morning slot");
  await expect(btn).toContainText("Button reply");

  await fakes.inbound({ from: c.phone, phone_number_id: wa.phoneNumberId, list_reply: { id: "plan_pro", title: "Pro plan", description: "All features" } });
  await expect(messageRow(page, "Pro plan")).toContainText("Button reply");
});

// ------------------------------------------------------------
// Delivery state
// ------------------------------------------------------------

test("ticks move sent → delivered automatically, then read", async () => {
  const c = await customerSays("Status check");
  await openConversation(page, c.name);
  await sendText(page, "Tick tock");
  const [sent] = await outboundTo(c.phone, (m) => m.type === "text");
  const conv = await waitForConversation(owner, c.phone);

  // The fake reports sent then delivered (status webhooks) on its own.
  const row = messageRow(page, "Tick tock");
  await expect(row.locator("svg.lucide-check-check")).toBeVisible();
  await expect(row.locator("svg.lucide-check-check")).not.toHaveClass(/text-blue-400/);
  await expect.poll(async () => (await waitForMessage(owner, conv.id, (m) => m.message_id === sent.id)).status).toBe("delivered");

  await fakes.setStatus(sent.id, "read");
  await expect(row.locator("svg.lucide-check-check")).toHaveClass(/text-blue-400/);
  await expect.poll(async () => (await waitForMessage(owner, conv.id, (m) => m.message_id === sent.id)).status).toBe("read");
});

test("an undeliverable send shows as failed with Meta's reason", async () => {
  const phone = "+15550000999";
  const name = `Unreachable ${Date.now().toString(36)}`;
  await fakes.inbound({ from: phone, name, phone_number_id: wa.phoneNumberId, text: "Ping from a dead phone" });
  await openConversation(page, name);
  await sendText(page, "Will this arrive?");

  const row = messageRow(page, "Will this arrive?");
  await expect(row).toContainText("Not delivered: Message undeliverable");
  await expect(row).toContainText("Receiver is incapable of receiving this message");
  const conv = await waitForConversation(owner, phone);
  const stored = await waitForMessage(owner, conv.id, (m) => m.content_text === "Will this arrive?");
  await expect.poll(async () => (await waitForMessage(owner, conv.id, (m) => m.id === stored.id)).status).toBe("failed");
});

test("a send Meta rejects outright shows an error", async () => {
  const phone = "+15550000998";
  const name = `Rejected ${Date.now().toString(36)}`;
  // On 131030 the app retries with trunk-prefix variants of the number;
  // the fake rejects every variant of a reject number (zeros stripped).
  await fakes.inbound({ from: phone, name, phone_number_id: wa.phoneNumberId, text: "Hello from a blocked number" });
  await openConversation(page, name);
  await sendText(page, "This one bounces");

  await expect(page.getByText(/Failed to send: .*131030.*not in allowed list/)).toBeVisible();
  const row = messageRow(page, "This one bounces");
  await expect(row.locator("svg.lucide-circle-x, svg.lucide-x-circle")).toBeVisible();
  // Nothing was persisted as sent.
  const conv = await waitForConversation(owner, phone);
  const msgs = await listMessages(owner, conv.id);
  expect(msgs.some((m) => m.content_text === "This one bounces")).toBe(false);
  expect(await fakes.outbound({ phoneNumberId: wa.phoneNumberId }).then((all) => all.filter((m) => m.body.text?.body === "This one bounces"))).toHaveLength(0);
  // The contact keeps its number (no "auto-corrected" variant).
  expect(conv.contact?.phone?.replace(/\D/g, "")).toBe("15550000998");
});

// ------------------------------------------------------------
// Conversation management
// ------------------------------------------------------------

test("a conversation can be assigned to an agent", async () => {
  const c = await customerSays("Who will help me?");
  await openConversation(page, c.name);
  await assignMenu(page).click();
  await page.getByRole("menuitem", { name: /Andy Agent/ }).click();
  // Below 2xl the trigger is icon-only; the name is its accessible name.
  await expect(assignMenu(page)).toHaveAccessibleName("Andy Agent");
  await expect.poll(async () => (await waitForConversation(owner, c.phone)).assigned_agent_id).toBe(agent.userId);

  // Unassign again.
  await assignMenu(page).click();
  await page.getByRole("menuitem", { name: "Unassign" }).click();
  await expect(assignMenu(page)).toHaveAccessibleName("Assign");
  await expect.poll(async () => (await waitForConversation(owner, c.phone)).assigned_agent_id ?? null).toBeNull();
});

test("status goes open → pending → closed, and a new inbound message reopens it", async () => {
  const c = await customerSays("I need help with a return");
  await openConversation(page, c.name);
  await expect(statusMenu(page)).toHaveText("Open");

  await statusMenu(page).click();
  await page.getByRole("menuitem", { name: "Pending" }).click();
  await expect(statusMenu(page)).toHaveText("Pending");
  await expect.poll(async () => (await waitForConversation(owner, c.phone)).status).toBe("pending");

  await statusMenu(page).click();
  await page.getByRole("menuitem", { name: "Closed" }).click();
  await expect(statusMenu(page)).toHaveText("Closed");
  await expect.poll(async () => (await waitForConversation(owner, c.phone)).status).toBe("closed");

  await fakes.inbound({ from: c.phone, phone_number_id: wa.phoneNumberId, text: "Actually, one more thing" });
  await expect(threadArea(page).getByText("Actually, one more thing")).toBeVisible();
  await expect.poll(async () => (await waitForConversation(owner, c.phone)).status).toBe("open");
  await expect(statusMenu(page)).toHaveText("Open");
});

test("outside the 24-hour window only templates can be sent", async () => {
  const c = await customerSays("Hello from yesterday");
  const conv = await waitForConversation(owner, c.phone);
  // Time travel: the customer's last message is 25 hours old.
  sql(`UPDATE messages SET created_at = now() - interval '25 hours' WHERE conversation_id = '${conv.id}'`);

  await page.goto("/inbox");
  await openConversation(page, c.name);
  await expect(page.getByText("24-hour session expired. Use a template to re-engage.")).toBeVisible();
  await expect(threadHeader(page)).toContainText("Expired");
  const box = page.getByPlaceholder("Session expired - use a template");
  await expect(box).toBeDisabled();
  // Attachments and interactive/quick-reply menus are locked too.
  const composerBar = page.locator("div.border-t.bg-card");
  await expect(composerBar.locator("button:has(svg.lucide-paperclip)")).toBeDisabled();
  await expect(composerBar.locator("button:has(svg.lucide-plus)")).toBeDisabled();

  await page.getByRole("button", { name: "Templates" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /appointment_confirm/ }).click();
  const [tpl] = await outboundTo(c.phone, (m) => m.type === "template");
  expect(tpl.body.template.name).toBe("appointment_confirm");
  expect((await fakes.outbound({ to: c.phone, phoneNumberId: wa.phoneNumberId })).filter((m) => m.type === "text")).toHaveLength(0);
});

test("the contact sidebar shows contact info and takes notes", async () => {
  const c = await customerSays("Please note my address");
  const conv = await waitForConversation(owner, c.phone);
  const patch = await api(owner, "PATCH", `/api/contacts/${conv.contact!.id}`, { email: "nora@example.com", company: "Acme Widgets" });
  expect(patch.status).toBe(200);

  await page.goto("/inbox");
  await openConversation(page, c.name);
  const sidebar = page.locator("div.border-l.bg-card").filter({ hasText: "Notes" });
  await expect(sidebar.getByRole("heading", { level: 3, name: c.name })).toBeVisible();
  await expect(sidebar).toContainText("Acme Widgets");
  await expect(sidebar).toContainText("nora@example.com");
  await expect(sidebar).toContainText(c.phone.replace(/\D/g, "").slice(-7));
  await expect(sidebar).toContainText("No tags");
  await expect(sidebar).toContainText("No deals");

  const note = sidebar.getByPlaceholder("Add a note...");
  const addNote = note.locator("xpath=following-sibling::button");
  await expect(addNote).toBeDisabled();
  await note.fill("Ships to the back door, ring twice.");
  await addNote.click();
  await expect(sidebar.getByText("Ships to the back door, ring twice.")).toBeVisible();
  await expect(note).toHaveValue("");

  const detail = await api(owner, "GET", `/api/contacts/${conv.contact!.id}`);
  expect(detail.body.notes.map((n: { note_text: string }) => n.note_text)).toContain("Ships to the back door, ring twice.");
});

test("conversations can be searched and filtered by status and unread", async () => {
  const tag = Date.now().toString(36);
  const open = await customerSays(`open-${tag} hello`, `Olive ${tag}`);
  const pending = await customerSays(`pending-${tag} hello`, `Penny ${tag}`);
  const closed = await customerSays(`closed-${tag} hello`, `Clyde ${tag}`);
  for (const [c, status] of [[pending, "pending"], [closed, "closed"]] as const) {
    const conv = await waitForConversation(owner, c.phone);
    expect((await api(owner, "PATCH", `/api/conversations/${conv.id}`, { status })).status).toBe(200);
  }
  // Open has been read; the others still carry an unread badge.
  const openConv = await waitForConversation(owner, open.phone);
  await api(owner, "POST", `/api/conversations/${openConv.id}/read`, {});

  await page.goto("/inbox");
  const search = page.getByPlaceholder("Search conversations...");
  const visibleNames = () => [open.name, pending.name, closed.name].map((n) => conversationItem(page, n));
  const [o, p, cl] = visibleNames();

  // Search by name, by phone digits, by last-message text.
  await search.fill(`Penny ${tag}`);
  await expect(p).toBeVisible();
  await expect(o).toHaveCount(0);
  await search.fill(open.phone.replace(/\D/g, "").slice(-7));
  await expect(o).toBeVisible();
  await expect(p).toHaveCount(0);
  await search.fill(`closed-${tag}`);
  await expect(cl).toBeVisible();
  await expect(o).toHaveCount(0);
  await search.fill(`no-such-${tag}`);
  await expect(page.getByText("No conversations found")).toBeVisible();

  // Narrow to this test's three, then filter by status.
  await search.fill(tag);
  await expect(o).toBeVisible();
  await expect(p).toBeVisible();
  await expect(cl).toBeVisible();

  const pick = async (label: string) => {
    await listFilter(page).click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    await expect(listFilter(page)).toHaveText(label);
  };
  await pick("Open");
  await expect(o).toBeVisible();
  await expect(p).toHaveCount(0);
  await expect(cl).toHaveCount(0);
  await pick("Pending");
  await expect(p).toBeVisible();
  await expect(o).toHaveCount(0);
  await pick("Closed");
  await expect(cl).toBeVisible();
  await expect(p).toHaveCount(0);
  await pick("Unread");
  await expect(p).toBeVisible();
  await expect(cl).toBeVisible();
  await expect(o).toHaveCount(0);
  await pick("All");
  await expect(o).toBeVisible();
  await expect(p).toBeVisible();
  await expect(cl).toBeVisible();
});

test("conversations can be filtered to mine / unassigned", async () => {
  test.fixme(true, "GAP: the inbox has no 'mine' or 'unassigned' filter (only All/Unread/Open/Pending/Closed, tags, company)");
  await page.goto("/inbox");
  await listFilter(page).click();
  await expect(page.getByRole("menuitem", { name: "Mine" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Unassigned" })).toBeVisible();
});

test("the thread header shows the contact's name on a 1280px laptop screen", async ({ browser }) => {
  const c = await customerSays("Small screen check");
  const { context: small, page: p } = await pageAs(browser, owner);
  await p.setViewportSize({ width: 1280, height: 720 });
  await p.goto("/inbox");
  await conversationItem(p, c.name).click();
  // The contact panel is open by default on desktop.
  await expect(threadHeader(p).getByRole("button", { name: /hide contact/i })).toBeVisible();
  const heading = p.getByRole("heading", { level: 2, name: c.name });
  await expect(heading).toBeVisible();
  // Not squeezed: the name gets real width (it is far from truncated to nothing).
  await expect.poll(async () => (await heading.boundingBox())?.width ?? 0).toBeGreaterThan(60);
  // The session badge sits on the second line, under the name.
  const badge = threadHeader(p).locator("svg.lucide-clock").locator("xpath=..");
  await expect(badge).toBeVisible();
  const [h, b] = [await heading.boundingBox(), await badge.boundingBox()];
  expect(b!.y).toBeGreaterThanOrEqual(h!.y + h!.height - 1);
  // The Assign trigger is icon-only below 2xl but keeps an accessible name.
  await expect(assignMenu(p)).toHaveAccessibleName("Assign");
  await expect(assignMenu(p)).toHaveAttribute("title", "Assign");
  await small.close();
});
