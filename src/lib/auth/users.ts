// Mapping between auth.users rows and the public `User` shape that
// components and routes see (Supabase-compatible field names).

import type { User } from "@/lib/db/types";

export interface AuthUserRow {
  id: string;
  email: string | null;
  encrypted_password?: string | null;
  email_confirmed_at: Date | string | null;
  raw_user_meta_data: Record<string, unknown> | null;
  raw_app_meta_data: Record<string, unknown> | null;
  created_at: Date | string;
  last_sign_in_at: Date | string | null;
  banned_until?: Date | string | null;
  deleted_at?: Date | string | null;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

export function toUser(row: AuthUserRow): User {
  return {
    id: row.id,
    email: row.email,
    user_metadata: row.raw_user_meta_data ?? {},
    app_metadata: row.raw_app_meta_data ?? {},
    email_confirmed_at: iso(row.email_confirmed_at),
    created_at: iso(row.created_at) ?? new Date(0).toISOString(),
    last_sign_in_at: iso(row.last_sign_in_at),
  };
}

export const USER_COLUMNS =
  "u.id, u.email, u.encrypted_password, u.email_confirmed_at, u.raw_user_meta_data, u.raw_app_meta_data, u.created_at, u.last_sign_in_at, u.banned_until, u.deleted_at";

export function isBlocked(row: AuthUserRow): boolean {
  if (row.deleted_at) return true;
  return row.banned_until != null && new Date(row.banned_until).getTime() > Date.now();
}

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 320 ? e : null;
}
