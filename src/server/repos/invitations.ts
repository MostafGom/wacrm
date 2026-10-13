// Account invitations (invite links) + the SECURITY DEFINER
// peek / redeem RPCs from migration 019.

import { sql, type Db } from "@/server/db";
import type { AccountRoleEnum } from "@/server/db/schema.gen";

/** Outstanding invites: not redeemed and not expired, newest first. */
export function listPendingInvitations(db: Db, accountId: string, now: string = new Date().toISOString()) {
  return db
    .selectFrom("account_invitations")
    .select([
      "id",
      "role",
      "label",
      "created_by_user_id",
      "created_at",
      "expires_at",
      "accepted_at",
      "accepted_by_user_id",
    ])
    .where("account_id", "=", accountId)
    .where("accepted_at", "is", null)
    .where("expires_at", ">", now)
    .orderBy("created_at", "desc")
    .execute();
}

export function createInvitation(
  db: Db,
  values: {
    account_id: string;
    token_hash: string;
    role: AccountRoleEnum;
    created_by_user_id: string;
    label: string | null;
    expires_at: string;
  },
) {
  return db
    .insertInto("account_invitations")
    .values(values)
    .returning(["id", "role", "label", "expires_at", "created_at"])
    .executeTakeFirstOrThrow();
}

/** Hard-delete (revoke) an invite of the account. False when nothing matched. */
export async function deleteInvitation(db: Db, accountId: string, id: string): Promise<boolean> {
  const r = await db
    .deleteFrom("account_invitations")
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

/**
 * `peek_invitation(token_hash)` — granted to anon. Always returns a
 * JSON object: `{ ok: true, ... }` or `{ ok: false, reason }`.
 */
export async function peekInvitation(db: Db, tokenHash: string): Promise<unknown> {
  const r = await sql<{ result: unknown }>`SELECT public.peek_invitation(${tokenHash}) AS result`.execute(db);
  return r.rows[0]?.result ?? null;
}

/**
 * `redeem_invitation(token_hash)` as the signed-in caller. Returns the
 * joined account id. Raises 42501 / 22023 / 23505 (mapped by the route).
 */
export async function redeemInvitation(db: Db, tokenHash: string): Promise<string | null> {
  const r = await sql<{ result: string | null }>`SELECT public.redeem_invitation(${tokenHash}) AS result`.execute(db);
  return r.rows[0]?.result ?? null;
}
