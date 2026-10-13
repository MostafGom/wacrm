// ============================================================
// POST /api/invitations/[token]/redeem
//
// Authenticated. Caller atomically moves from their personal
// account (created at signup) to the inviter's account with the
// invite's role. Heavy lifting lives in the SECURITY DEFINER
// `redeem_invitation` RPC from migration 019.
//
// Refusal contract (from the RPC)
//   - SQLSTATE 42501 → 401 (caller not authenticated)
//   - SQLSTATE 22023 → 400 (invitation not_found / used / expired)
//   - SQLSTATE 23505 → 409 (caller's account already has data /
//     they're already in this or another shared account)
//
// Rate limit (per IP) is the same shape as peek but tighter —
// a successful redeem changes data, and the RPC's data-loss
// guard makes brute-force retries pointless past a few attempts.
// ============================================================

import { NextResponse } from "next/server";

import { hashInviteToken } from "@/lib/auth/invitations";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { getServerSession } from "@/lib/auth/server-session";
import { getT } from "@/lib/i18n/translate";
import { asUser } from "@/server/db";
import { isInvalidParameter, isPermissionDenied, isUniqueViolation, pgMessage } from "@/server/db/errors";
import { redeemInvitation } from "@/server/repos/invitations";

const t = getT("Api");

function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

function rpcErrorToResponse(err: unknown): NextResponse {
  if (isPermissionDenied(err)) {
    return NextResponse.json({ error: pgMessage(err) }, { status: 401 });
  }
  if (isInvalidParameter(err)) {
    return NextResponse.json({ error: pgMessage(err) }, { status: 400 });
  }
  if (isUniqueViolation(err)) {
    return NextResponse.json({ error: pgMessage(err) }, { status: 409 });
  }
  console.error("[redeem] unexpected RPC error:", err);
  return NextResponse.json(
    { error: t('invitations.redeemFailed') },
    { status: 500 },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`redeem:${ip}`, RATE_LIMITS.invitationRedeem);
  if (!limit.success) return rateLimitResponse(limit);

  const { token } = await params;
  if (!token || typeof token !== "string") {
    return NextResponse.json(
      { error: t('invitations.missingToken') },
      { status: 400 },
    );
  }

  // The RPC checks `auth.uid()` itself, but failing fast here
  // gives a cleaner 401 without a database round trip on the
  // common "user clicked the link before logging in" path.
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: t('common.unauthorized') }, { status: 401 });
  }

  let accountId: string | null;
  try {
    accountId = await asUser(session.user.id, (db) => redeemInvitation(db, hashInviteToken(token)));
  } catch (error) {
    return rpcErrorToResponse(error);
  }

  return NextResponse.json({ ok: true, accountId });
}
