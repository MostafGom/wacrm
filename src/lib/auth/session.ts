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

import { withRole } from "@/lib/db/tx";
import type { User } from "@/lib/db/types";
import { isBlocked, toUser, USER_COLUMNS, type AuthUserRow } from "./users";

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

// ---- API ------------------------------------------------------------

export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = sessionExpiry();
  const ip = meta.ip && meta.ip !== "unknown" ? meta.ip : null;
  await withRole("service_role", null, async (c) => {
    await c.query(
      `INSERT INTO auth.sessions (user_id, token_hash, user_agent, ip, expires_at)
       VALUES ($1, $2, $3, $4::inet, $5)`,
      [userId, hashToken(token), meta.userAgent?.slice(0, 512) ?? null, isIp(ip) ? ip : null, expiresAt],
    );
    await c.query("UPDATE auth.users SET last_sign_in_at = now() WHERE id = $1", [userId]);
  });
  return { token, expiresAt };
}

function isIp(v: string | null): v is string {
  return !!v && (/^[0-9.]+$/.test(v) || /^[0-9a-fA-F:]+$/.test(v));
}

/** Validate a cookie token. Returns null when missing/expired/revoked. */
export async function validateSession(token: string | undefined | null): Promise<ValidSession | null> {
  if (!token || token.length > 128) return null;
  const key = hashToken(token).toString("hex");
  const cached = cacheGet(key);
  if (cached && cached.expiresAt.getTime() > Date.now()) return cached;

  const result = await withRole("service_role", null, async (c) => {
    const r = await c.query<AuthUserRow & { session_id: string; expires_at: Date; last_seen_at: Date }>(
      `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, ${USER_COLUMNS}
         FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)],
    );
    const row = r.rows[0];
    if (!row || isBlocked(row)) return null;

    let expiresAt = row.expires_at;
    if (Date.now() - row.last_seen_at.getTime() > SESSION_TOUCH_MS) {
      expiresAt = sessionExpiry();
      await c.query("UPDATE auth.sessions SET last_seen_at = now(), expires_at = $2 WHERE id = $1", [
        row.session_id,
        expiresAt,
      ]);
    }
    return { sessionId: row.session_id, user: toUser(row), expiresAt };
  });

  if (result) cacheSet(key, result);
  return result;
}

export async function revokeSessionToken(token: string): Promise<void> {
  cache.delete(hashToken(token).toString("hex"));
  await withRole("service_role", null, (c) =>
    c.query("DELETE FROM auth.sessions WHERE token_hash = $1", [hashToken(token)]),
  );
}

/** Sign out everywhere (optionally keeping one session). */
export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> {
  cacheDropUser(userId);
  await withRole("service_role", null, (c) =>
    exceptSessionId
      ? c.query("DELETE FROM auth.sessions WHERE user_id = $1 AND id <> $2", [userId, exceptSessionId])
      : c.query("DELETE FROM auth.sessions WHERE user_id = $1", [userId]),
  );
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
