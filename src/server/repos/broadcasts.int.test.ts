// Broadcasts repository against real Postgres: jsonb round-trips, the
// recipient aggregate trigger, the atomic create RPC, the delivery lock
// and account scoping.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { finalizeBroadcastStatus } from "@/lib/whatsapp/broadcast-core";
import { asService, asUser, serviceRunner } from "@/server/db";
import {
  claimDeliveryLock,
  createBroadcastWithRecipients,
  deleteBroadcast,
  failRecipients,
  getBroadcast,
  getBroadcastSummary,
  insertBroadcast,
  insertPendingRecipients,
  listBroadcasts,
  listRecipientsWithContact,
  loadRecipientsForResume,
  recipientStatusCounts,
  releaseDeliveryLock,
  setBroadcastStatus,
  stampRecipient,
} from "@/server/repos/broadcasts";
import { joinAccount, seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

let owner: SeededUser;
let viewer: SeededUser;
let other: SeededUser;
let contactIds: string[];

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  viewer = await seedUser("Viewer");
  other = await seedUser("Other");
  await joinAccount(viewer.id, owner.accountId, "viewer");
  contactIds = await asService(async (db) => {
    const rows = await db
      .insertInto("contacts")
      .values([
        { account_id: owner.accountId, user_id: owner.id, phone: "+15550000001", name: "Ann" },
        { account_id: owner.accountId, user_id: owner.id, phone: "+15550000002", name: "Ben" },
        { account_id: owner.accountId, user_id: owner.id, phone: "not a phone", name: "Bad" },
      ])
      .returning("id")
      .execute();
    return rows.map((r) => r.id);
  });
});

afterAll(teardownIntegrationDb);

function newBroadcast(userId = owner.id, accountId = owner.accountId) {
  return asUser(userId, (db) =>
    insertBroadcast(db, {
      account_id: accountId,
      user_id: userId,
      name: "Promo",
      template_name: "promo",
      template_language: "en_US",
      template_variables: { "1": { type: "field", value: "name" } },
      audience_filter: { type: "tags", tagIds: ["t-1"] },
      status: "sending",
      total_recipients: 3,
    }),
  );
}

