// Inbox-specific helpers shared by 05-inbox and 11-realtime.
//
// The inbox renders most of its chrome as icon-only buttons and plain
// <div>s, so a few locators below lean on structure (class names / lucide
// icon classes). They are centralised here so a markup change only needs
// fixing in one place.

import { expect, type Locator, type Page } from "@playwright/test";

import { api, type TestUser } from "./accounts";

/** The conversation row in the left-hand list for a contact. */
export function conversationItem(page: Page, name: string): Locator {
  // Rows are <button>s whose text is "<initial><name><time><preview><badge>".
  return page.locator("button.text-left").filter({ hasText: name });
}

/** The open thread's scrollable message area. */
export function threadArea(page: Page): Locator {
  return page.locator("div.overflow-y-auto.px-4.py-4");
}

/** One message row (bubble + hover toolbar) containing `text`. */
export function messageRow(page: Page, text: string | RegExp): Locator {
  return threadArea(page).locator("div.group\\/actions").filter({ hasText: text });
}

/** Thread header (name, status + assign menus). */
export function threadHeader(page: Page): Locator {
  return page.locator("div.border-b.bg-card").filter({ has: page.getByRole("heading", { level: 2 }) });
}

/** Status-menu trigger in the thread header ("Open" / "Pending" / "Closed"). */
export function statusMenu(page: Page): Locator {
  return threadHeader(page).getByRole("button", { name: /^(Open|Pending|Closed)$/ });
}

/** Assign-menu trigger in the thread header. */
export function assignMenu(page: Page): Locator {
  return threadHeader(page).locator("button:has(svg.lucide-user-plus)");
}

/** Conversation-list filter trigger ("All", "Unread", "Open"…). */
export function listFilter(page: Page): Locator {
  return page.getByPlaceholder("Search conversations...").locator("xpath=ancestor::div[contains(@class,'border-b')][1]").locator("button").first();
}

/** The composer's free-text box. */
export function composer(page: Page): Locator {
  return page.locator("textarea").first();
}

/** Send button of the composer / staged-media preview (icon-only). */
export function sendButton(page: Page): Locator {
  return page.locator("div.border-t.bg-card button:has(svg.lucide-send)");
}

/** Open the inbox and select the conversation with `name`. */
export async function openConversation(page: Page, name: string): Promise<void> {
  if (!page.url().includes("/inbox")) await page.goto("/inbox");
  await conversationItem(page, name).first().click();
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
}

/** Type a message in the composer and press Enter. */
export async function sendText(page: Page, text: string): Promise<void> {
  const box = page.getByPlaceholder(/type a message/i);
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

export interface ConversationRow {
  id: string;
  status: "open" | "pending" | "closed";
  assigned_agent_id?: string | null;
  unread_count: number;
  last_message_text?: string | null;
  contact?: { id: string; name?: string | null; phone?: string | null };
}

/** Find the conversation for a customer phone (digits compared). */
export async function findConversation(user: TestUser, phone: string): Promise<ConversationRow | undefined> {
  const r = await api<{ conversations: ConversationRow[] }>(user, "GET", "/api/conversations");
  const digits = phone.replace(/\D/g, "");
  return r.body.conversations.find((c) => (c.contact?.phone ?? "").replace(/\D/g, "") === digits);
}

/** Wait for the conversation for `phone` to exist and return it. */
export async function waitForConversation(user: TestUser, phone: string): Promise<ConversationRow> {
  let row: ConversationRow | undefined;
  await expect
    .poll(async () => {
      row = await findConversation(user, phone);
      return !!row;
    }, { message: `conversation for ${phone}` })
    .toBe(true);
  return row!;
}

export interface MessageRow {
  id: string;
  sender_type: string;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  status: string;
  message_id: string | null;
  error_title?: string | null;
  error_details?: string | null;
  reply_to_message_id?: string | null;
  created_at: string;
}

export async function listMessages(user: TestUser, conversationId: string): Promise<MessageRow[]> {
  const r = await api<{ messages: MessageRow[] }>(user, "GET", `/api/conversations/${conversationId}/messages`);
  expect(r.status).toBe(200);
  return r.body.messages;
}

/** Wait until a message matching `pred` is stored, and return it. */
export async function waitForMessage(
  user: TestUser,
  conversationId: string,
  pred: (m: MessageRow) => boolean,
  what = "message",
): Promise<MessageRow> {
  let found: MessageRow | undefined;
  await expect
    .poll(async () => {
      found = (await listMessages(user, conversationId)).find(pred);
      return !!found;
    }, { message: `waiting for ${what}` })
    .toBe(true);
  return found!;
}
