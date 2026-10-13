// ============================================================
// /api/account/api-keys
//
//   GET  — list this account's API keys (safe columns only).
//   POST — mint a new key.
//
// These are the *dashboard* endpoints for managing keys, so they
// authenticate the normal way (cookie session) and run as the caller
// (asUser, RLS enforced). Listing is open to any member (viewer+) — the roster
// is not secret; the secret (the key itself) is never in it. Minting
// is admin+ (a key hands out capabilities), enforced by both
// `requireRole('admin')` here and the `api_keys_insert` RLS policy.
//
// IMPORTANT: the plaintext key is returned exactly ONCE, in the POST
// response. We persist only its SHA-256 hash, so neither GET nor any
// future endpoint can resurface it — same one-time-reveal contract
// as invite links. If the admin loses it, they revoke and re-issue.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { generateApiKey } from '@/lib/api-keys/keys';
import { normalizeScopes } from '@/lib/api-keys/scopes';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getT } from '@/lib/i18n/translate';
import { asUser } from '@/server/db';
import { createApiKey, listApiKeys } from '@/server/repos/api-keys';

const t = getT('Api');

const MAX_NAME_LEN = 80;
// Hard ceiling on caller-supplied expiry (1 year), mirroring the
// invite-link clamp. NULL/absent = never expires.
const MAX_EXPIRY_DAYS = 365;

export async function GET() {
  try {
    // Any member can view the roster (RLS allows it); we just need a
    // resolved account context.
    const ctx = await getCurrentAccount();

    // Safe columns only — `key_hash` never leaves the server.
    let keys;
    try {
      keys = await asUser(ctx.userId, (db) => listApiKeys(db, ctx.accountId));
    } catch (error) {
      console.error('[GET /api/account/api-keys] fetch error:', error);
      return NextResponse.json(
        { error: t('account.apiKeys.loadFailed') },
        { status: 500 }
      );
    }

    return NextResponse.json({ keys });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:apiKeyCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      scopes?: unknown;
      expiresInDays?: unknown;
    } | null;

    const rawName = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!rawName) {
      return NextResponse.json(
        { error: t('account.apiKeys.nameRequired') },
        { status: 400 }
      );
    }
    if (rawName.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: t('account.apiKeys.nameTooLong', { max: MAX_NAME_LEN }) },
        { status: 400 }
      );
    }

    // Scopes default to none if omitted — that yields a key that can
    // only call the scope-free endpoints (e.g. GET /api/v1/me).
    const scopes = normalizeScopes(body?.scopes ?? []);
    if (scopes === null) {
      return NextResponse.json(
        { error: t('account.apiKeys.scopesInvalid') },
        { status: 400 }
      );
    }

    let expiresAt: string | null = null;
    const rawExpiry = body?.expiresInDays;
    if (
      typeof rawExpiry === 'number' &&
      Number.isFinite(rawExpiry) &&
      rawExpiry > 0
    ) {
      const days = Math.min(Math.floor(rawExpiry), MAX_EXPIRY_DAYS);
      expiresAt = new Date(
        Date.now() + days * 24 * 60 * 60 * 1000
      ).toISOString();
    }

    const { plaintext, hash, prefix } = generateApiKey();

    let data;
    try {
      data = await asUser(ctx.userId, (db) =>
        createApiKey(db, {
          account_id: ctx.accountId,
          created_by: ctx.userId,
          name: rawName,
          key_prefix: prefix,
          key_hash: hash,
          scopes,
          expires_at: expiresAt,
        })
      );
    } catch (error) {
      console.error('[POST /api/account/api-keys] insert error:', error);
      return NextResponse.json(
        { error: t('account.apiKeys.createFailed') },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        key: data,
        // Plaintext — shown to the admin exactly once.
        plaintext,
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