describe("broadcasts repo", () => {
  it("inserts a broadcast with jsonb config and zeroed counts", async () => {
    const b = await newBroadcast();
    expect(b.status).toBe("sending");
    expect(b.template_variables).toEqual({ "1": { type: "field", value: "name" } });
    expect(b.audience_filter).toEqual({ type: "tags", tagIds: ["t-1"] });
    expect(b.sent_count).toBe(0);
    expect(b.created_at).toMatch(/\+00:00$/);

    const listed = await asUser(owner.id, (db) => listBroadcasts(db, owner.accountId));
    expect(listed.map((r) => r.id)).toContain(b.id);
    expect(await asUser(other.id, (db) => getBroadcast(db, other.accountId, b.id))).toBeUndefined();
  });

  it("refuses a viewer's insert (broadcasts_insert RLS)", async () => {
    await expect(newBroadcast(viewer.id)).rejects.toThrow();
  });

  it("stores frozen params as jsonb arrays and embeds the contact", async () => {
    const b = await newBroadcast();
    const rows = await asUser(owner.id, (db) =>
      insertPendingRecipients(db, b.id, [
        { contactId: contactIds[0], params: ["Ann", "Friday"] },
        { contactId: contactIds[1], params: [] },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.contact_id === contactIds[0])?.template_params).toEqual(["Ann", "Friday"]);

    const listed = await asUser(owner.id, (db) => listRecipientsWithContact(db, owner.accountId, b.id));
    expect(listed).toHaveLength(2);
    const ann = listed.find((r) => r.contact_id === contactIds[0])!;
    expect(ann.status).toBe("pending");
    expect((ann.contact as { name: string }).name).toBe("Ann");
    // Another account sees nothing even with the id.
    expect(await asService((db) => listRecipientsWithContact(db, other.accountId, b.id))).toEqual([]);
  });

  it("stamps outcomes; the aggregate trigger keeps the counts", async () => {
    const b = await newBroadcast();
    const [r1, r2] = await asUser(owner.id, (db) =>
      insertPendingRecipients(db, b.id, [
        { contactId: contactIds[0], params: [] },
        { contactId: contactIds[1], params: [] },
      ]),
    );
    expect(
      await asUser(owner.id, (db) =>
        stampRecipient(db, owner.accountId, b.id, { id: r1.id, status: "sent", whatsapp_message_id: "wamid-1" }),
      ),
    ).toBe(true);
    expect(
      await asUser(owner.id, (db) =>
        stampRecipient(db, owner.accountId, b.id, { id: r2.id, status: "failed", error_message: "boom" }),
      ),
    ).toBe(true);
    // Wrong account → no row.
    expect(
      await asService((db) =>
        stampRecipient(db, other.accountId, b.id, { id: r1.id, status: "failed", error_message: "x" }),
      ),
    ).toBe(false);

    const after = await asUser(owner.id, (db) => getBroadcast(db, owner.accountId, b.id));
    expect(after?.sent_count).toBe(1);
    expect(after?.failed_count).toBe(1);

    const recs = await asUser(owner.id, (db) => listRecipientsWithContact(db, owner.accountId, b.id));
    const sent = recs.find((r) => r.id === r1.id)!;
    expect(sent.whatsapp_message_id).toBe("wamid-1");
    expect(sent.sent_at).toMatch(/\+00:00$/);

    expect(await asUser(owner.id, (db) => recipientStatusCounts(db, owner.accountId, b.id))).toEqual({
      pending: 0,
      failed: 1,
      total: 2,
    });
    expect(await asUser(owner.id, (db) => setBroadcastStatus(db, owner.accountId, b.id, "sent"))).toBe(true);
    expect(await asUser(viewer.id, (db) => setBroadcastStatus(db, owner.accountId, b.id, "failed"))).toBe(false);
  });

  it("finalizes from the recipient rows (service runner)", async () => {
    const b = await newBroadcast();
    const [r1] = await asUser(owner.id, (db) =>
      insertPendingRecipients(db, b.id, [{ contactId: contactIds[0], params: [] }]),
    );
    await finalizeBroadcastStatus(serviceRunner, owner.accountId, b.id);
    expect((await asService((db) => getBroadcast(db, owner.accountId, b.id)))?.status).toBe("sending");

    await asService((db) => failRecipients(db, owner.accountId, b.id, [r1.id], "No valid phone number on contact"));
    await finalizeBroadcastStatus(serviceRunner, owner.accountId, b.id);
    const done = await asService((db) => getBroadcast(db, owner.accountId, b.id));
    expect(done?.status).toBe("failed");
  });

  it("creates parent + recipients atomically through the service-role RPC", async () => {
    const rows = await asService((db) =>
      createBroadcastWithRecipients(db, {
        accountId: owner.accountId,
        userId: owner.id,
        name: "API broadcast (promo)",
        templateName: "promo",
        templateLanguage: "en",
        contactIds: [contactIds[0], contactIds[1]],
        templateParams: [["Ann"], []],
      }),
    );
    expect(rows).toHaveLength(2);
    const id = rows[0].broadcast_id;
    const summary = await asService((db) => getBroadcastSummary(db, owner.accountId, id));
    expect(summary).toMatchObject({ status: "sending", total_recipients: 2, template_language: "en", sent_count: 0 });
    expect(Object.keys(summary!).sort()).toEqual(
      [
        "id",
        "name",
        "template_name",
        "template_language",
        "status",
        "total_recipients",
        "sent_count",
        "delivered_count",
        "read_count",
        "replied_count",
        "failed_count",
        "created_at",
        "updated_at",
      ].sort(),
    );

    const resume = await asService((db) =>
      loadRecipientsForResume(db, owner.accountId, id, ["pending"], 10),
    );
    expect(resume.inScope).toBe(2);
    const ann = resume.rows.find((r) => r.phone === "+15550000001")!;
    expect(ann.template_params).toEqual(["Ann"]);

    // Granted to service_role only.
    await expect(
      asUser(owner.id, (db) =>
        createBroadcastWithRecipients(db, {
          accountId: owner.accountId,
          userId: owner.id,
          name: "x",
          templateName: "promo",
          templateLanguage: "en",
          contactIds: [contactIds[0]],
          templateParams: [[]],
        }),
      ),
    ).rejects.toThrow();
  });

  it("caps the resume load but reports the whole backlog", async () => {
    const b = await newBroadcast();
    await asUser(owner.id, (db) =>
      insertPendingRecipients(
        db,
        b.id,
        contactIds.map((contactId) => ({ contactId, params: [] })),
      ),
    );
    const r = await asService((db) => loadRecipientsForResume(db, owner.accountId, b.id, ["pending", "failed"], 2));
    expect(r.rows).toHaveLength(2);
    expect(r.inScope).toBe(3);
    expect(await asService((db) => loadRecipientsForResume(db, other.accountId, b.id, ["pending"], 2))).toEqual({
      rows: [],
      inScope: 0,
    });
  });

  it("takes the delivery lock once, and again only after it goes stale", async () => {
    const b = await newBroadcast();
    const now = new Date();
    const stale = new Date(now.getTime() - 30 * 60 * 1000);
    expect(await asUser(owner.id, (db) => claimDeliveryLock(db, owner.accountId, b.id, now, stale))).toBe(true);
    expect(await asUser(owner.id, (db) => claimDeliveryLock(db, owner.accountId, b.id, now, stale))).toBe(false);
    // An hour later the stamp reads as abandoned.
    const later = new Date(now.getTime() + 60 * 60 * 1000);
    const laterStale = new Date(later.getTime() - 30 * 60 * 1000);
    expect(await asService((db) => claimDeliveryLock(db, owner.accountId, b.id, later, laterStale))).toBe(true);
    // Another tenant can't claim it.
    await asService((db) => releaseDeliveryLock(db, owner.accountId, b.id));
    expect(await asService((db) => claimDeliveryLock(db, other.accountId, b.id, now, stale))).toBe(false);
    expect(await asUser(owner.id, (db) => claimDeliveryLock(db, owner.accountId, b.id, now, stale))).toBe(true);
  });

  it("deletes a broadcast with its recipients, account-scoped", async () => {
    const b = await newBroadcast();
    await asUser(owner.id, (db) => insertPendingRecipients(db, b.id, [{ contactId: contactIds[0], params: [] }]));
    expect(await asService((db) => deleteBroadcast(db, other.accountId, b.id))).toBe(false);
    expect(await asUser(owner.id, (db) => deleteBroadcast(db, owner.accountId, b.id))).toBe(true);
    const left = await asService((db) =>
      db.selectFrom("broadcast_recipients").select("id").where("broadcast_id", "=", b.id).execute(),
    );
    expect(left).toEqual([]);
  });
});
