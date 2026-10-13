// ============================================================
// Server-side account context — for API routes and server
// components. Reads the caller's profile + account in one round
// trip and verifies role on demand.
//
// IMPORTANT: this module is server-only. It reads `next/headers`
// cookies and the database. Importing it from a client component
// fails at build time — that's the boundary check; we don't need the
// `server-only` package.
//
// Calling convention
// ------------------
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.userId / ctx.accountId / ctx.role / ctx.account
//     const rows = await asUser(ctx.userId, (db) => repo.list(db, ctx.accountId));
//   } catch (err) {
//     return toErrorResponse(err);
//   }
//
// `asUser` (src/server/db) runs the query as `authenticated` with
// auth.uid() = ctx.userId, so RLS backs up the explicit account filter.
// ============================================================

import { NextResponse } from "next/server";

import { asUser } from "@/server/db";
import { getAccountSummary, getProfileByUserId } from "@/server/repos/profiles";
import { getServerSession } from "./server-session";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";
import { getT } from "@/lib/i18n/translate";
import { pgCode } from "@/server/db/errors";

const t = getT("LibErrors.auth");
const tApi = getT("Api.common");

// ------------------------------------------------------------
// Errors
//
// Custom classes so API routes can map a single `catch` to the
// right HTTP status without sprinkling 401/403 strings everywhere.
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = t("unauthorized")) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * A deliberate non-2xx answer from a route / service (404 not found,
 * 409 conflict, 400 validation...). `message` is shown to the user, so
 * pass a translated string.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = t("forbidden")) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Routes can do:
 *
 *   } catch (err) {
 *     return toErrorResponse(err);
 *   }
 *
 * Unknown errors collapse to 500 with the generic message — we
 * never leak `err.message` for non-classified errors to keep
 * server internals out of the wire.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, { status: err.status });
  }
  // Malformed id in a path / body (e.g. "abc" for a uuid column): the
  // caller's fault, not a server error.
  if (pgCode(err) === "22P02") {
    return NextResponse.json({ error: tApi("invalidRequestBody") }, { status: 400 });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: t("internal") }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** `auth.uid()` for the caller. Always defined when this resolves. */
  userId: string;
  /** Caller's account_id from their profile row. */
  accountId: string;
  /** Caller's role within their account. */
  role: AccountRole;
  /** Lightweight account meta — id + name. */
  account: { id: string; name: string };
}

/**
 * Resolve the caller's user + account + role in one round trip.
 *
 * Throws `UnauthorizedError` if there's no session.
 * Throws `ForbiddenError` if the profile is missing account
 * fields (shouldn't happen post-017 migration; defensive guard
 * against profile rows that pre-date the backfill or were
 * inserted by hand).
 *
 * Use `requireRole(min)` instead when the route also needs a
 * minimum-role check — it's a thin wrapper over this.
 */
export async function getCurrentAccount(): Promise<AccountContext> {
  const session = await getServerSession();
  if (!session) {
    throw new UnauthorizedError();
  }
  const userId = session.user.id;

  let loaded;
  try {
    loaded = await asUser(userId, async (db) => {
      const profile = await getProfileByUserId(db, userId);
      const account = profile?.account_id ? await getAccountSummary(db, profile.account_id) : null;
      return { profile, account };
    });
  } catch (error) {
    console.error("[getCurrentAccount] profile fetch error:", error);
    throw new ForbiddenError(t("loadContext"));
  }

  const { profile, account } = loaded;
  if (!profile || !profile.account_id || !profile.account_role) {
    // Pre-migration profile, or a manual insert that skipped the
    // signup trigger. The user is authenticated but the app has
    // no way to scope their queries — treat as forbidden.
    throw new ForbiddenError(t("notLinked"));
  }
  if (!isAccountRole(profile.account_role)) {
    // The DB enum should make this impossible, but a future
    // migration that broadens the enum without updating TS would
    // hit this — surface it rather than silently widening.
    throw new ForbiddenError(`Unknown account role: ${profile.account_role}`);
  }
  if (!account) {
    // account_id points at no readable account row — orphaned profile
    // or an RLS gap. Same "can't scope this user" outcome as above.
    throw new ForbiddenError(t("notLinked"));
  }

  return {
    userId,
    accountId: profile.account_id,
    role: profile.account_role,
    account: { id: account.id, name: account.name },
  };
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("Insufficient role")`
 * when the caller is below `min`.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      t("requiresRole", { min: t(`roleNames.${min}`) }),
    );
  }
  return ctx;
}
