// Dashboard aggregates against real Postgres: the SQL must reproduce
// what the browser used to compute (local-day boundaries, run-based
// first-response pairing, open-deal sums) and stay account-scoped.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser } from "@/server/db";
import {
  buildActivityItems,
  loadActivitySources,
  loadConversationsSeries,
  loadMetrics,
  loadPipelineDonut,
  loadResponseTime,
  resolveTimeZone,
} from "@/server/repos/dashboard";
import { seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let owner: SeededUser;
let outsider: SeededUser;
const messageTimes: { at: string; sender: string }[] = [];

const MIN = 60_000;
const todayStart = new Date();
todayStart.setUTCHours(0, 0, 0, 0);
const at = (offsetMs: number) => new Date(todayStart.getTime() + offsetMs).toISOString();

function dayKey(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

async function seedAccount(user: SeededUser, opts: { record: boolean }) {
  await asService(async (db) => {
    const a = user.accountId;
    const uid = user.id;
    const [c1, c2, c3] = await db
      .insertInto("contacts")
      .values([
        { account_id: a, user_id: uid, phone: `+1555${uid.slice(0, 4)}1`, name: "Today Contact", created_at: at(1000) },
        { account_id: a, user_id: uid, phone: `+1555${uid.slice(0, 4)}2`, name: "Old Contact", created_at: at(-60 * MIN) },
        { account_id: a, user_id: uid, phone: `+1555${uid.slice(0, 4)}3`, name: "Older", created_at: at(-72 * 60 * MIN) },
      ])
      .returning("id")
      .execute();
    const [conv1, conv2] = await db
      .insertInto("conversations")
      .values([
        { account_id: a, user_id: uid, contact_id: c1.id, status: "open", created_at: at(1000) },
        { account_id: a, user_id: uid, contact_id: c2.id, status: "open", created_at: at(-60 * MIN) },
        { account_id: a, user_id: uid, contact_id: c3.id, status: "closed", created_at: at(2000) },
      ])
      .returning("id")
      .execute();
    const msgs = [
      { conversation_id: conv1.id, sender_type: "customer", created_at: at(1 * MIN) },
      { conversation_id: conv1.id, sender_type: "customer", created_at: at(2 * MIN) },
      { conversation_id: conv1.id, sender_type: "agent", created_at: at(6 * MIN) },
      { conversation_id: conv1.id, sender_type: "customer", created_at: at(11 * MIN) },
      { conversation_id: conv1.id, sender_type: "bot", created_at: at(31 * MIN) },
      { conversation_id: conv2.id, sender_type: "agent", created_at: at(-120 * MIN) },
    ];
    await db
      .insertInto("messages")
      .values(msgs.map((m, i) => ({ ...m, content_text: `m${i}` })))
      .execute();
    if (opts.record) messageTimes.push(...msgs.map((m) => ({ at: m.created_at, sender: m.sender_type })));

    const p = await db.insertInto("pipelines").values({ account_id: a, user_id: uid, name: "P" }).returning("id").executeTakeFirstOrThrow();
    const [s1] = await db
      .insertInto("pipeline_stages")
      .values([
        { pipeline_id: p.id, name: "Lead", color: "", position: 0 },
        { pipeline_id: p.id, name: "Empty", color: "#ffffff", position: 1 },
      ])
      .returning("id")
      .execute();
    await db
      .insertInto("deals")
      .values([
        { account_id: a, user_id: uid, pipeline_id: p.id, stage_id: s1.id, title: "D1", value: 100, status: "open" },
        { account_id: a, user_id: uid, pipeline_id: p.id, stage_id: s1.id, title: "D2", value: 50, status: "open" },
        { account_id: a, user_id: uid, pipeline_id: p.id, stage_id: s1.id, title: "D3", value: 999, status: "won" },
      ])
      .execute();
    await db
      .insertInto("broadcasts")
      .values({ account_id: a, user_id: uid, name: "Promo", template_name: "t", status: "sent", total_recipients: 3 })
      .execute();
  });
}

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  outsider = await seedUser("Outsider");
  await seedAccount(owner, { record: true });
  await seedAccount(outsider, { record: false });
});

