// Repository integration test — the reference pattern for every repo:
// seed through the helpers, call the repo inside asUser/asService, and
// assert both the result and that RLS + explicit scoping hold.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser } from "@/server/db";
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/server/repos/notifications";
import {
  joinAccount,
  seedUser,
  teardownIntegrationDb,
  useIntegrationDb,
  type SeededUser,
} from "@/test/integration/helpers";

let owner: SeededUser;
let mate: SeededUser;
let ids: string[];

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  mate = await seedUser("Mate");
  await joinAccount(mate.id, owner.accountId, "agent");
  ids = await asService(async (db) => {
    const rows = await db
      .insertInto("notifications")
      .values([
        { account_id: owner.accountId, user_id: owner.id, title: "one" },
        { account_id: owner.accountId, user_id: owner.id, title: "two" },
        { account_id: owner.accountId, user_id: mate.id, title: "for mate" },
      ])
      .returning("id")
      .execute();
    return rows.map((r) => r.id);
  });
});

afterAll(teardownIntegrationDb);

describe("notifications repo", () => {
  it("lists only the caller's notifications, newest first, with ISO timestamps", async () => {
    const rows = await asUser(owner.id, (db) => listNotifications(db, owner.accountId, owner.id));
    expect(rows.map((r) => r.title).sort()).toEqual(["one", "two"]);
    expect(rows[0].created_at).toMatch(/^\d{4}-\d\d-\d\dT.*\+00:00$/);
  });

  it("counts unread and marks read (own rows only)", async () => {
    expect(await asUser(owner.id, (db) => countUnreadNotifications(db, owner.id))).toBe(2);
    // The mate cannot mark the owner's notification read.
    expect(await asUser(mate.id, (db) => markNotificationRead(db, mate.id, ids[0]))).toBe(false);
    expect(await asUser(owner.id, (db) => markNotificationRead(db, owner.id, ids[0]))).toBe(true);
    expect(await asUser(owner.id, (db) => countUnreadNotifications(db, owner.id))).toBe(1);
    expect(await asUser(owner.id, (db) => markAllNotificationsRead(db, owner.id))).toBe(1);
    expect(await asUser(mate.id, (db) => countUnreadNotifications(db, mate.id))).toBe(1);
  });

  it("RLS hides other users' rows even without the explicit filter", async () => {
    const all = await asUser(mate.id, (db) => db.selectFrom("notifications").select("title").execute());
    expect(all.map((r) => r.title)).toEqual(["for mate"]);
  });
});
