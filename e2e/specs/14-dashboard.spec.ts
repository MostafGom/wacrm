// Dashboard: on a fresh account, create known data (contacts, inbound +
// outbound messages, deals, a broadcast) through the API, the customer
// simulator and the inbox UI, then check the metric cards, the
// conversations chart (+ 7/30/90-day ranges), the pipeline donut, the
// response-time chart and the activity feed reflect exactly that. Also
// the empty state of a brand-new account.

import { expect, test, type Page } from "@playwright/test";

import { addMember, api, connectWhatsApp, newOwner, pageAs, sql, syncTemplates, type Connection, type TestUser } from "../support/accounts";
import { createContact, createDeal, createPipeline, createTag, getBroadcast, type SeedContact } from "../support/crm-seed";
import { fakes, randomCustomerPhone } from "../support/fakes";

test.describe.configure({ mode: "serial" });

/** Value shown on the metric card titled `title`. */
const metricValue = (page: Page, title: string) =>
  page.locator("p", { hasText: new RegExp(`^${title}$`) }).locator("xpath=../following-sibling::p[1]");
/** The secondary (delta / subtitle) row on the metric card titled `title`. */
const metricFooter = (page: Page, title: string) =>
  page.locator("p", { hasText: new RegExp(`^${title}$`) }).locator("xpath=../following-sibling::*[2]");
const section = (page: Page, heading: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });

// ------------------------------------------------------------

