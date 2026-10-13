// ============================================================
// /api/account/members/[userId]
//
//   PATCH  — change a member's role.   Admin+.
//   DELETE — remove a member.          Admin+.
//
// Both delegate to SECURITY DEFINER RPCs from migration 018:
//   - set_member_role(p_user_id, p_new_role)
//   - remove_account_member(p_user_id)
//
// The RPCs do the *real* authorisation work — caller must be
// admin+, target must be in caller's account, target can't be the
// owner, can't be self. The TS layer here only forwards the call
// and maps Postgres SQLSTATEs back to HTTP statuses.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole } from "@/lib/auth/roles";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { getT } from "@/lib/i18n/translate";
import { asUser } from "@/server/db";
import {
  membershipRpcError,
  removeAccountMember,
  setMemberRole,
} from "@/server/repos/members";

const t = getT("Api");

// Map known SQLSTATEs from the RPCs (see migration 018) onto HTTP
// statuses: 42501 → 403, 22023 → 400, with the human-readable RAISE
// message from the migration. Anything else is a 500.
function rpcErrorToResponse(err: unknown): NextResponse {
  const known = membershipRpcError(err);
  if (known) {
    return NextResponse.json({ error: known.message }, { status: known.status });
  }
  console.error("[members route] unexpected RPC error:", err);
  return NextResponse.json(
    { error: t('account.members.updateFailed') },
    { status: 500 },
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRole:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as
      | { role?: unknown }
      | null;
    const role = body?.role;

    if (!isAccountRole(role)) {
      return NextResponse.json(
        { error: t('account.members.roleInvalid') },
        { status: 400 },
      );
    }

    // The RPC blocks promotion to / demotion from owner, but
    // surface the friendlier 400 before crossing the wire too.
    if (role === "owner") {
      return NextResponse.json(
        {
          error:
            t('account.members.useTransferOwnership'),
        },
        { status: 400 },
      );
    }

    try {
      await asUser(ctx.userId, (db) => setMemberRole(db, userId, role));
    } catch (error) {
      return rpcErrorToResponse(error);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    let newPersonalAccountId: string | null;
    try {
      newPersonalAccountId = await asUser(ctx.userId, (db) => removeAccountMember(db, userId));
    } catch (error) {
      return rpcErrorToResponse(error);
    }

    return NextResponse.json({ ok: true, newPersonalAccountId });
  } catch (err) {
    return toErrorResponse(err);
  }
}
