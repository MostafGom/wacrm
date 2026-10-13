// ============================================================
// Helpers for /auth/callback — the landing route for every auth link
// the app emails (or an owner generates): email confirmation, password
// reset, email change.
//
// Pure functions, kept out of the route file so they can be unit
// tested without Next request plumbing (vitest runs `environment:
// "node"` with no jsdom — see vitest.config.ts).
// ============================================================

/** Where a link lands when it carries no usable `next`. */
export const DEFAULT_NEXT_PATH = '/dashboard';

/** Where a link that could not be exchanged for a session lands. */
export const LOGIN_PATH = '/login';

/**
 * The `?error=` values /login knows how to explain. Anything else
 * emitted here must get a message in `LoginPage`.
 */
export type CallbackFailure =
  /** The link was valid once but has expired or was already used. */
  | 'link_expired'
  /** No `token` at all, or a bad `type`. */
  | 'link_invalid';

const MAX_NEXT_LENGTH = 2048;

/**
 * Coerce the `next` query parameter into a same-origin absolute path.
 *
 * `next` is query-string input. Without this, `?next=//evil.example`
 * (or `/\evil.example`, which browsers treat the same) would turn the
 * callback into an open redirect the moment a session is minted.
 * Rules: must start with a single `/`, the second character may not be
 * `/` or `\`, and no control characters (a CR/LF would split the
 * Location header). Anything else falls back to `fallback`.
 */
export function safeNextPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_NEXT_PATH,
): string {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_NEXT_LENGTH) return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.length > 1 && (value[1] === '/' || value[1] === '\\')) {
    return fallback;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return fallback;
  }
  return value;
}

/** Link types /auth/callback accepts (see `auth.one_time_tokens`). */
export type EmailLinkType = 'signup_confirm' | 'recovery' | 'email_change';

const EMAIL_LINK_TYPES: ReadonlySet<string> = new Set<EmailLinkType>([
  'signup_confirm',
  'recovery',
  'email_change',
]);

export function isEmailLinkType(value: string | null): value is EmailLinkType {
  return value !== null && EMAIL_LINK_TYPES.has(value);
}

export interface EmailLink {
  type: EmailLinkType;
  token: string;
}

/**
 * Extract the credential from an emailed / admin-generated link:
 * `/auth/callback?type=<type>&token=<token>&next=<path>`.
 */
export function parseEmailLink(params: URLSearchParams): EmailLink | null {
  const token = params.get('token')?.trim();
  const type = params.get('type');
  if (token && isEmailLinkType(type)) return { type, token };
  return null;
}

export function loginFailurePath(reason: CallbackFailure): string {
  return `${LOGIN_PATH}?error=${reason}`;
}

/**
 * A redirect whose `Location` is a *relative* path.
 *
 * `NextResponse.redirect()` insists on an absolute URL, and building
 * one from the request breaks behind a reverse proxy: a Cloudflare
 * Tunnel forwards `Host: localhost:3000` with `x-forwarded-proto:
 * https`, so `request.nextUrl.origin` comes out as
 * `https://localhost:3000` and resolves nowhere. Browsers resolve a
 * relative `Location` against the URL they actually loaded, which is
 * right on localhost and behind any proxy. 303 makes the follow-up a
 * GET regardless of the method that arrived.
 */
export function relativeRedirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      // A callback that just minted (or failed to mint) a session must
      // never be served from a cache.
      'Cache-Control': 'no-store',
    },
  });
}
