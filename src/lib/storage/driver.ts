// ============================================================
// Object storage drivers.
//
// Bytes live in a driver; metadata (bucket, name, owner, MIME, size)
// lives in Postgres `storage.objects`, where the bucket RLS policies
// from the original Supabase migrations authorise every write. The
// driver itself does no authorisation — callers go through
// `@/lib/storage/server`, never straight to a driver.
//
//   STORAGE_DRIVER=local (default)  files under STORAGE_DIR
//   STORAGE_DRIVER=s3               any S3-compatible service (MinIO, R2, AWS)
// ============================================================

import type { Readable } from "node:stream";

export interface ObjectBody {
  stream: Readable;
  size: number;
  /** Total object size (differs from `size` for range reads). */
  totalSize: number;
}

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

export interface StorageDriver {
  readonly name: string;
  put(bucket: string, key: string, body: Buffer, meta: { contentType: string; cacheControl?: string }): Promise<void>;
  get(bucket: string, key: string, range?: ByteRange): Promise<ObjectBody | null>;
  delete(bucket: string, keys: string[]): Promise<void>;
}

// Bucket ids and object path segments. Mirrors what the app generates
// (`account-<uuid>/inbound/<ts>-<name>.<ext>`, `<uuid>/avatar-<ts>.png`)
// and rules out traversal (`..`), hidden files and separators.
const BUCKET_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const MAX_DEPTH = 6;

export class InvalidObjectPathError extends Error {
  constructor(what: string) {
    super(`Invalid object path: ${what}`);
    this.name = "InvalidObjectPathError";
  }
}

export function assertValidBucket(bucket: string): void {
  if (!BUCKET_RE.test(bucket)) throw new InvalidObjectPathError(bucket);
}

/** Validates and returns the path's segments. */
export function assertValidObjectPath(path: string): string[] {
  const segs = path.split("/");
  if (segs.length === 0 || segs.length > MAX_DEPTH) throw new InvalidObjectPathError(path);
  for (const s of segs) {
    if (!SEGMENT_RE.test(s) || s === "." || s === "..") throw new InvalidObjectPathError(path);
  }
  return segs;
}

let driver: Promise<StorageDriver> | null = null;

export function getDriver(): Promise<StorageDriver> {
  if (!driver) {
    const kind = (process.env.STORAGE_DRIVER ?? "local").toLowerCase();
    driver =
      kind === "s3"
        ? import("./s3").then((m) => m.createS3Driver())
        : import("./local").then((m) => m.createLocalDriver());
    driver.catch(() => {
      driver = null;
    });
  }
  return driver;
}

/** Tests only. */
export function setDriverForTests(d: StorageDriver | null): void {
  driver = d ? Promise.resolve(d) : null;
}
