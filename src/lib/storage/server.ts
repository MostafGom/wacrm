// ============================================================
// Server-side Storage API (the `.storage.from(bucket)` facade on
// server DbClients, and the engine behind /api/storage/*).
//
// Every write records a `storage.objects` row in the SAME transaction
// and under the SAME role as the caller, so:
//   * user uploads are authorised by the bucket policies from the
//     original migrations (008 / 016 / 020 / 023 / 043) — e.g. only
//     into `account-<your account>/...` or `<your uid>/...`;
//   * the service role bypasses those policies but NOT the bucket's
//     size / MIME limits, which are enforced here from storage.buckets.
// ============================================================

import { sql } from "kysely";

import { withRole, type Db, type DbRole } from "@/server/db";
import type { StorageApi, StorageBucketApi, StorageError } from "./types";
import { assertValidBucket, assertValidObjectPath, getDriver, InvalidObjectPathError } from "./driver";
import { publicObjectUrl } from "./public-url";

export class StorageApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "StorageApiError";
  }
}

function toStorageError(err: unknown): StorageError {
  if (err instanceof StorageApiError) return { message: err.message, statusCode: String(err.statusCode) };
  if (err instanceof InvalidObjectPathError) return { message: err.message, statusCode: "400" };
  const e = err as { code?: string; message?: string };
  if (e.code === "42501") {
    return { message: "new row violates row-level security policy", statusCode: "403" };
  }
  console.error("[storage] unexpected error:", err);
  return { message: "Storage operation failed", statusCode: "500" };
}

export function normalizeMime(value: string | null | undefined): string {
  const base = (value ?? "").split(";")[0].trim().toLowerCase();
  return base.includes("/") ? base : "application/octet-stream";
}

function mimeAllowed(mime: string, allowed: string[] | null): boolean {
  if (!allowed || allowed.length === 0) return true;
  return allowed.some((a) => {
    const rule = a.toLowerCase();
    return rule.endsWith("/*") ? mime.startsWith(rule.slice(0, -1)) : rule === mime;
  });
}

/** Cheap magic-byte check so a mislabelled file can't pose as an image. */
export function sniffMatches(mime: string, bytes: Buffer): boolean {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  switch (mime) {
    case "image/png":
      return starts([0x89, 0x50, 0x4e, 0x47]);
    case "image/jpeg":
    case "image/jpg":
      return starts([0xff, 0xd8, 0xff]);
    case "image/gif":
      return starts([0x47, 0x49, 0x46, 0x38]);
    case "image/webp":
      return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
    default:
      return true;
  }
}

async function loadBucket(db: Db, bucket: string) {
  const row = await db
    .selectFrom("storage.buckets")
    .select(["id", "public", "file_size_limit", "allowed_mime_types"])
    .where("id", "=", bucket)
    .executeTakeFirst();
  if (!row) throw new StorageApiError("Bucket not found", 404);
  return row;
}

async function toBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== "undefined" && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new StorageApiError("Unsupported upload body", 400);
}

export interface UploadInput {
  bucket: string;
  path: string;
  body: Buffer;
  contentType?: string;
  cacheControl?: string;
  upsert?: boolean;
}

/** Upload as `role`/`userId`. Throws StorageApiError / pg errors. */
export async function uploadObject(role: DbRole, userId: string | null, input: UploadInput): Promise<string> {
  assertValidBucket(input.bucket);
  assertValidObjectPath(input.path);
  const mime = normalizeMime(input.contentType);
  const driver = await getDriver();

  await withRole(role, userId, async (db) => {
    // Bucket limits are read as the caller too; storage.buckets is
    // readable by every role (000_supabase_compat).
    const bucket = await loadBucket(db, input.bucket);
    const limit = bucket.file_size_limit ? Number(bucket.file_size_limit) : null;
    if (limit !== null && input.body.length > limit) {
      throw new StorageApiError("The object exceeded the maximum allowed size", 413);
    }
    if (!mimeAllowed(mime, bucket.allowed_mime_types)) {
      throw new StorageApiError(`mime type ${mime} is not supported`, 415);
    }
    if (!sniffMatches(mime, input.body)) {
      throw new StorageApiError(`file content does not match ${mime}`, 415);
    }

    const metadata = {
      mimetype: mime,
      size: input.body.length,
      cacheControl: input.cacheControl ? `max-age=${input.cacheControl}` : "max-age=3600",
    };
    const inserted = await db
      .insertInto("storage.objects")
      .values({ bucket_id: input.bucket, name: input.path, owner: userId, metadata: JSON.stringify(metadata) })
      .onConflict((oc) =>
        input.upsert
          ? oc.columns(["bucket_id", "name"]).doUpdateSet({
              metadata: (eb) => eb.ref("excluded.metadata"),
              owner: (eb) => eb.ref("excluded.owner"),
              updated_at: sql<string>`now()`,
            })
          : oc.columns(["bucket_id", "name"]).doNothing(),
      )
      .returning("id")
      .executeTakeFirst();
    if (!inserted) throw new StorageApiError("The resource already exists", 409);

    // Write the bytes while the row is still uncommitted: if the write
    // fails the metadata rolls back with it.
    await driver.put(input.bucket, input.path, input.body, {
      contentType: mime,
      cacheControl: metadata.cacheControl,
    });
  });

  return input.path;
}

