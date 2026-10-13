// One-time tokens for emailed / admin-generated links:
//   signup_confirm  confirm an email address after signup (SMTP only)
//   recovery        password reset
//   email_change    confirm a new email address (SMTP only)
//
// Single-use, hashed at rest, short-lived.

import { withRole } from "@/lib/db/tx";
import { hashToken, newToken } from "./session";

export type OneTimeTokenType = "signup_confirm" | "recovery" | "email_change";

const TTL_MS: Record<OneTimeTokenType, number> = {
  signup_confirm: 24 * 60 * 60 * 1000,
  recovery: 60 * 60 * 1000,
  email_change: 24 * 60 * 60 * 1000,
};

export async function issueToken(
  userId: string,
  type: OneTimeTokenType,
  newEmail?: string,
): Promise<string> {
  const token = newToken();
  await withRole("service_role", null, async (c) => {
    // Only the newest link of a kind is valid.
    await c.query(
      "DELETE FROM auth.one_time_tokens WHERE user_id = $1 AND type = $2",
      [userId, type],
    );
    await c.query(
      `INSERT INTO auth.one_time_tokens (user_id, type, token_hash, new_email, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, hashToken(token), newEmail ?? null, new Date(Date.now() + TTL_MS[type])],
    );
  });
  return token;
}

/** Atomically consume a token. Returns its user (and new email) or null. */
export async function consumeToken(
  token: string,
  type: OneTimeTokenType,
): Promise<{ userId: string; newEmail: string | null } | null> {
  if (!token || token.length > 128) return null;
  return withRole("service_role", null, async (c) => {
    const r = await c.query<{ user_id: string; new_email: string | null }>(
      `UPDATE auth.one_time_tokens
          SET consumed_at = now()
        WHERE token_hash = $1 AND type = $2 AND consumed_at IS NULL AND expires_at > now()
        RETURNING user_id, new_email`,
      [hashToken(token), type],
    );
    const row = r.rows[0];
    return row ? { userId: row.user_id, newEmail: row.new_email } : null;
  });
}
