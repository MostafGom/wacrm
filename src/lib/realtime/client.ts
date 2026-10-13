/* eslint-disable @typescript-eslint/no-explicit-any -- results are untyped `any`, exactly like an untyped supabase-js client; callers cast to their own types. */
// ============================================================
// Browser realtime facade — `supabase.channel(...)
//   .on('postgres_changes', { event, table, filter }, cb)
//   .subscribe(statusCb)` over ONE shared Server-Sent Events stream
// (/api/realtime) per tab.
//
// The server already filters events to the caller's account (and to
// the recipient for notifications); here we only route by table /
// event type / the optional `col=eq.value` filter.
//
// Status semantics match supabase-js closely enough for the hooks:
// SUBSCRIBED on (re)connect, CHANNEL_ERROR on a drop. The inbox uses
// the CHANNEL_ERROR → SUBSCRIBED edge to resync what it missed.
// ============================================================

import type { RealtimeChannel, RealtimePostgresChangesPayload, RealtimeStatus } from "@/lib/db/types";

interface WireEvent {
  t: string;
  op: "INSERT" | "UPDATE" | "DELETE";
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  ts: string;
}

type EventKind = "*" | "INSERT" | "UPDATE" | "DELETE";

interface Binding {
  event: EventKind;
  table: string;
  filter: { column: string; op: "eq" | "neq" | "in"; values: string[] } | null;
  cb: (payload: RealtimePostgresChangesPayload<any>) => void;
}

function parseFilter(filter: string | undefined): Binding["filter"] {
  if (!filter) return null;
  const m = /^([A-Za-z0-9_]+)=(eq|neq|in)\.(.*)$/.exec(filter);
  if (!m) {
    console.warn(`[realtime] unsupported filter "${filter}" — ignoring`);
    return null;
  }
  const [, column, op, raw] = m;
  const values = op === "in" ? raw.replace(/^\(|\)$/g, "").split(",").map((s) => s.trim()) : [raw];
  return { column, op: op as "eq" | "neq" | "in", values };
}

function matches(b: Binding, e: WireEvent): boolean {
  if (b.table !== e.t) return false;
  if (b.event !== "*" && b.event !== e.op) return false;
  if (!b.filter) return true;
  const row = (e.op === "DELETE" ? e.old : e.new) ?? {};
  const v = row[b.filter.column];
  const s = v == null ? "null" : String(v);
  if (b.filter.op === "neq") return s !== b.filter.values[0];
  return b.filter.values.includes(s);
}

// ---------------- shared connection ----------------

class Connection {
  private es: EventSource | null = null;
  private channels = new Set<Channel>();
  private open = false;
  private retryMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  add(ch: Channel) {
    this.channels.add(ch);
    if (!this.es && !this.retryTimer) this.connect();
    else if (this.open) queueMicrotask(() => ch.setStatus("SUBSCRIBED"));
  }

  remove(ch: Channel) {
    this.channels.delete(ch);
    if (this.channels.size === 0) this.close();
  }

  private connect() {
    this.retryTimer = null;
    const es = new EventSource("/api/realtime", { withCredentials: true });
    this.es = es;

    es.addEventListener("open", () => {
      this.open = true;
      this.retryMs = 1000;
      for (const ch of this.channels) ch.setStatus("SUBSCRIBED");
    });

    es.addEventListener("change", (msg) => {
      let e: WireEvent;
      try {
        e = JSON.parse((msg as MessageEvent<string>).data);
      } catch {
        return;
      }
      for (const ch of this.channels) ch.dispatch(e);
    });

    // Server lost its LISTEN connection and may have missed events:
    // bounce the status so subscribers resync.
    es.addEventListener("resync", () => {
      for (const ch of this.channels) {
        ch.setStatus("CHANNEL_ERROR");
        ch.setStatus("SUBSCRIBED");
      }
    });

    es.addEventListener("error", () => {
      if (this.open) {
        this.open = false;
        for (const ch of this.channels) ch.setStatus("CHANNEL_ERROR");
      }
      // EventSource retries by itself after network errors, but gives up
      // (CLOSED) on an HTTP error such as 401. Back off and retry.
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        this.es = null;
        if (this.channels.size > 0) {
          this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
          this.retryMs = Math.min(this.retryMs * 2, 60_000);
        }
      }
    });
  }

  private close() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.es?.close();
    this.es = null;
    this.open = false;
  }
}

let connection: Connection | null = null;
const getConnection = () => (connection ??= new Connection());

// ---------------- channel ----------------

class Channel implements RealtimeChannel {
  private bindings: Binding[] = [];
  private statusCb: ((status: RealtimeStatus, err?: Error) => void) | null = null;
  private subscribed = false;
  private lastStatus: RealtimeStatus | null = null;

  constructor(readonly name: string) {}

  on(
    _type: "postgres_changes",
    filter: { event: EventKind; schema?: string; table: string; filter?: string },
    callback: (payload: RealtimePostgresChangesPayload<any>) => void,
  ): RealtimeChannel {
    this.bindings.push({ event: filter.event, table: filter.table, filter: parseFilter(filter.filter), cb: callback });
    return this;
  }

  subscribe(cb?: (status: RealtimeStatus, err?: Error) => void): RealtimeChannel {
    this.statusCb = cb ?? null;
    if (!this.subscribed) {
      this.subscribed = true;
      getConnection().add(this);
    }
    return this;
  }

  async unsubscribe(): Promise<"ok"> {
    if (this.subscribed) {
      this.subscribed = false;
      getConnection().remove(this);
      this.setStatus("CLOSED");
    }
    return "ok";
  }

  setStatus(status: RealtimeStatus) {
    if (status === this.lastStatus && status !== "CHANNEL_ERROR") return;
    this.lastStatus = status;
    this.statusCb?.(status);
  }

  dispatch(e: WireEvent) {
    for (const b of this.bindings) {
      if (!matches(b, e)) continue;
      b.cb({
        schema: "public",
        table: e.t,
        commit_timestamp: e.ts,
        eventType: e.op,
        new: e.new ?? {},
        old: e.old ?? {},
        errors: null,
      });
    }
  }
}

export function createChannel(name: string): RealtimeChannel {
  return new Channel(name);
}

export async function removeChannel(ch: RealtimeChannel): Promise<"ok"> {
  return ch.unsubscribe();
}
