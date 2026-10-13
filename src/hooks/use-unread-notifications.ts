"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/http/client";
import { createChannel } from "@/lib/realtime/client";
import type { Notification } from "@/types";

/**
 * Count of unread notifications for the current user. Used by the
 * sidebar to surface a badge on the Notifications nav entry.
 *
 * The count comes from /api/notifications/unread-count; realtime
 * events (already filtered to the recipient server-side) keep it live.
 */
export function useUnreadNotifications(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data, error } = await apiRequest<{ count: number }>(
        "/api/notifications/unread-count",
      );
      if (cancelled || error) return;
      setCount(data.count);
    })();

    const channel = createChannel("notifications-unread-count")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const row = payload.new as Notification;
            if (!row.read_at) setCount((n) => n + 1);
          } else if (payload.eventType === "UPDATE") {
            // Updates here only ever set read_at (marking a notification
            // read), so derive purely from the new row.
            const newRow = payload.new as Notification;
            if (newRow.read_at) setCount((n) => Math.max(0, n - 1));
          } else if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Notification>;
            if (!oldRow.read_at) setCount((n) => Math.max(0, n - 1));
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void channel.unsubscribe();
    };
  }, []);

  return count;
}
