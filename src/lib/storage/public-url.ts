// Public object URLs: <base>/api/storage/public/<bucket>/<path>
//
// The base must be reachable from the internet in production — Meta
// fetches outbound media (images, documents, voice notes) from these
// URLs when a message is sent. Isomorphic: no server imports.

export const PUBLIC_STORAGE_PREFIX = "/api/storage/public";

export function publicBaseUrl(): string {
  const fromEnv = process.env.PUBLIC_URL ?? process.env.NEXT_PUBLIC_SITE_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

export function publicObjectUrl(bucket: string, path: string, base = publicBaseUrl()): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  // S3 driver with a public bucket / CDN in front of it: link straight
  // to it (keys are `<bucket>/<path>`, see storage/s3.ts). Server-side
  // only — the browser gets this URL back from the upload route.
  const s3Public = process.env.S3_PUBLIC_BASE_URL;
  if (s3Public && process.env.STORAGE_DRIVER === "s3") {
    return `${s3Public.replace(/\/+$/, "")}/${encodeURIComponent(bucket)}/${encoded}`;
  }
  return `${base}${PUBLIC_STORAGE_PREFIX}/${encodeURIComponent(bucket)}/${encoded}`;
}
