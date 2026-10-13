// ============================================================
// Server sessions.
//
// The browser holds an opaque random token in the HttpOnly
// `wacrm_session` cookie; auth.sessions stores only its SHA-256. A
// session is valid while unexpired and its user is neither banned nor
// deleted. Expiry slides forward on use (at most once per
// SESSION_TOUCH_MS, so a busy user doesn't write on every request).
//
// Server-only.
// ============================================================

import { createHash, randomBytes } from "node:crypto";

import { asService, sql } from "@/server/db";
import type { User } from "./types";
import { isBlocked, toUser } from "./users";

export const SESSION_COOKIE = "wacrm_session";

const TTL_DAYS = () => Number(process.env.SESSION_TTL_DAYS ?? 30);
const SESSION_TOUCH_MS = 10 * 60 * 1000;
const CACHE_TTL_MS = 30 * 1000;
const CACHE_MAX = 1000;

export interface ValidSession {
  sessionId: string;
  user: User;
  expiresAt: Date;
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionExpiry(): Date {
  return new Date(Date.now() + TTL_DAYS() * 24 * 60 * 60 * 1000);
}

// ---- small in-process cache (per instance) -----------------------
const cache = new Map<string, { value: ValidSession; at: number }>();

function cacheGet(key: string): ValidSession | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key: string, value: ValidSession): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, at: Date.now() });
}

function cacheDropUser(userId: string): void {
  for (const [k, v] of cache) if (v.value.user.id === userId) cache.delete(k);
}

function isIp(v: string | null | undefined): v is string {
  return !!v && (/^[0-9.]+$/.test(v) || /^[0-9a-fA-F:]+$/.test(v));
}

// ---- API ------------------------------------------------------------

export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = sessionExpiry();
  await asService(async (db) => {
    await db
      .insertInto("auth.sessions")
      .values({
        user_id: userId,
        token_hash: hashToken(token),
        user_agent: meta.userAgent?.slice(0, 512) ?? null,
        ip: isIp(meta.ip) ? meta.ip : null,
        expires_at: expiresAt.toISOString(),
      })
      .execute();
    await db.updateTable("auth.users").set({ last_sign_in_at: sql<string>`now()` }).where("id", "=", userId).execute();
  });
  return { token, expiresAt };
}

/** Validate a cookie token. Returns null when missing/expired/revoked. */
export async function validateSession(token: string | undefined | null): Promise<ValidSession | null> {
  if (!token || token.length > 128) return null;
  const key = hashToken(token).toString("hex");
  const cached = cacheGet(key);
  if (cached && cached.expiresAt.getTime() > Date.now()) return cached;

  const result = await asService(async (db) => {
    const row = await db
      .selectFrom("auth.sessions as s")
      .innerJoin("auth.users as u", "u.id", "s.user_id")
      .select([
        "s.id as session_id",
        "s.expires_at",
        "s.last_seen_at",
        "u.id",
        "u.email",
        "u.email_confirmed_at",
        "u.raw_user_meta_data",
        "u.raw_app_meta_data",
        "u.created_at",
        "u.last_sign_in_at",
        "u.banned_until",
        "u.deleted_at",
      ])
      .where("s.token_hash", "=", hashToken(token))
      .where("s.expires_at", ">", sql<string>`now()`)
      .executeTakeFirst();
    if (!row || isBlocked(row)) return null;

    let expiresAt = new Date(row.expires_at);
    if (Date.now() - new Date(row.last_seen_at).getTime() > SESSION_TOUCH_MS) {
      expiresAt = sessionExpiry();
      await db
        .updateTable("auth.sessions")
        .set({ last_seen_at: sql<string>`now()`, expires_at: expiresAt.toISOString() })
        .where("id", "=", row.session_id)
        .execute();
    }
    return { sessionId: row.session_id, user: toUser(row), expiresAt };
  });

  if (result) cacheSet(key, result);
  return result;
}

export async function revokeSessionToken(token: string): Promise<void> {
  cache.delete(hashToken(token).toString("hex"));
  await asService((db) => db.deleteFrom("auth.sessions").where("token_hash", "=", hashToken(token)).execute());
}

/** Sign out everywhere (optionally keeping one session). */
export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> {
  cacheDropUser(userId);
  await asService((db) => {
    let q = db.deleteFrom("auth.sessions").where("user_id", "=", userId);
    if (exceptSessionId) q = q.where("id", "<>", exceptSessionId);
    return q.execute();
  });
}

/** Drop cached entries for a user (after profile/email/password changes). */
export function invalidateUserCache(userId: string): void {
  cacheDropUser(userId);
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "true",
    path: "/",
    expires: expiresAt,
  };
}