test("empty state on a brand-new account", async ({ browser }) => {
  const fresh = await newOwner("Nora New");
  const { page } = await pageAs(browser, fresh);
  await page.goto("/dashboard");
  await expect(page.getByRole("main").getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await expect(metricValue(page, "Active Conversations")).toHaveText("0");
  await expect(metricFooter(page, "Active Conversations")).toHaveText("No change new today vs yesterday");
  await expect(metricValue(page, "New Contacts Today")).toHaveText("0");
  await expect(metricFooter(page, "New Contacts Today")).toHaveText("No change vs yesterday");
  await expect(metricValue(page, "Open Deals Value")).toHaveText("$0");
  await expect(metricFooter(page, "Open Deals Value")).toHaveText("0 open deals");
  await expect(metricValue(page, "Messages Sent Today")).toHaveText("0");

  await expect(section(page, "Conversations Over Time")).toContainText("No message activity in this range");
  await expect(section(page, "Pipeline Value")).toContainText("No open deals yet");
  await expect(section(page, "Average First Response Time")).toContainText("No replies recorded yet");
  await expect(section(page, "Recent Activity")).toContainText("No activity yet");

  // Every range is empty, too.
  for (const r of ["7 days", "90 days"]) {
    await section(page, "Conversations Over Time").getByRole("button", { name: r }).click();
    await expect(section(page, "Conversations Over Time")).toContainText("No message activity in this range");
  }

  // Quick actions lead to the right places.
  await page.getByRole("link", { name: /New Broadcast/ }).click();
  await expect(page).toHaveURL(/\/broadcasts\/new/);
});

// ------------------------------------------------------------

let owner: TestUser;
let wa: Connection;
let dora: SeedContact;
let eli: SeedContact;
const fredPhone = randomCustomerPhone();

test.describe("with known data", () => {
  test.beforeAll(async () => {
    owner = await newOwner("Dash Owner");
    wa = await connectWhatsApp(owner);
    await syncTemplates(owner);

    // Contacts: two through the API, one created by an inbound message.
    const promo = await createTag(owner, "Promo");
    dora = await createContact(owner, { name: "Dora Dash", phone: randomCustomerPhone() }, { tagIds: [promo] });
    eli = await createContact(owner, { name: "Eli Dash", phone: randomCustomerPhone() }, { tagIds: [promo] });

    // Inbound: Dora 1, Fred 2 (a double-message), Eli 1 (backdated below).
    await fakes.inbound({ from: dora.phone, name: "Dora Dash", phone_number_id: wa.phoneNumberId, text: "Hi from Dora" });
    await fakes.inbound({ from: fredPhone, name: "Fred Fresh", phone_number_id: wa.phoneNumberId, text: "Hello?" });
    await fakes.inbound({ from: fredPhone, name: "Fred Fresh", phone_number_id: wa.phoneNumberId, text: "Anyone there?" });
    await fakes.inbound({ from: eli.phone, name: "Eli Dash", phone_number_id: wa.phoneNumberId, text: "Older question" });
    await expect
      .poll(async () => (await api(owner, "GET", "/api/conversations")).body.conversations.length, { timeout: 20_000 })
      .toBe(3);

    // Eli's message was really sent 10 days ago (time travel — the app
    // can't backdate a message).
    sql(
      `UPDATE messages m SET created_at = now() - interval '10 days' FROM conversations c
       WHERE c.id = m.conversation_id AND c.account_id = '${owner.accountId}' AND m.content_text = 'Older question'`,
    );

    // Outbound: reply to Dora through the API (Fred is answered in the UI test).
    const convs = (await api(owner, "GET", "/api/conversations")).body.conversations as { id: string; contact: { phone: string } }[];
    const doraConv = convs.find((c) => c.contact.phone === dora.phone)!;
    const sent = await api(owner, "POST", "/api/whatsapp/send", {
      conversation_id: doraConv.id,
      message_type: "text",
      content_text: "Hi Dora, how can we help?",
    });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);

    // Deals: two open (1 000 in Lead, 250 in Proposal) and one won (not counted).
    const pipeline = await createPipeline(owner, "Sales", [
      { name: "Lead", color: "#3b82f6" },
      { name: "Proposal", color: "#f59e0b" },
      { name: "Empty stage", color: "#10b981" },
    ]);
    await createDeal(owner, { title: "Big Lead", pipeline_id: pipeline.id, stage_id: pipeline.stageIds[0], value: 1000, contact_id: dora.id });
    await createDeal(owner, { title: "Small Proposal", pipeline_id: pipeline.id, stage_id: pipeline.stageIds[1], value: 250 });
    const won = await createDeal(owner, { title: "Closed Win", pipeline_id: pipeline.id, stage_id: pipeline.stageIds[1], value: 5000 });
    expect((await api(owner, "PATCH", `/api/deals/${won}`, { status: "won" })).status).toBe(200);

    // A broadcast to the Promo tag (Dora + Eli), delivered server-side.
    const b = await api(owner, "POST", "/api/broadcasts", {
      name: "Dash promo",
      template_name: "appointment_confirm",
      template_language: "en",
      template_variables: {},
      audience: { type: "tags", tagIds: [promo] },
    });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect((await api(owner, "POST", `/api/whatsapp/broadcast/${b.body.broadcast.id}/resume`, { scope: "pending" })).status).toBe(202);
    await expect.poll(async () => (await getBroadcast(owner, b.body.broadcast.id)).broadcast.status, { timeout: 20_000 }).toBe("sent");
  });

  test("metrics, charts, pipeline and activity reflect the account's data", async ({ browser }) => {
    const { page } = await pageAs(browser, owner);

    // Answer Fred from the inbox, as an agent would.
    await page.goto("/inbox");
    await page.getByText("Fred Fresh").first().click();
    const box = page.getByPlaceholder(/type a message/i);
    await box.fill("Hi Fred, we're here!");
    await box.press("Enter");
    await fakes.waitForOutbound({ to: fredPhone, phoneNumberId: wa.phoneNumberId }, (m) => m.type === "text");

    await page.goto("/dashboard");
    // Metric cards.
    await expect(metricValue(page, "Active Conversations")).toHaveText("3");
    await expect(metricFooter(page, "Active Conversations")).toHaveText("+3 new today vs yesterday");
    await expect(metricValue(page, "New Contacts Today")).toHaveText("3");
    await expect(metricFooter(page, "New Contacts Today")).toHaveText("+3 vs yesterday");
    await expect(metricValue(page, "Open Deals Value")).toHaveText("$1,250");
    await expect(metricFooter(page, "Open Deals Value")).toHaveText("2 open deals");
    await expect(metricValue(page, "Messages Sent Today")).toHaveText("2");
    await expect(metricFooter(page, "Messages Sent Today")).toHaveText("+2 vs yesterday");

    // Pipeline donut: open deals only, empty stages left out.
    const donut = section(page, "Pipeline Value");
    await expect(donut.getByRole("img", { name: "Pipeline value by stage" })).toContainText("$1.3k");
    const legend = donut.getByRole("listitem");
    await expect(legend).toHaveCount(2);
    await expect(legend.nth(0)).toHaveText(/Lead\s*1 deal\s*\$1\.0k/);
    await expect(legend.nth(1)).toHaveText(/Proposal\s*1 deal\s*\$250/);
    await expect(donut).not.toContainText("Empty stage");

    // Response time: two answered threads this week.
    const rt = section(page, "Average First Response Time");
    await expect(rt).not.toContainText("No replies recorded yet");
    await expect(rt).toContainText(/This week:\s*\d+(\.\d)?[smh]/);

    // Activity feed: newest first, one line per source.
    const feed = section(page, "Recent Activity");
    await feed.getByRole("button", { name: "20", exact: true }).click();
    for (const text of [
      'Broadcast "Dash promo" sent to 2 contacts',
      'Deal "Big Lead" in Lead',
      'Deal "Small Proposal" in Proposal',
      'Deal "Closed Win" in Proposal',
      "New message from Fred Fresh",
      "New message from Dora Dash",
      "New contact: Dora Dash",
      "New contact: Eli Dash",
    ]) {
      await expect(feed.getByText(text).first()).toBeVisible();
    }
    // Page sizes: 5 by default; 50 is disabled when fewer rows exist.
    const items = await api(owner, "GET", "/api/dashboard/activity?limit=50");
    const total = items.body.items.length as number;
    await feed.getByRole("button", { name: "5", exact: true }).click();
    await expect(feed.getByRole("listitem")).toHaveCount(5);
    await expect(feed).toContainText(`Showing 5 of ${total}`);
    await expect(feed.getByRole("button", { name: "50", exact: true })).toBeDisabled();
    // Items link to their pages.
    await feed.getByRole("link", { name: /Dash promo/ }).click();
    await expect(page).toHaveURL(/\/broadcasts$/);
  });

  test("conversations chart: per-day counts and the 7/30/90-day ranges", async ({ browser }) => {
    const { page } = await pageAs(browser, owner);
    const seriesRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/dashboard/conversations-chart")) seriesRequests.push(new URL(r.url()).searchParams.get("days")!);
    });
    await page.goto("/dashboard");
    const chart = section(page, "Conversations Over Time");
    const svg = chart.getByRole("img", { name: "Conversations per day" });
    await expect(svg).toBeVisible();

    /** Hover the day `daysAgo` before today in a `range`-day chart; returns the tooltip text. */
    const hoverDay = async (range: number, daysAgo: number) => {
      const box = (await svg.boundingBox())!;
      // viewBox 760×240, plot area x ∈ [40, 744]; the SVG keeps its aspect ratio (centered).
      const scale = Math.min(box.width / 760, box.height / 240);
      const offsetX = (box.width - 760 * scale) / 2;
      const idx = range - 1 - daysAgo;
      const x = box.x + offsetX + (40 + (idx * 704) / (range - 1)) * scale;
      await page.mouse.move(x, box.y + box.height / 2);
      const tip = chart.locator("div.absolute").filter({ hasText: "incoming" });
      await expect(tip).toBeVisible();
      return (await tip.textContent()) ?? "";
    };

    // 30 days (default): today has 3 incoming (Dora 1, Fred 2) and 2 outgoing; 10 days ago, Eli's 1.
    expect(await hoverDay(30, 0)).toMatch(/3 incoming\s*2 outgoing/);
    expect(await hoverDay(30, 10)).toMatch(/1 incoming\s*0 outgoing/);
    expect(await hoverDay(30, 5)).toMatch(/0 incoming\s*0 outgoing/);

    // 7 days: Eli's message is out of range.
    await chart.getByRole("button", { name: "7 days" }).click();
    await expect.poll(() => seriesRequests).toContain("7");
    expect(await hoverDay(7, 0)).toMatch(/3 incoming\s*2 outgoing/);
    expect(await hoverDay(7, 6)).toMatch(/0 incoming\s*0 outgoing/);

    // 90 days: fetched once, includes both.
    await chart.getByRole("button", { name: "90 days" }).click();
    await expect.poll(() => seriesRequests).toContain("90");
    expect(await hoverDay(90, 10)).toMatch(/1 incoming/);
    expect(await hoverDay(90, 0)).toMatch(/3 incoming\s*2 outgoing/);

    // Back to 30: served from cache, no new request.
    await chart.getByRole("button", { name: "30 days" }).click();
    expect(await hoverDay(30, 10)).toMatch(/1 incoming/);
    expect(seriesRequests.filter((d) => d === "30")).toHaveLength(1);

    // The API agrees (same zone as the browser).
    const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    const sum = async (days: number) => {
      const r = await api(owner, "GET", `/api/dashboard/conversations-chart?days=${days}&tz=${encodeURIComponent(tz)}`);
      expect(r.body.series).toHaveLength(days);
      return r.body.series.reduce(
        (a: { i: number; o: number }, p: { incoming: number; outgoing: number }) => ({ i: a.i + p.incoming, o: a.o + p.outgoing }),
        { i: 0, o: 0 },
      );
    };
    expect(await sum(7)).toEqual({ i: 3, o: 2 });
    expect(await sum(30)).toEqual({ i: 4, o: 2 });
    expect(await sum(90)).toEqual({ i: 4, o: 2 });
    expect((await api(owner, "GET", "/api/dashboard/conversations-chart?days=0")).status).toBe(400);
  });

  test("dashboard data is account-scoped and readable by viewers", async () => {
    const stranger = await newOwner("Stranger Dash");
    const theirs = await api(stranger, "GET", "/api/dashboard/metrics");
    expect(theirs.body.metrics.newContactsToday.current).toBe(0);
    expect((await api(stranger, "GET", "/api/dashboard/activity?limit=50")).body.items).toEqual([]);
    expect((await api(null, "GET", "/api/dashboard/metrics")).status).toBe(401);
    const viewer = await addMember(owner, "viewer");
    const viewed = await api(viewer, "GET", "/api/dashboard/pipeline");
    expect(viewed.status).toBe(200);
    expect(viewed.body.pipeline.totalValue).toBe(1250);
    const mine = await api(viewer, "GET", "/api/dashboard/metrics");
    expect(mine.body.metrics).toMatchObject({
      newContactsToday: { current: 3 },
      openDealsValue: 1250,
      openDealsCount: 2,
      messagesSentToday: { current: 2 },
    });
  });
});
