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
  return `${base}${PUBLIC_STORAGE_PREFIX}/${encodeURIComponent(bucket)}/${encoded}`;
}
