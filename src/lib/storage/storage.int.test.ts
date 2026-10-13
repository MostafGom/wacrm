// Storage against a real database + local driver: bucket RLS policies
// authorise uploads, bucket limits apply even to the service role.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setDriverForTests } from "@/lib/storage/driver";
import { createLocalDriver } from "@/lib/storage/local";
import { adminStorage, getPublicObjectMeta, userStorage } from "@/lib/storage/server";
import { seedUser, teardownIntegrationDb, useIntegrationDb, type SeededUser } from "@/test/integration/helpers";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let dir: string;
let alice: SeededUser;
let bob: SeededUser;

beforeAll(async () => {
  useIntegrationDb();
  dir = await mkdtemp(path.join(os.tmpdir(), "wacrm-storage-"));
  setDriverForTests(createLocalDriver(dir));
  alice = await seedUser("Alice");
  bob = await seedUser("Bob");
});

afterAll(async () => {
  setDriverForTests(null);
  await rm(dir, { recursive: true, force: true });
  await teardownIntegrationDb();
});

describe("user uploads", () => {
  it("uploads into the caller's account folder and serves metadata", async () => {
    const p = `account-${alice.accountId}/1-photo.png`;
    const { data, error } = await userStorage(alice.id).from("chat-media").upload(p, PNG, { contentType: "image/png" });
    expect(error).toBeNull();
    expect(data?.path).toBe(p);
    expect(await readFile(path.join(dir, "chat-media", p))).toEqual(PNG);

    const meta = await getPublicObjectMeta("chat-media", p);
    expect(meta?.mimetype).toBe("image/png");
    expect(meta?.size).toBe(PNG.length);

    const url = userStorage(alice.id).from("chat-media").getPublicUrl(p).data.publicUrl;
    expect(url).toBe(`https://crm.example.test/api/storage/public/chat-media/${p}`);
  });

  it("RLS blocks uploads into another account's folder", async () => {
    const { error } = await userStorage(bob.id)
      .from("chat-media")
      .upload(`account-${alice.accountId}/2-x.png`, PNG, { contentType: "image/png" });
    expect(error?.statusCode).toBe("403");
  });

  it("refuses duplicates unless upsert, and avatars by user folder", async () => {
    const p = `${alice.id}/avatar.png`;
    const s = userStorage(alice.id).from("avatars");
    expect((await s.upload(p, PNG, { contentType: "image/png" })).error).toBeNull();
    expect((await s.upload(p, PNG, { contentType: "image/png" })).error?.statusCode).toBe("409");
    expect((await s.upload(p, PNG, { contentType: "image/png", upsert: true })).error).toBeNull();
  });

  it("enforces MIME allow-list and content sniffing", async () => {
    const s = userStorage(alice.id).from("avatars");
    expect((await s.upload(`${alice.id}/x.html`, Buffer.from("<script>"), { contentType: "text/html" })).error?.statusCode).toBe("415");
    expect((await s.upload(`${alice.id}/fake.png`, Buffer.from("<svg>"), { contentType: "image/png" })).error?.statusCode).toBe("415");
  });

  it("rejects traversal and odd paths", async () => {
    const s = userStorage(alice.id).from("chat-media");
    for (const bad of [`account-${alice.accountId}/../../etc/passwd`, `/abs.png`, `account-${alice.accountId}/.hidden`]) {
      expect((await s.upload(bad, PNG, { contentType: "image/png" })).error?.statusCode).toBe("400");
    }
  });

  it("remove only deletes what RLS lets the caller see", async () => {
    const p = `account-${alice.accountId}/3-del.png`;
    await userStorage(alice.id).from("chat-media").upload(p, PNG, { contentType: "image/png" });
    const bobTry = await userStorage(bob.id).from("chat-media").remove([p]);
    expect(bobTry.data).toEqual([]);
    const aliceDel = await userStorage(alice.id).from("chat-media").remove([p]);
    expect(aliceDel.data).toEqual([{ name: p }]);
    expect(await getPublicObjectMeta("chat-media", p)).toBeNull();
  });
});

describe("service role", () => {
  it("bypasses folder policies but not the bucket size limit", async () => {
    const s = adminStorage().from("chat-media");
    const ok = await s.upload(`account-${bob.accountId}/inbound/m1.png`, PNG, { contentType: "image/png", upsert: true });
    expect(ok.error).toBeNull();
    const big = Buffer.alloc(17 * 1024 * 1024);
    const tooBig = await s.upload(`account-${bob.accountId}/inbound/big.bin`, big, { contentType: "application/pdf" });
    expect(tooBig.error?.statusCode).toBe("413");
  });
});