/** Remove as `role`/`userId`; returns the names actually removed (RLS-visible). */
export async function removeObjects(
  role: DbRole,
  userId: string | null,
  bucket: string,
  paths: string[],
): Promise<string[]> {
  assertValidBucket(bucket);
  paths.forEach(assertValidObjectPath);
  if (paths.length === 0) return [];
  const removed = await withRole(role, userId, async (db) => {
    const rows = await db
      .deleteFrom("storage.objects")
      .where("bucket_id", "=", bucket)
      .where("name", "in", paths)
      .returning("name")
      .execute();
    return rows.map((x) => x.name);
  });
  if (removed.length > 0) {
    const driver = await getDriver();
    await driver.delete(bucket, removed).catch((err) => {
      console.warn("[storage] metadata removed but file delete failed:", err);
    });
  }
  return removed;
}

/** Object metadata for the public read route (service role). */
export async function getPublicObjectMeta(
  bucket: string,
  path: string,
): Promise<{ mimetype: string; size: number; updatedAt: string; cacheControl: string } | null> {
  assertValidBucket(bucket);
  assertValidObjectPath(path);
  return withRole("service_role", null, async (db) => {
    const row = await db
      .selectFrom("storage.objects as o")
      .innerJoin("storage.buckets as b", "b.id", "o.bucket_id")
      .select(["o.metadata", "o.updated_at"])
      .where("o.bucket_id", "=", bucket)
      .where("o.name", "=", path)
      .where("b.public", "=", true)
      .executeTakeFirst();
    if (!row) return null;
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    return {
      mimetype: String(metadata.mimetype ?? "application/octet-stream"),
      size: Number(metadata.size ?? 0),
      updatedAt: row.updated_at,
      cacheControl: String(metadata.cacheControl ?? "max-age=3600"),
    };
  });
}

function storageFor(role: DbRole, userId: string | null): StorageApi {
  return {
    from(bucket: string): StorageBucketApi {
      return {
        async upload(path, body, opts = {}) {
          try {
            const buf = await toBuffer(body);
            const contentType =
              opts.contentType ?? (typeof Blob !== "undefined" && body instanceof Blob ? body.type : undefined);
            await uploadObject(role, userId, {
              bucket,
              path,
              body: buf,
              contentType,
              cacheControl: opts.cacheControl,
              upsert: opts.upsert,
            });
            return { data: { path, fullPath: `${bucket}/${path}` }, error: null };
          } catch (err) {
            return { data: null, error: toStorageError(err) };
          }
        },
        getPublicUrl(path) {
          return { data: { publicUrl: publicObjectUrl(bucket, path) } };
        },
        async remove(paths) {
          try {
            const removed = await removeObjects(role, userId, bucket, paths);
            return { data: removed.map((name) => ({ name })), error: null };
          } catch (err) {
            return { data: null, error: toStorageError(err) };
          }
        },
      };
    },
  };
}

/** Storage as the signed-in user (RLS applies). */
export function userStorage(userId: string | null): StorageApi {
  return storageFor(userId ? "authenticated" : "anon", userId);
}

/** Storage as the service role (RLS bypassed; bucket limits still apply). */
export function adminStorage(): StorageApi {
  return storageFor("service_role", null);
}

export { toStorageError };
