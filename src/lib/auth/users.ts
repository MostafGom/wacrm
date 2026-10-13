// Mapping between auth.users rows and the public `User` shape that
// components and routes see (Supabase-compatible field names).

import type { Selectable } from "kysely";

import type { User } from "@/lib/auth/types";
import type { DB } from "@/server/db/schema.gen";

export type AuthUserRow = Selectable<DB["auth.users"]>;

/** Columns selected for an AuthUserRow (everything except nothing — kept explicit). */
export const USER_COLUMNS = [
  "id",
  "email",
  "encrypted_password",
  "email_confirmed_at",
  "raw_user_meta_data",
  "raw_app_meta_data",
  "created_at",
  "updated_at",
  "last_sign_in_at",
  "banned_until",
  "deleted_at",
] as const;

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function toUser(row: Pick<AuthUserRow, "id" | "email" | "email_confirmed_at" | "raw_user_meta_data" | "raw_app_meta_data" | "created_at" | "last_sign_in_at">): User {
  return {
    id: row.id,
    email: row.email,
    user_metadata: asObject(row.raw_user_meta_data),
    app_metadata: asObject(row.raw_app_meta_data),
    email_confirmed_at: row.email_confirmed_at,
    created_at: row.created_at,
    last_sign_in_at: row.last_sign_in_at,
  };
}

export function isBlocked(row: Pick<AuthUserRow, "deleted_at" | "banned_until">): boolean {
  if (row.deleted_at) return true;
  return row.banned_until != null && new Date(row.banned_until).getTime() > Date.now();
}

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 320 ? e : null;
}
