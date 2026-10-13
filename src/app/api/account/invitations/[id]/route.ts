// ============================================================
// DELETE /api/account/invitations/[id]
//
// Admin+. Revokes a pending invitation by id. The delete is scoped
// to the caller's account explicitly, and RLS on
// `account_invitations` restricts it to admins of the inviting
// account as a second line of defense.
//
// We intentionally delete the row outright rather than soft-
// deleting (a "revoked_at" flag). Once revoked, an invite is
// dead forever — there's no UX where a former invite should be
// listed; the plaintext token is gone too. Hard delete keeps
// the table small.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { getT } from "@/lib/i18n/translate";
import { asUser } from "@/server/db";
import { deleteInvitation } from "@/server/repos/invitations";

const t = getT("Api");

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:inviteRevoke:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // Scoped by account_id (and by RLS): a cross-account attempt is
    // a silent 0-row delete, which is exactly what we want for a
    // revocation endpoint.
    let deleted: boolean;
    try {
      deleted = await asUser(ctx.userId, (db) => deleteInvitation(db, ctx.accountId, id));
    } catch (error) {
      console.error("[DELETE /api/account/invitations/[id]] error:", error);
      return NextResponse.json(
        { error: t('account.invitations.revokeFailed') },
        { status: 500 },
      );
    }

    if (!deleted) {
      // Either the id doesn't exist or RLS hid it (different
      // account). 404 either way — surfacing "exists but not
      // yours" would leak existence.
      return NextResponse.json(
        { error: t('account.invitations.notFound') },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
