// S3-compatible storage driver (AWS S3, MinIO, Cloudflare R2, ...).
// All app buckets map to key prefixes inside ONE S3 bucket:
//   s3://<S3_BUCKET>/<bucket>/<path>
//
// Env: S3_BUCKET, S3_REGION (default us-east-1), S3_ENDPOINT,
//      S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE=true
//
// `@aws-sdk/client-s3` is an optional dependency, loaded only when
// STORAGE_DRIVER=s3.

import type { Readable } from "node:stream";

import { assertValidBucket, assertValidObjectPath, type StorageDriver } from "./driver";

export async function createS3Driver(): Promise<StorageDriver> {
  const s3 = await import("@aws-sdk/client-s3");
  const bucketName = process.env.S3_BUCKET;
  if (!bucketName) throw new Error("S3_BUCKET is not set");

  const client = new s3.S3Client({
    region: process.env.S3_REGION ?? "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
  });

  const keyOf = (bucket: string, key: string) => {
    assertValidBucket(bucket);
    assertValidObjectPath(key);
    return `${bucket}/${key}`;
  };

  return {
    name: "s3",

    async put(bucket, key, body, meta) {
      await client.send(
        new s3.PutObjectCommand({
          Bucket: bucketName,
          Key: keyOf(bucket, key),
          Body: body,
          ContentType: meta.contentType,
          CacheControl: meta.cacheControl,
        }),
      );
    },

    async get(bucket, key, range) {
      try {
        const res = await client.send(
          new s3.GetObjectCommand({
            Bucket: bucketName,
            Key: keyOf(bucket, key),
            Range: range ? `bytes=${range.start}-${range.end}` : undefined,
          }),
        );
        const size = Number(res.ContentLength ?? 0);
        const total = res.ContentRange ? Number(res.ContentRange.split("/")[1]) : size;
        return { stream: res.Body as Readable, size, totalSize: total };
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === "NoSuchKey" || name === "NotFound") return null;
        throw err;
      }
    },

    async delete(bucket, keys) {
      if (keys.length === 0) return;
      await client.send(
        new s3.DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: { Objects: keys.map((k) => ({ Key: keyOf(bucket, k) })), Quiet: true },
        }),
      );
    },
  };
}
