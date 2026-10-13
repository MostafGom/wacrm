import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser } from "@/server/db";
import {
  countKnowledgeChunks,
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  insertKnowledgeDocument,
  listKnowledgeDocumentContents,
  listKnowledgeDocuments,
  matchKnowledgeFts,
  matchKnowledgeSemantic,
  replaceDocumentChunks,
  updateKnowledgeDocument,
} from "@/server/repos/ai-knowledge";
import { toVectorLiteral, EMBEDDING_DIMENSIONS } from "@/lib/ai/embeddings";
import {
  joinAccount,
  seedUser,
  teardownIntegrationDb,
  useIntegrationDb,
  type SeededUser,
} from "@/test/integration/helpers";

/** One-hot vector of the column's dimension (cosine-distinct per axis). */
function axis(i: number): string {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[i] = 1;
  return toVectorLiteral(v);
}

let admin: SeededUser;
let viewer: SeededUser;
let other: SeededUser;
let docId: string;

beforeAll(async () => {
  useIntegrationDb();
  admin = await seedUser("Admin");
  viewer = await seedUser("Viewer");
  other = await seedUser("Other");
  await joinAccount(viewer.id, admin.accountId, "viewer");
});

afterAll(teardownIntegrationDb);

describe("ai-knowledge repo", () => {
  it("admin creates, lists, reads and updates documents", async () => {
    const { id } = await asUser(admin.id, (db) =>
      insertKnowledgeDocument(db, {
        account_id: admin.accountId,
        created_by: admin.id,
        title: "Returns",
        content: "Returns accepted within 30 days",
      }),
    );
    docId = id;

    const list = await asUser(viewer.id, (db) => listKnowledgeDocuments(db, admin.accountId));
    expect(list).toEqual([{ id, title: "Returns", updated_at: expect.stringMatching(/\+00:00$/) }]);

    const updated = await asUser(admin.id, (db) =>
      updateKnowledgeDocument(db, admin.accountId, id, { title: "Return policy" }),
    );
    expect(updated).toEqual({ id });
    const doc = await asUser(viewer.id, (db) => getKnowledgeDocument(db, admin.accountId, id));
    expect(doc).toMatchObject({ id, title: "Return policy", content: "Returns accepted within 30 days" });

    // Scoped: another account sees nothing and can't update it.
    expect(await asUser(other.id, (db) => getKnowledgeDocument(db, other.accountId, id))).toBeUndefined();
    expect(
      await asUser(other.id, (db) => updateKnowledgeDocument(db, other.accountId, id, { title: "x" })),
    ).toBeUndefined();
    expect(await asUser(admin.id, (db) => listKnowledgeDocumentContents(db, admin.accountId))).toEqual([
      { id, content: "Returns accepted within 30 days" },
    ]);
  });

  it("viewers cannot write (RLS: admin writes)", async () => {
    await expect(
      asUser(viewer.id, (db) =>
        insertKnowledgeDocument(db, { account_id: admin.accountId, created_by: viewer.id, title: "t", content: "c" }),
      ),
    ).rejects.toThrow();
  });

  it("replaces chunks idempotently and searches them (FTS + semantic)", async () => {
    const chunks = [
      { chunk_index: 0, content: "Returns accepted within 30 days", embedding: axis(0) },
      { chunk_index: 1, content: "Shipping is free over 50 euros", embedding: axis(1) },
    ];
    await asUser(admin.id, (db) => replaceDocumentChunks(db, admin.accountId, docId, chunks));
    await asUser(admin.id, (db) => replaceDocumentChunks(db, admin.accountId, docId, chunks));
    expect(await asUser(viewer.id, (db) => countKnowledgeChunks(db, admin.accountId))).toBe(2);
    expect(await asUser(other.id, (db) => countKnowledgeChunks(db, other.accountId))).toBe(0);

    const fts = await asUser(viewer.id, (db) => matchKnowledgeFts(db, admin.accountId, "shipping free", 5));
    expect(fts.map((r) => r.content)).toEqual(["Shipping is free over 50 euros"]);

    // Semantic runs under the service role on the auto-reply path.
    const sem = await asService((db) => matchKnowledgeSemantic(db, admin.accountId, axis(1), 2));
    expect(sem.map((r) => r.content)).toEqual(["Shipping is free over 50 euros", "Returns accepted within 30 days"]);

    // Account-scoped even under the service role.
    expect(await asService((db) => matchKnowledgeFts(db, other.accountId, "shipping", 5))).toEqual([]);
    expect(await asService((db) => matchKnowledgeSemantic(db, other.accountId, axis(1), 5))).toEqual([]);

    // Lexical-only chunks (no embedding) are skipped by semantic search.
    await asUser(admin.id, (db) =>
      replaceDocumentChunks(db, admin.accountId, docId, [{ chunk_index: 0, content: "plain", embedding: null }]),
    );
    expect(await asService((db) => matchKnowledgeSemantic(db, admin.accountId, axis(0), 5))).toEqual([]);
    expect(await asUser(admin.id, (db) => countKnowledgeChunks(db, admin.accountId))).toBe(1);
  });

  it("deleting a document cascades its chunks", async () => {
    await asUser(admin.id, (db) => deleteKnowledgeDocument(db, admin.accountId, docId));
    expect(await asUser(admin.id, (db) => listKnowledgeDocuments(db, admin.accountId))).toEqual([]);
    expect(await asUser(admin.id, (db) => countKnowledgeChunks(db, admin.accountId))).toBe(0);
  });
});
