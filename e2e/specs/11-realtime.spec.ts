// Realtime across users: two signed-in browser contexts (owner + agent)
// side by side. Presence dots, assignment notifications + the sidebar
// bell count, and live inbox updates — all without reloads.

import { expect, test, type Browser, type Page } from "@playwright/test";

import { addMember, api, connectWhatsApp, newOwner, pageAs, sql, type Connection, type TestUser } from "../support/accounts";
import { fakes, randomCustomerPhone } from "../support/fakes";
import {
  assignMenu,
  conversationItem,
  openConversation,
  sendText,
  statusMenu,
  threadArea,
  waitForConversation,
} from "../support/inbox";

let owner: TestUser;
let agent: TestUser;
let wa: Connection;

test.beforeAll(async () => {
  owner = await newOwner("Rita Owner");
  agent = await addMember(owner, "agent", "Sam Agent");
  wa = await connectWhatsApp(owner);
});

async function open(browser: Browser, user: TestUser): Promise<Page> {
  const { page } = await pageAs(browser, user);
  await page.setViewportSize({ width: 1600, height: 1000 });
  return page;
}

async function customer(text: string) {
  const phone = randomCustomerPhone();
  const name = `Cust ${Math.random().toString(36).slice(2, 7)}`;
  const { id } = await fakes.inbound({ from: phone, name, phone_number_id: wa.phoneNumberId, text });
  return { phone, name, wamid: id };
}

/** The presence badge on a member's avatar in Settings → Team members. */
const memberPresence = (page: Page, email: string) =>
  page.getByRole("listitem").filter({ hasText: email }).getByRole("img", { name: /^(Online|Away|Offline) — / });

