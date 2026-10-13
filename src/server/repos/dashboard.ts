// Dashboard aggregates, computed in SQL.
//
// The numbers match what the dashboard used to compute in the browser:
// every "today" / "yesterday" / "this week" / day-bucket boundary is a
// LOCAL calendar boundary in the viewer's time zone (the browser sends
// its IANA zone; see resolveTimeZone). `date_trunc('day', now() AT TIME
// ZONE tz) AT TIME ZONE tz` is the instant of local midnight, the SQL
// twin of lib/dashboard/date-utils' startOfLocalDay().
//
// messages and pipeline_stages carry no account_id; they are scoped
// through their conversation / pipeline.

import { sql, type Db } from "@/server/db";
import { getT } from "@/lib/i18n/translate";
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  ResponseTimeBucket,
  ResponseTimeSummary,
} from "@/lib/dashboard/types";

// ------------------------------------------------------------
// Time zone
// ------------------------------------------------------------

const knownZones = new Set<string>(["UTC"]);

/**
 * The zone to bucket by: `tz` when Postgres knows it, else UTC. Checked
 * once per zone per process (pg_timezone_names is not free to scan),
 * so an unknown name never reaches an `AT TIME ZONE` and aborts the
 * transaction.
 */
export async function resolveTimeZone(db: Db, tz: string | null | undefined): Promise<string> {
  if (!tz || tz.length > 64) return "UTC";
  if (knownZones.has(tz)) return tz;
  const r = await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${tz}) AS ok`.execute(
    db,
  );
  if (!r.rows[0]?.ok) return "UTC";
  knownZones.add(tz);
  return tz;
}

/** Local midnight `days` days ago, as a timestamptz expression. */
function localDayStart(tz: string, days: number) {
  return sql`((date_trunc('day', now() AT TIME ZONE ${tz}) - make_interval(days => ${days}::int)) AT TIME ZONE ${tz})`;
}

// --- 1. Metric cards ---------------------------------------------------

export async function loadMetrics(db: Db, accountId: string, tz: string): Promise<MetricsBundle> {
  const today = localDayStart(tz, 0);
  const yesterday = localDayStart(tz, 1);
  const r = await sql<{
    open_conv: number;
    new_conv_today: number;
    new_conv_yesterday: number;
    contacts_today: number;
    contacts_yesterday: number;
    open_deals_count: number;
    open_deals_value: number;
    sent_today: number;
    sent_yesterday: number;
  }>`
    WITH b AS (SELECT ${today} AS today, ${yesterday} AS yesterday)
    SELECT
      (SELECT count(*)::int FROM conversations
        WHERE account_id = ${accountId} AND status = 'open') AS open_conv,
      (SELECT count(*)::int FROM conversations
        WHERE account_id = ${accountId} AND status = 'open' AND created_at >= b.today) AS new_conv_today,
      (SELECT count(*)::int FROM conversations
        WHERE account_id = ${accountId} AND status = 'open'
          AND created_at >= b.yesterday AND created_at < b.today) AS new_conv_yesterday,
      (SELECT count(*)::int FROM contacts
        WHERE account_id = ${accountId} AND created_at >= b.today) AS contacts_today,
      (SELECT count(*)::int FROM contacts
        WHERE account_id = ${accountId} AND created_at >= b.yesterday AND created_at < b.today) AS contacts_yesterday,
      (SELECT count(*)::int FROM deals
        WHERE account_id = ${accountId} AND status = 'open') AS open_deals_count,
      (SELECT coalesce(sum(value), 0) FROM deals
        WHERE account_id = ${accountId} AND status = 'open') AS open_deals_value,
      (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.account_id = ${accountId} AND m.sender_type = 'agent' AND m.created_at >= b.today) AS sent_today,
      (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.account_id = ${accountId} AND m.sender_type = 'agent'
          AND m.created_at >= b.yesterday AND m.created_at < b.today) AS sent_yesterday
    FROM b
  `.execute(db);
  const m = r.rows[0];

  return {
    activeConversations: {
      current: m.open_conv,
      // "vs yesterday" on a current-state count has no clean answer
      // without snapshots — we show the delta in NEW open conversations
      // today vs yesterday. That's the business-meaningful daily signal.
      previous: m.new_conv_today - m.new_conv_yesterday,
    },
    newContactsToday: { current: m.contacts_today, previous: m.contacts_yesterday },
    openDealsValue: m.open_deals_value,
    openDealsCount: m.open_deals_count,
    messagesSentToday: { current: m.sent_today, previous: m.sent_yesterday },
  };
}

// --- 2. Conversations over time ---------------------------------------

/**
 * Messages per local day for the last `rangeDays` days (today
 * included), oldest first, zero-filled. Customer messages are
 * incoming; agent + bot both count as outgoing.
 */
export async function loadConversationsSeries(
  db: Db,
  accountId: string,
  tz: string,
  rangeDays: number,
): Promise<ConversationsSeriesPoint[]> {
  const back = rangeDays - 1;
  const r = await sql<ConversationsSeriesPoint>`
    WITH days AS (
      SELECT d::date AS day
      FROM generate_series(
        date_trunc('day', now() AT TIME ZONE ${tz}) - make_interval(days => ${back}::int),
        date_trunc('day', now() AT TIME ZONE ${tz}),
        interval '1 day'
      ) AS d
    ),
    counts AS (
      SELECT (m.created_at AT TIME ZONE ${tz})::date AS day,
             count(*) FILTER (WHERE m.sender_type = 'customer')::int AS incoming,
             count(*) FILTER (WHERE m.sender_type <> 'customer')::int AS outgoing
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = ${accountId}
        AND m.created_at >= ${localDayStart(tz, back)}
      GROUP BY 1
    )
    SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
           coalesce(counts.incoming, 0) AS incoming,
           coalesce(counts.outgoing, 0) AS outgoing
    FROM days LEFT JOIN counts USING (day)
    ORDER BY days.day
  `.execute(db);
  return r.rows;
}

// --- 3. Pipeline donut -------------------------------------------------

/**
 * Open deals per stage across all the account's pipelines, in stage
 * position order. Empty stages are left out of the ring (trimming
 * keeps the visual clean for the common case).
 */
export async function loadPipelineDonut(db: Db, accountId: string): Promise<PipelineDonutData> {
  const r = await sql<{ id: string; name: string; color: string; dealCount: number; totalValue: number }>`
    SELECT s.id, s.name,
           coalesce(nullif(s.color, ''), '#64748b') AS color,
           count(d.id)::int AS "dealCount",
           coalesce(sum(d.value), 0) AS "totalValue"
    FROM pipeline_stages s
    JOIN pipelines p ON p.id = s.pipeline_id AND p.account_id = ${accountId}
    LEFT JOIN deals d ON d.stage_id = s.id AND d.status = 'open' AND d.account_id = ${accountId}
    GROUP BY s.id
    HAVING count(d.id) > 0 OR coalesce(sum(d.value), 0) > 0
    ORDER BY s.position, s.id
  `.execute(db);
  const stages = r.rows;
  return { stages, totalValue: stages.reduce((sum, s) => sum + s.totalValue, 0) };
}

// --- 4. Response time by day of week ----------------------------------

/**
 * First-response time over the last 14 local days. Within each
 * conversation, the first customer message after an outbound one (or
 * the conversation's first in the window) opens a sample; the next
 * agent/bot message closes it. A customer double-messaging counts
 * once. Per-weekday buckets (Monday = 0) average both weeks; the
 * this-week / last-week averages split on local Monday midnight.
 */
export async function loadResponseTime(db: Db, accountId: string, tz: string): Promise<ResponseTimeSummary> {
  const r = await sql<{ dow: number | null; avg: number | null; n: number; this_week: number | null; last_week: number | null }>`
    WITH b AS (
      SELECT date_trunc('week', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz} AS this_week,
             (date_trunc('week', now() AT TIME ZONE ${tz}) - interval '7 days') AT TIME ZONE ${tz} AS last_week
    ),
    msgs AS (
      SELECT m.sender_type, m.created_at,
             lag(m.sender_type) OVER w AS prev_sender,
             min(CASE WHEN m.sender_type <> 'customer' THEN m.created_at END)
               OVER (w ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) AS reply_at
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = ${accountId}
        AND m.created_at >= ${localDayStart(tz, 13)}
      WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id)
    ),
    samples AS (
      SELECT created_at AS customer_at,
             extract(epoch FROM (reply_at - created_at))::float8 / 60 AS minutes,
             extract(isodow FROM created_at AT TIME ZONE ${tz})::int - 1 AS dow
      FROM msgs
      WHERE sender_type = 'customer'
        AND (prev_sender IS NULL OR prev_sender <> 'customer')
        AND reply_at IS NOT NULL
    )
    SELECT s.dow,
           avg(s.minutes)::float8 AS avg,
           count(*)::int AS n,
           avg(s.minutes) FILTER (WHERE s.customer_at >= b.this_week)::float8 AS this_week,
           avg(s.minutes) FILTER (WHERE s.customer_at >= b.last_week AND s.customer_at < b.this_week)::float8 AS last_week
    FROM samples s CROSS JOIN b
    GROUP BY GROUPING SETS ((s.dow), ())
  `.execute(db);

  const byDow = new Map<number, { avg: number | null; n: number }>();
  let thisWeekAvg: number | null = null;
  let lastWeekAvg: number | null = null;
  for (const row of r.rows) {
    if (row.dow === null) {
      thisWeekAvg = row.this_week;
      lastWeekAvg = row.last_week;
    } else {
      byDow.set(row.dow, { avg: row.avg, n: row.n });
    }
  }

  // A day with no samples keeps avgMinutes null; the chart mutes it.
  const buckets: ResponseTimeBucket[] = Array.from({ length: 7 }, (_, dow) => ({
    dow,
    avgMinutes: byDow.get(dow)?.avg ?? null,
    samples: byDow.get(dow)?.n ?? 0,
  }));

  return { buckets, thisWeekAvg, lastWeekAvg };
}

// --- 5. Activity feed --------------------------------------------------

/** Broadcast statuses with a translated label in the activity feed. */
const BROADCAST_STATUS_KEYS = new Set(["draft", "scheduled", "sending", "sent", "failed"]);

type Who = { name: string | null; phone: string } | null;

export interface ActivitySources {
  messages: { id: string; created_at: string | null; conversation_id: string; contact: Who }[];
  contacts: { id: string; name: string | null; phone: string; created_at: string | null }[];
  deals: { id: string; title: string; updated_at: string | null; stage_name: string | null }[];
  broadcasts: { id: string; name: string; status: string; total_recipients: number | null; created_at: string | null }[];
  automationLogs: {
    id: string;
    status: string;
    created_at: string;
    automation_name: string | null;
    contact: Who;
  }[];
}

/** Recent rows from each feed source (~10 each; the merge trims). */
export async function loadActivitySources(db: Db, accountId: string): Promise<ActivitySources> {
  const messages = await db
    .selectFrom("messages as m")
    .innerJoin("conversations as c", "c.id", "m.conversation_id")
    .leftJoin("contacts as ct", "ct.id", "c.contact_id")
    .select(["m.id", "m.created_at", "m.conversation_id", "ct.id as contact_id", "ct.name", "ct.phone"])
    .where("c.account_id", "=", accountId)
    .where("m.sender_type", "=", "customer")
    .orderBy("m.created_at", "desc")
    .limit(10)
    .execute();

  const contacts = await db
    .selectFrom("contacts")
    .select(["id", "name", "phone", "created_at"])
    .where("account_id", "=", accountId)
    .orderBy("created_at", "desc")
    .limit(10)
    .execute();

  const deals = await db
    .selectFrom("deals as d")
    .leftJoin("pipeline_stages as s", "s.id", "d.stage_id")
    .select(["d.id", "d.title", "d.updated_at", "s.name as stage_name"])
    .where("d.account_id", "=", accountId)
    .orderBy("d.updated_at", "desc")
    .limit(10)
    .execute();

  const broadcasts = await db
    .selectFrom("broadcasts")
    .select(["id", "name", "status", "total_recipients", "created_at"])
    .where("account_id", "=", accountId)
    .orderBy("created_at", "desc")
    .limit(5)
    .execute();

  const logs = await db
    .selectFrom("automation_logs as l")
    .leftJoin("automations as a", "a.id", "l.automation_id")
    .leftJoin("contacts as ct", "ct.id", "l.contact_id")
    .select(["l.id", "l.status", "l.created_at", "a.name as automation_name", "ct.id as contact_id", "ct.name", "ct.phone"])
    .where("l.account_id", "=", accountId)
    .orderBy("l.created_at", "desc")
    .limit(10)
    .execute();

  return {
    messages: messages.map((m) => ({
      id: m.id,
      created_at: m.created_at,
      conversation_id: m.conversation_id,
      contact: m.contact_id ? { name: m.name, phone: m.phone ?? "" } : null,
    })),
    contacts,
    deals,
    broadcasts,
    automationLogs: logs.map((l) => ({
      id: l.id,
      status: l.status,
      created_at: l.created_at,
      automation_name: l.automation_name,
      contact: l.contact_id ? { name: l.name, phone: l.phone ?? "" } : null,
    })),
  };
}

/** Merge the sources into feed items, newest first, at most `limit`. */
export function buildActivityItems(src: ActivitySources, limit: number): ActivityItem[] {
  const t = getT("Dashboard.activityFeed.items");
  const items: ActivityItem[] = [];

  for (const m of src.messages) {
    const who = m.contact?.name || m.contact?.phone || t("unknown");
    items.push({
      id: `msg-${m.id}`,
      kind: "message",
      text: t("newMessage", { who }),
      at: m.created_at as string,
      href: `/inbox?c=${m.conversation_id}`,
    });
  }

  for (const c of src.contacts) {
    items.push({
      id: `contact-${c.id}`,
      kind: "contact",
      text: t("newContact", { name: c.name || c.phone }),
      at: c.created_at as string,
      href: "/contacts",
    });
  }

  for (const d of src.deals) {
    items.push({
      id: `deal-${d.id}`,
      kind: "deal",
      text: d.stage_name ? t("dealInStage", { title: d.title, stage: d.stage_name }) : t("dealUpdated", { title: d.title }),
      at: d.updated_at as string,
      href: "/pipelines",
    });
  }

  for (const b of src.broadcasts) {
    const count = String(b.total_recipients);
    const status = BROADCAST_STATUS_KEYS.has(b.status) ? t(`broadcastStatusNames.${b.status}`) : b.status;
    items.push({
      id: `broadcast-${b.id}`,
      kind: "broadcast",
      text: b.status === "sent" ? t("broadcastSent", { name: b.name, count }) : t("broadcastStatus", { name: b.name, status, count }),
      at: b.created_at as string,
      href: "/broadcasts",
    });
  }

  for (const l of src.automationLogs) {
    const who = l.contact?.name || l.contact?.phone || t("aContact");
    const autoName = l.automation_name || t("automationFallback");
    items.push({
      id: `auto-${l.id}`,
      kind: "automation",
      text: t(l.status === "failed" ? "automationFailed" : "automationTriggered", { name: autoName, who }),
      at: l.created_at,
    });
  }

  return items.sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0)).slice(0, limit);
}
