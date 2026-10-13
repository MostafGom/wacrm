// Local-disk storage driver: <STORAGE_DIR>/<bucket>/<path>.
// Writes are atomic (temp file + rename), reads support byte ranges.

import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertValidBucket,
  assertValidObjectPath,
  InvalidObjectPathError,
  type ByteRange,
  type ObjectBody,
  type StorageDriver,
} from "./driver";

export function createLocalDriver(root = process.env.STORAGE_DIR ?? path.resolve(process.cwd(), ".data/storage")): StorageDriver {
  const base = path.resolve(root);

  function resolve(bucket: string, key: string): string {
    assertValidBucket(bucket);
    const segs = assertValidObjectPath(key);
    const full = path.resolve(base, bucket, ...segs);
    // Belt and braces on top of the segment regex.
    if (!full.startsWith(base + path.sep)) throw new InvalidObjectPathError(key);
    return full;
  }

  return {
    name: "local",

    async put(bucket, key, body) {
      const file = resolve(bucket, key);
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
      try {
        await writeFile(tmp, body, { flush: true });
        await rename(tmp, file);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    },

    async get(bucket, key, range?: ByteRange): Promise<ObjectBody | null> {
      const file = resolve(bucket, key);
      let st;
      try {
        st = await stat(file);
      } catch {
        return null;
      }
      if (!st.isFile()) return null;
      if (range) {
        const end = Math.min(range.end, st.size - 1);
        return {
          stream: createReadStream(file, { start: range.start, end }),
          size: end - range.start + 1,
          totalSize: st.size,
        };
      }
      return { stream: createReadStream(file), size: st.size, totalSize: st.size };
    },

    async delete(bucket, keys) {
      await Promise.all(keys.map((k) => rm(resolve(bucket, k), { force: true })));
    },
  };
}
