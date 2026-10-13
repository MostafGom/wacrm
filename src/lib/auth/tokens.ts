// One-time tokens for emailed / admin-generated links:
//   signup_confirm  confirm an email address after signup (SMTP only)
//   recovery        password reset
//   email_change    confirm a new email address (SMTP only)
//
// Single-use, hashed at rest, short-lived.

import { asService, sql } from "@/server/db";
import { hashToken, newToken } from "./session";

export type OneTimeTokenType = "signup_confirm" | "recovery" | "email_change";

const TTL_MS: Record<OneTimeTokenType, number> = {
  signup_confirm: 24 * 60 * 60 * 1000,
  recovery: 60 * 60 * 1000,
  email_change: 24 * 60 * 60 * 1000,
};

export async function issueToken(userId: string, type: OneTimeTokenType, newEmail?: string): Promise<string> {
  const token = newToken();
  await asService(async (db) => {
    // Only the newest link of a kind is valid.
    await db.deleteFrom("auth.one_time_tokens").where("user_id", "=", userId).where("type", "=", type).execute();
    await db
      .insertInto("auth.one_time_tokens")
      .values({
        user_id: userId,
        type,
        token_hash: hashToken(token),
        new_email: newEmail ?? null,
        expires_at: new Date(Date.now() + TTL_MS[type]).toISOString(),
      })
      .execute();
  });
  return token;
}

/** Atomically consume a token. Returns its user (and new email) or null. */
export async function consumeToken(
  token: string,
  type: OneTimeTokenType,
): Promise<{ userId: string; newEmail: string | null } | null> {
  if (!token || token.length > 128) return null;
  const row = await asService((db) =>
    db
      .updateTable("auth.one_time_tokens")
      .set({ consumed_at: sql<string>`now()` })
      .where("token_hash", "=", hashToken(token))
      .where("type", "=", type)
      .where("consumed_at", "is", null)
      .where("expires_at", ">", sql<string>`now()`)
      .returning(["user_id", "new_email"])
      .executeTakeFirst(),
  );
  return row ? { userId: row.user_id, newEmail: row.new_email } : null;
}
