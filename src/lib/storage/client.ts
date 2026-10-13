// Browser storage client over /api/storage/*:
//   getBrowserStorage().from('chat-media').upload(path, file, opts)
//
// `getPublicUrl` is synchronous (a URL helper). The server is the source
// of truth for the public base URL (PUBLIC_URL), so the URL returned by
// an upload is remembered and handed back by getPublicUrl; for paths
// this tab didn't upload it falls back to the current origin.

import type { StorageApi, StorageBucketApi, StorageError } from "./types";
import { publicObjectUrl } from "./public-url";

const known = new Map<string, string>();

async function errorOf(res: Response): Promise<StorageError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return { message: body.error ?? body.message ?? res.statusText, statusCode: String(res.status) };
}

export function createBrowserStorage(): StorageApi {
  return {
    from(bucket: string): StorageBucketApi {
      return {
        async upload(path, body, opts = {}) {
          const form = new FormData();
          form.set("bucket", bucket);
          form.set("path", path);
          if (opts.upsert) form.set("upsert", "true");
          if (opts.cacheControl) form.set("cacheControl", opts.cacheControl);
          const blob =
            body instanceof Blob
              ? body
              : new Blob([body as BlobPart], { type: opts.contentType ?? "application/octet-stream" });
          if (opts.contentType) form.set("contentType", opts.contentType);
          form.set("file", blob);
          try {
            const res = await fetch("/api/storage/upload", { method: "POST", body: form, credentials: "same-origin" });
            if (!res.ok) return { data: null, error: await errorOf(res) };
            const json = (await res.json()) as { path: string; publicUrl: string };
            known.set(`${bucket}/${path}`, json.publicUrl);
            return { data: { path: json.path, fullPath: `${bucket}/${json.path}` }, error: null };
          } catch (e) {
            return { data: null, error: { message: e instanceof Error ? e.message : "Upload failed" } };
          }
        },

        getPublicUrl(path) {
          return { data: { publicUrl: known.get(`${bucket}/${path}`) ?? publicObjectUrl(bucket, path) } };
        },

        async remove(paths) {
          try {
            const res = await fetch("/api/storage/remove", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ bucket, paths }),
            });
            if (!res.ok) return { data: null, error: await errorOf(res) };
            const json = (await res.json()) as { removed: string[] };
            return { data: json.removed.map((name) => ({ name })), error: null };
          } catch (e) {
            return { data: null, error: { message: e instanceof Error ? e.message : "Remove failed" } };
          }
        },
      };
    },
  };
}

let browserStorage: StorageApi | null = null;

/** Shared browser storage client: `getBrowserStorage().from('chat-media').upload(...)`. */
export function getBrowserStorage(): StorageApi {
  browserStorage ??= createBrowserStorage();
  return browserStorage;
}