afterAll(teardownIntegrationDb);

describe("dashboard repo", () => {
  it("resolves only time zones Postgres knows", async () => {
    await asUser(owner.id, async (db) => {
      expect(await resolveTimeZone(db, "America/Sao_Paulo")).toBe("America/Sao_Paulo");
      expect(await resolveTimeZone(db, "Not/AZone")).toBe("UTC");
      expect(await resolveTimeZone(db, "")).toBe("UTC");
      expect(await resolveTimeZone(db, null)).toBe("UTC");
    });
  });

  it("computes the metric cards for the caller's account only", async () => {
    const m = await asUser(owner.id, (db) => loadMetrics(db, owner.accountId, "UTC"));
    expect(m).toEqual({
      activeConversations: { current: 2, previous: 0 }, // 1 new today - 1 new yesterday
      newContactsToday: { current: 1, previous: 1 },
      openDealsValue: 150,
      openDealsCount: 2,
      messagesSentToday: { current: 1, previous: 1 }, // agent only; bot excluded
    });
  });

  it("buckets messages per local day, zero-filled, in the viewer's zone", async () => {
    for (const tz of ["UTC", "Pacific/Kiritimati", "America/Los_Angeles"]) {
      const series = await asUser(owner.id, (db) => loadConversationsSeries(db, owner.accountId, tz, 7));
      expect(series).toHaveLength(7);
      expect(series[6].day).toBe(dayKey(new Date().toISOString(), tz));

      const expected = new Map<string, { incoming: number; outgoing: number }>();
      for (const m of messageTimes) {
        const k = dayKey(m.at, tz);
        const b = expected.get(k) ?? { incoming: 0, outgoing: 0 };
        if (m.sender === "customer") b.incoming += 1;
        else b.outgoing += 1;
        expected.set(k, b);
      }
      for (const point of series) {
        expect([tz, point]).toEqual([tz, { day: point.day, ...(expected.get(point.day) ?? { incoming: 0, outgoing: 0 }) }]);
      }
    }
  });

  it("sums open deals per stage, hides empty stages, falls back on colour", async () => {
    const d = await asUser(owner.id, (db) => loadPipelineDonut(db, owner.accountId));
    expect(d.totalValue).toBe(150);
    expect(d.stages).toHaveLength(1);
    expect(d.stages[0]).toMatchObject({ name: "Lead", color: "#64748b", dealCount: 2, totalValue: 150 });
  });

  it("pairs the first unreplied customer message with the next outbound one", async () => {
    const r = await asUser(owner.id, (db) => loadResponseTime(db, owner.accountId, "UTC"));
    const dow = (todayStart.getUTCDay() + 6) % 7;
    // Samples: 1m → 6m (5 min; the 2m double-message doesn't count) and 11m → 31m (20 min).
    expect(r.buckets[dow]).toEqual({ dow, avgMinutes: 12.5, samples: 2 });
    expect(r.buckets.filter((b) => b.dow !== dow).every((b) => b.avgMinutes === null && b.samples === 0)).toBe(true);
    expect(r.thisWeekAvg).toBe(12.5);
    expect(r.lastWeekAvg).toBeNull();
  });

  it("merges the activity feed newest first, scoped to the account", async () => {
    const src = await asUser(owner.id, (db) => loadActivitySources(db, owner.accountId));
    expect(src.messages).toHaveLength(3);
    expect(src.messages[0].contact?.name).toBe("Today Contact");
    expect(src.deals.every((d) => d.stage_name === "Lead")).toBe(true);

    const items = buildActivityItems(src, 50);
    expect(items.map((i) => i.kind).sort()).toEqual(
      ["broadcast", "contact", "contact", "contact", "deal", "deal", "deal", "message", "message", "message"].sort(),
    );
    const times = items.map((i) => i.at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(items.find((i) => i.kind === "message")?.href).toMatch(/^\/inbox\?c=/);
    expect(buildActivityItems(src, 2)).toHaveLength(2);
  });
});
