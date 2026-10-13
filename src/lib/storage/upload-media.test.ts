import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMediaPath,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
  uploadAccountMedia,
} from "./upload-media";

const h = vi.hoisted(() => ({
  me: null as unknown,
  uploads: [] as { bucket: string; path: string }[],
  removed: [] as { bucket: string; paths: string[] }[],
}));

vi.mock("@/lib/http/client", () => ({ apiRequest: async () => h.me }));
vi.mock("@/lib/storage/client", () => ({
  getBrowserStorage: () => ({
    from: (bucket: string) => ({
      upload: async (path: string) => {
        h.uploads.push({ bucket, path });
        return { data: { path, fullPath: `${bucket}/${path}` }, error: null };
      },
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${bucket}/${path}` } }),
      remove: async (paths: string[]) => {
        h.removed.push({ bucket, paths });
        return { data: [], error: null };
      },
    }),
  }),
}));

const ACCOUNT = "11111111-2222-3333-4444-555555555555";

describe("buildMediaPath", () => {
  it("namespaces under account-<id> so RLS write policies match", () => {
    const path = buildMediaPath(ACCOUNT, "photo.png", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-photo.png`);
    expect(path.split("/")[0]).toBe(`account-${ACCOUNT}`);
  });

  it("lower-cases the extension and sanitizes the basename", () => {
    const path = buildMediaPath(ACCOUNT, "My Invoice (final).PDF", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-My_Invoice_final_.pdf`);
  });

  it("caps the basename at 40 chars", () => {
    const long = "a".repeat(100) + ".png";
    const path = buildMediaPath(ACCOUNT, long, 1700000000000);
    const base = path.split("/")[1].replace("1700000000000-", "").replace(".png", "");
    expect(base.length).toBe(40);
  });

  it("falls back to 'file' / 'bin' for a nameless input", () => {
    const path = buildMediaPath(ACCOUNT, "", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-file.bin`);
  });

  it("defaults the extension to bin when there is none", () => {
    const path = buildMediaPath(ACCOUNT, "README", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-README.bin`);
  });

  it("omits the timestamp when passed null, for callers needing a stable path", () => {
    const path = buildMediaPath(ACCOUNT, "photo.png", null);
    expect(path).toBe(`account-${ACCOUNT}/photo.png`);
  });

  it("nests a subfolder below account-<id>, leaving the RLS segment first", () => {
    const path = buildMediaPath(ACCOUNT, "photo.png", null, "inbound");
    expect(path).toBe(`account-${ACCOUNT}/inbound/photo.png`);
    expect(path.split("/")[0]).toBe(`account-${ACCOUNT}`);
  });
});

describe("MEDIA_MAX_BYTES_BY_KIND", () => {
  it("caps images at Meta's tighter 5 MB limit", () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.image).toBe(5 * 1024 * 1024);
  });

  it("caps video/audio/document at the 16 MB bucket limit", () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.video).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.audio).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.document).toBe(16 * 1024 * 1024);
  });
});

describe("uploadAccountMedia / deleteAccountMedia", () => {
  beforeEach(() => {
    h.me = { data: { profile: { account_id: "acct-from-me" } }, error: null };
    h.uploads = [];
    h.removed = [];
  });

  it("uploads under the caller's account folder (resolved via /api/me)", async () => {
    const file = new File(["x"], "photo.png", { type: "image/png" });
    const res = await uploadAccountMedia("chat-media", file);
    expect(h.uploads[0].bucket).toBe("chat-media");
    expect(res.path.startsWith("account-acct-from-me/")).toBe(true);
    expect(res.publicUrl).toBe(`https://cdn.test/chat-media/${res.path}`);
  });

  it("uses an explicit account id without asking /api/me", async () => {
    h.me = { data: null, error: { status: 500, message: "should not be called" } };
    const res = await uploadAccountMedia("flow-media", new File(["x"], "a.pdf"), ACCOUNT);
    expect(res.path.startsWith(`account-${ACCOUNT}/`)).toBe(true);
  });

  it("throws a user-facing error when signed out or unlinked", async () => {
    h.me = { data: null, error: { status: 401, message: "Unauthorized" } };
    await expect(uploadAccountMedia("chat-media", new File(["x"], "a.png"))).rejects.toThrow("Not signed in.");
    h.me = { data: { profile: null }, error: null };
    await expect(uploadAccountMedia("chat-media", new File(["x"], "a.png"))).rejects.toThrow(
      "Could not resolve your account.",
    );
    expect(h.uploads).toEqual([]);
  });

  it("removes a staged object", async () => {
    await deleteAccountMedia("chat-media", "account-x/1-a.png");
    expect(h.removed).toEqual([{ bucket: "chat-media", paths: ["account-x/1-a.png"] }]);
  });
});