test("presence: online, away when the tab is hidden, offline once it stops beating", async ({ browser }) => {
  const ownerPage = await open(browser, owner);
  const agentContextPage = await open(browser, agent);

  // The agent is active in the inbox → heartbeats "online".
  await agentContextPage.goto("/inbox");
  await ownerPage.goto("/settings?tab=members");
  const dot = memberPresence(ownerPage, agent.email);
  await expect(dot).toHaveAccessibleName("Online — active now");
  // The owner sees themself online too.
  await expect(memberPresence(ownerPage, owner.email)).toHaveAccessibleName("Online — active now");

  // The inbox Assign menu shows the same dot next to each teammate.
  const c = await customer("presence check");
  await openConversation(ownerPage, c.name);
  await assignMenu(ownerPage).click();
  await expect(
    ownerPage.getByRole("menuitem", { name: /Sam Agent/ }).getByRole("img", { name: "Online — active now" }),
  ).toBeVisible();
  await ownerPage.keyboard.press("Escape");

  // The agent's tab goes to the background → the next beat reports "away",
  // which reaches the owner live.
  await ownerPage.goto("/settings?tab=members");
  await expect(async () => {
    await agentContextPage.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(dot).toHaveAccessibleName("Away — idle", { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(ownerPage.getByText(/1 away/)).toBeVisible();

  // The agent closes the tab: beats stop. Offline is derived from a stale
  // heartbeat (> 75 s); rather than wait, age the last beat.
  await agentContextPage.context().close();
  sql(`UPDATE member_presence SET last_seen_at = now() - interval '10 minutes' WHERE user_id = '${agent.userId}'`);
  await expect(dot).toHaveAccessibleName(/^Offline — last seen 10 minutes ago$/);
  await expect(ownerPage.getByText(/1 offline/)).toBeVisible();

  // Back online as soon as the agent opens the app again.
  const again = await open(browser, agent);
  await again.goto("/dashboard");
  await expect(dot).toHaveAccessibleName("Online — active now");
  await again.context().close();
  await ownerPage.context().close();
});

test("assignment notifies the agent live; read one, then mark all read", async ({ browser }) => {
  const ownerPage = await open(browser, owner);
  const agentPage = await open(browser, agent);
  const bell = agentPage.getByRole("link", { name: /Notifications/ });

  await agentPage.goto("/notifications");
  await expect(agentPage.getByText("No notifications yet")).toBeVisible();
  await expect(agentPage.getByLabel(/unread notifications?/)).toHaveCount(0);

  const first = await customer("Please help with billing");
  const second = await customer("Shipping question");

  // Owner assigns the first conversation to the agent through the inbox.
  await openConversation(ownerPage, first.name);
  await assignMenu(ownerPage).click();
  await ownerPage.getByRole("menuitem", { name: /Sam Agent/ }).click();
  await expect(assignMenu(ownerPage)).toContainText("Sam Agent");

  // The agent's bell count and list update without a reload.
  await expect(bell.getByLabel("1 unread notification")).toBeVisible();
  const items = agentPage.getByRole("main").getByRole("listitem");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("New conversation assigned");
  await expect(items.first()).toContainText(`Rita Owner assigned you a conversation with ${first.name}`);
  await expect(items.first().getByLabel("Unread")).toBeVisible();

  await openConversation(ownerPage, second.name);
  await assignMenu(ownerPage).click();
  await ownerPage.getByRole("menuitem", { name: /Sam Agent/ }).click();
  await expect(bell.getByLabel("2 unread notifications")).toBeVisible();
  await expect(items).toHaveCount(2);

  // Clicking one marks it read and deep-links into the conversation.
  await items.filter({ hasText: first.name }).getByRole("button").click();
  await expect(agentPage).toHaveURL(/\/inbox\?c=/);
  await expect(agentPage.getByRole("heading", { level: 2, name: first.name })).toBeVisible();
  await expect(bell.getByLabel("1 unread notification")).toBeVisible();

  // Mark all read.
  await agentPage.goto("/notifications");
  await expect(items.filter({ hasText: first.name }).getByLabel("Unread")).toHaveCount(0);
  await expect(items.filter({ hasText: second.name }).getByLabel("Unread")).toBeVisible();
  await agentPage.getByRole("button", { name: "Mark all as read" }).click();
  await expect(agentPage.getByRole("main").getByLabel("Unread")).toHaveCount(0);
  await expect(agentPage.getByLabel(/unread notifications?/)).toHaveCount(0);
  await expect(agentPage.getByRole("button", { name: "Mark all as read" })).toBeDisabled();
  await expect.poll(async () => (await api(agent, "GET", "/api/notifications/unread-count")).body.count).toBe(0);

  // The owner, who did the assigning, got nothing.
  expect((await api(owner, "GET", "/api/notifications/unread-count")).body.count).toBe(0);
  await ownerPage.context().close();
  await agentPage.context().close();
});

test("self-assignment does not notify", async () => {
  const c = await customer("I'll take this myself");
  const conv = await waitForConversation(agent, c.phone);
  const before = (await api(agent, "GET", "/api/notifications/unread-count")).body.count;
  expect((await api(agent, "PATCH", `/api/conversations/${conv.id}`, { assigned_agent_id: agent.userId })).status).toBe(200);
  // The notification trigger runs in the same transaction as the update,
  // so the count is final as soon as the PATCH returns.
  expect((await waitForConversation(agent, c.phone)).assigned_agent_id).toBe(agent.userId);
  expect((await api(agent, "GET", "/api/notifications/unread-count")).body.count).toBe(before);
});

test("owner's replies, status changes and new inbound messages reach the agent live", async ({ browser }) => {
  const ownerPage = await open(browser, owner);
  const agentPage = await open(browser, agent);
  const c = await customer("Is anyone there?");

  await openConversation(ownerPage, c.name);
  await openConversation(agentPage, c.name);

  // Owner replies → appears in the agent's open thread and list preview.
  await sendText(ownerPage, "Hi! Rita here, looking into it.");
  await expect(threadArea(agentPage).getByText("Hi! Rita here, looking into it.")).toBeVisible();
  await expect(conversationItem(agentPage, c.name)).toContainText("Hi! Rita here, looking into it.");

  // Owner changes the status → the agent's header follows.
  await statusMenu(ownerPage).click();
  await ownerPage.getByRole("menuitem", { name: "Pending" }).click();
  await expect(statusMenu(agentPage)).toHaveText("Pending");

  // Owner assigns → agent's header shows the assignee.
  await assignMenu(ownerPage).click();
  await ownerPage.getByRole("menuitem", { name: /Sam Agent/ }).click();
  await expect(assignMenu(agentPage)).toContainText("Sam Agent");

  // A new customer message lands in both inboxes at once.
  await fakes.inbound({ from: c.phone, phone_number_id: wa.phoneNumberId, text: "Thanks, waiting on you" });
  await expect(threadArea(ownerPage).getByText("Thanks, waiting on you")).toBeVisible();
  await expect(threadArea(agentPage).getByText("Thanks, waiting on you")).toBeVisible();

  // A brand-new conversation appears in both lists.
  const other = await customer("New customer here");
  await expect(conversationItem(ownerPage, other.name)).toContainText("New customer here");
  await expect(conversationItem(agentPage, other.name)).toContainText("New customer here");

  // The agent replying shows up for the owner as well.
  await sendText(agentPage, "Sam here, I've got it from here.");
  await expect(threadArea(ownerPage).getByText("Sam here, I've got it from here.")).toBeVisible();

  await ownerPage.context().close();
  await agentPage.context().close();
});
