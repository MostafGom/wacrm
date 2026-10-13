// ============================================================
// Realtime hub — one LISTEN connection per server process, fanning
// `wacrm_realtime` notifications (db/migrations/048) out to the SSE
// subscribers registered by /api/realtime.
//
// Tenant isolation happens HERE: an event is delivered only to
// subscribers of the same account, and `notifications` rows only to
// their recipient — mirroring the SELECT policies on those tables.
// ============================================================

import pg from "pg";

import { asService, sql } from "@/server/db";

export interface RealtimeEvent {
  t: string;
  op: "INSERT" | "UPDATE" | "DELETE";
  a: string;
  u: string | null;
  id: string | null;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  ts: string;
  trunc?: boolean;
}

export interface Subscriber {
  accountId: string;
  userId: string;
  send(event: "change" | "resync", data: unknown): void;
}

const CHANNEL = "wacrm_realtime";

/** Tables whose rows are visible only to `user_id` (not the whole account). */
const PER_USER_TABLES = new Set(["notifications"]);

/** Truncated payloads are re-read by primary key. */
const PK_COLUMN: Record<string, string> = { member_presence: "user_id" };
const REFETCHABLE = new Set(["conversations", "messages", "message_reactions", "flow_runs", "member_presence", "notifications"]);

class Hub {
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private subscribers = new Set<Subscriber>();
  private backoffMs = 500;
  private everConnected = false;

  async add(sub: Subscriber): Promise<void> {
    this.subscribers.add(sub);
    await this.ensure();
  }

  remove(sub: Subscriber): void {
    this.subscribers.delete(sub);
  }

  countFor(userId: string): number {
    let n = 0;
    for (const s of this.subscribers) if (s.userId === userId) n++;
    return n;
  }

  private ensure(): Promise<void> {
    if (this.client) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      application_name: "wacrm-realtime",
      options: "-c timezone=UTC",
    });
    client.on("notification", (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      void this.dispatch(msg.payload);
    });
    const onDown = (err?: Error) => {
      if (this.client !== client) return;
      console.warn("[realtime] LISTEN connection lost:", err?.message ?? "closed");
      this.client = null;
      client.removeAllListeners();
      client.end().catch(() => {});
      this.scheduleReconnect();
    };
    client.on("error", onDown);
    client.on("end", () => onDown());

    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (err) {
      client.removeAllListeners();
      await client.end().catch(() => {});
      console.warn("[realtime] LISTEN connect failed:", (err as Error).message);
      this.scheduleReconnect();
      return;
    }
    this.client = client;
    this.backoffMs = 500;
    if (this.everConnected) {
      // Events during the gap were lost; tell clients to resync.
      for (const s of this.subscribers) s.send("resync", {});
    }
    this.everConnected = true;
  }

  private scheduleReconnect() {
    if (this.subscribers.size === 0) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    setTimeout(() => void this.ensure(), wait).unref?.();
  }

  private async dispatch(raw: string): Promise<void> {
    let e: RealtimeEvent;
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    if (e.trunc) {
      const row = await refetch(e).catch(() => null);
      if (e.op === "DELETE") e.old = row ?? (e.id ? { id: e.id } : {});
      else if (row) e.new = row;
      else return;
    }
    const wire = { t: e.t, op: e.op, new: e.new, old: e.old, ts: e.ts };
    for (const s of this.subscribers) {
      if (s.accountId !== e.a) continue;
      if (PER_USER_TABLES.has(e.t) && s.userId !== e.u) continue;
      s.send("change", wire);
    }
  }
}

async function refetch(e: RealtimeEvent): Promise<Record<string, unknown> | null> {
  if (!e.id || !REFETCHABLE.has(e.t)) return null;
  const pk = PK_COLUMN[e.t] ?? "id";
  const id = e.id;
  // Table/column come from the fixed allowlists above, never from input.
  const r = await asService((db) =>
    sql<{ row: Record<string, unknown> }>`SELECT to_jsonb(x) AS row FROM ${sql.table(`public.${e.t}`)} x WHERE ${sql.ref(`x.${pk}`)} = ${id}`.execute(db),
  );
  return r.rows[0]?.row ?? null;
}

const g = globalThis as unknown as { __wacrmRealtimeHub?: Hub };

export function getHub(): Hub {
  g.__wacrmRealtimeHub ??= new Hub();
  return g.__wacrmRealtimeHub;
}
