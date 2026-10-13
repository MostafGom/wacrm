// Quick replies repository against real Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser } from "@/server/db";
import {
  createQuickReply,
  deleteQuickReply,
  listQuickReplies,
  updateQuickReply,
} from "@/server/repos/quick-replies";
import {
  joinAccount,
  seedUser,
  teardownIntegrationDb,
  useIntegrationDb,
  type SeededUser,
} from "@/test/integration/helpers";

let owner: SeededUser;
let agent: SeededUser;
let viewer: SeededUser;
let outsider: SeededUser;

const PAYLOAD = { type: "button", body: { text: "Pick one" }, action: { buttons: [{ id: "a", title: "A" }] } };

beforeAll(async () => {
  useIntegrationDb();
  owner = await seedUser("Owner");
  agent = await seedUser("Agent");
  viewer = await seedUser("Viewer");
  outsider = await seedUser("Outsider");
  await joinAccount(agent.id, owner.accountId, "agent");
  await joinAccount(viewer.id, owner.accountId, "viewer");
});

afterAll(teardownIntegrationDb);

describe("quick-replies repo", () => {
  it("agent creates text + interactive replies; every member lists them", async () => {
    const text = await asUser(agent.id, (db) =>
      createQuickReply(db, {
        account_id: owner.accountId,
        user_id: agent.id,
        title: "Hi",
        kind: "text",
        content_text: "Hello there",
        interactive_payload: null,
      }),
    );
    expect(text).toMatchObject({ title: "Hi", kind: "text", interactive_payload: null });

    const interactive = await asUser(agent.id, (db) =>
      createQuickReply(db, {
        account_id: owner.accountId,
        user_id: agent.id,
        title: "Menu",
        kind: "interactive",
        content_text: null,
        interactive_payload: PAYLOAD,
      }),
    );
    // jsonb round-trips as an object (buttons array intact).
    expect(interactive.interactive_payload).toEqual(PAYLOAD);

    const rows = await asUser(viewer.id, (db) => listQuickReplies(db, owner.accountId));
    expect(rows.map((r) => r.title).sort()).toEqual(["Hi", "Menu"]);
    expect(await asUser(outsider.id, (db) => listQuickReplies(db, owner.accountId))).toEqual([]);
  });

  it("viewers can't write (RLS quick_replies_insert is agent+)", async () => {
    await expect(
      asUser(viewer.id, (db) =>
        createQuickReply(db, {
          account_id: owner.accountId,
          user_id: viewer.id,
          title: "x",
          kind: "text",
          content_text: "x",
          interactive_payload: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("update / delete are account-scoped", async () => {
    const [hi] = (await asUser(agent.id, (db) => listQuickReplies(db, owner.accountId))).filter(
      (r) => r.title === "Hi",
    );
    await asUser(outsider.id, (db) => updateQuickReply(db, outsider.accountId, hi.id, { title: "Hacked" }));
    await asUser(agent.id, (db) =>
      updateQuickReply(db, owner.accountId, hi.id, { kind: "interactive", interactive_payload: PAYLOAD, content_text: null }),
    );
    let rows = await asUser(agent.id, (db) => listQuickReplies(db, owner.accountId));
    expect(rows.find((r) => r.id === hi.id)).toMatchObject({
      title: "Hi",
      kind: "interactive",
      content_text: null,
      interactive_payload: PAYLOAD,
    });

    await asUser(outsider.id, (db) => deleteQuickReply(db, outsider.accountId, hi.id));
    expect((await asUser(agent.id, (db) => listQuickReplies(db, owner.accountId))).length).toBe(2);
    await asUser(agent.id, (db) => deleteQuickReply(db, owner.accountId, hi.id));
    rows = await asUser(agent.id, (db) => listQuickReplies(db, owner.accountId));
    expect(rows.map((r) => r.title)).toEqual(["Menu"]);
  });
});
