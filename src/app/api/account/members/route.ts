// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import type { AccountMember } from "@/types";
import { getT } from "@/lib/i18n/translate";
import { asUser } from "@/server/db";
import { listMembers } from "@/server/repos/members";

const t = getT("Api");

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // Explicitly account-scoped; RLS on profiles (rows of the
    // caller's account only) backs it up.
    let data;
    try {
      data = await asUser(ctx.userId, (db) => listMembers(db, ctx.accountId));
    } catch (error) {
      console.error("[GET /api/account/members] fetch error:", error);
      return NextResponse.json(
        { error: t('account.members.loadFailed') },
        { status: 500 },
      );
    }

    const canSeeEmails = canManageMembers(ctx.role);

    const members: AccountMember[] = data.flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      const role: unknown = row.account_role;
      if (!isAccountRole(role)) return [];
      return [
        {
          user_id: row.user_id,
          full_name: row.full_name ?? "",
          email: canSeeEmails ? row.email : null,
          avatar_url: row.avatar_url,
          role,
          // Column defaults to now(); never null in practice.
          joined_at: row.created_at as string,
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}
