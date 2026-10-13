// ============================================================
// Password hashing.
//
// New hashes: scrypt (node:crypto, no native deps)
//   scrypt$<logN>$<r>$<p>$<salt b64>$<key b64>
//
// Imported Supabase users keep their bcrypt hashes ($2a$/$2b$/$2y$);
// they verify via bcryptjs and are transparently upgraded to scrypt on
// their next successful login (`needsRehash`).
// ============================================================

import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

import bcrypt from "bcryptjs";

const LOG_N = 15;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 6; // matches the UI checks (and Supabase's default)
export const MAX_PASSWORD_LENGTH = 1024;

function scrypt(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, { N: 2 ** LOG_N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${LOG_N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export interface VerifyResult {
  ok: boolean;
  /** Hash uses an older scheme/params and should be replaced. */
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<VerifyResult> {
  if (!stored) {
    await dummyVerify(password);
    return { ok: false, needsRehash: false };
  }
  if (/^\$2[aby]\$/.test(stored)) {
    const ok = await bcrypt.compare(password, stored);
    return { ok, needsRehash: ok };
  }
  const parts = stored.split("$");
  if (parts[0] !== "scrypt" || parts.length !== 6) return { ok: false, needsRehash: false };
  const [, logN, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), {
    N: 2 ** Number(logN),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  const ok = key.length === expected.length && timingSafeEqual(key, expected);
  const stale = Number(logN) !== LOG_N || Number(r) !== R || Number(p) !== P;
  return { ok, needsRehash: ok && stale };
}

let dummyHash: Promise<string> | null = null;

/**
 * Burn the same CPU as a real verify, so "no such user" and "wrong
 * password" are indistinguishable by response time.
 */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(password, await dummyHash);
}

export function validatePasswordStrength(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password should be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return "Password is too long.";
  return null;
}
