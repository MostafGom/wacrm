/* eslint-disable @typescript-eslint/no-explicit-any -- row payloads are untyped; subscribers cast to their row type. */
// Realtime channel API (browser), served by src/lib/realtime/client.ts.
// The method names and payload shape follow supabase-js'
// `postgres_changes` channels.

export interface RealtimePostgresChangesPayload<T = Record<string, any>> {
  schema: string;
  table: string;
  commit_timestamp: string;
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
  errors: null;
}

export type RealtimeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

export interface RealtimeChannel {
  on(
    type: "postgres_changes",
    filter: { event: "*" | "INSERT" | "UPDATE" | "DELETE"; schema?: string; table: string; filter?: string },
    callback: (payload: RealtimePostgresChangesPayload<any>) => void,
  ): RealtimeChannel;
  subscribe(cb?: (status: RealtimeStatus, err?: Error) => void): RealtimeChannel;
  unsubscribe(): Promise<"ok">;
}

