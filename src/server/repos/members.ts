// Account members (profiles of an account) + the SECURITY DEFINER
// membership RPCs from migration 018. The RPCs do the real
// authorisation (caller admin+/owner, same account, not self, not the
// owner) and signal refusals with SQLSTATEs — see `membershipRpcError`.

import { sql, type Db } from "@/server/db";
import { isInvalidParameter, isPermissionDenied, pgMessage } from "@/server/db/errors";
import type { AccountRoleEnum } from "@/server/db/schema.gen";

/** Every profile of the account, oldest member first. */
export function listMembers(db: Db, accountId: string) {
  return db
    .selectFrom("profiles")
    .select(["user_id", "full_name", "email", "avatar_url", "account_role", "created_at"])
    .where("account_id", "=", accountId)
    .orderBy("created_at", "asc")
    .execute();
}

export async function isMemberOfAccount(db: Db, accountId: string, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom("profiles")
    .select("user_id")
    .where("user_id", "=", userId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return !!row;
}

export async function setMemberRole(db: Db, userId: string, role: AccountRoleEnum): Promise<void> {
  await sql`SELECT public.set_member_role(${userId}::uuid, ${role}::public.account_role_enum)`.execute(db);
}

/** Moves the member out into a fresh personal account; returns its id. */
export async function removeAccountMember(db: Db, userId: string): Promise<string | null> {
  const r = await sql<{ result: string | null }>`SELECT public.remove_account_member(${userId}::uuid) AS result`.execute(db);
  return r.rows[0]?.result ?? null;
}

export async function transferAccountOwnership(db: Db, newOwnerUserId: string): Promise<void> {
  await sql`SELECT public.transfer_account_ownership(${newOwnerUserId}::uuid)`.execute(db);
}

/**
 * Map a refusal raised by the membership RPCs onto an HTTP status:
 * 42501 → 403 (not allowed), 22023 → 400 (invalid target / input).
 * The message is the RAISE text from the migration. Returns null for
 * anything else (the caller answers 500).
 */
export function membershipRpcError(err: unknown): { status: number; message: string } | null {
  if (isPermissionDenied(err)) return { status: 403, message: pgMessage(err) };
  if (isInvalidParameter(err)) return { status: 400, message: pgMessage(err) };
  return null;
}
