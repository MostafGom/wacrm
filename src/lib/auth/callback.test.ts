import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NEXT_PATH,
  isEmailLinkType,
  loginFailurePath,
  parseEmailLink,
  relativeRedirect,
  safeNextPath,
} from './callback';

describe('safeNextPath', () => {
  it('accepts a same-origin absolute path, with query and hash', () => {
    expect(safeNextPath('/reset-password')).toBe('/reset-password');
    expect(safeNextPath('/join/abc-123')).toBe('/join/abc-123');
    expect(safeNextPath('/inbox?c=1#top')).toBe('/inbox?c=1#top');
    expect(safeNextPath('/')).toBe('/');
    expect(safeNextPath('  /dashboard  ')).toBe('/dashboard');
  });

  it('falls back when next is missing or empty', () => {
    expect(safeNextPath(null)).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath(undefined)).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('   ')).toBe(DEFAULT_NEXT_PATH);
  });

  // `next` is query-string input; a scheme-relative or absolute URL
  // would make the callback an open redirect carrying a fresh session.
  it('rejects anything that could leave the origin', () => {
    expect(safeNextPath('//evil.example/x')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('/\\evil.example')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('https://evil.example/')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('javascript:alert(1)')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('evil.example')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('dashboard')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects control characters that could split the Location header', () => {
    expect(safeNextPath('/ok\r\nSet-Cookie: x=y')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('/ok\nX')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('/ok\u0000')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects absurdly long values', () => {
    expect(safeNextPath('/' + 'a'.repeat(5000))).toBe(DEFAULT_NEXT_PATH);
  });

  it('honours a caller-supplied fallback', () => {
    expect(safeNextPath('//evil.example', '/login')).toBe('/login');
  });
});

describe('parseEmailLink', () => {
  it('reads a typed one-time token', () => {
    expect(parseEmailLink(new URLSearchParams('type=recovery&token=abc'))).toEqual({
      type: 'recovery',
      token: 'abc',
    });
    expect(
      parseEmailLink(new URLSearchParams('type=signup_confirm&token=t1&next=/dashboard')),
    ).toEqual({ type: 'signup_confirm', token: 't1' });
  });

  it('rejects a missing token or an unknown type', () => {
    expect(parseEmailLink(new URLSearchParams('type=recovery'))).toBeNull();
    expect(parseEmailLink(new URLSearchParams('type=recovery&token=%20'))).toBeNull();
    expect(parseEmailLink(new URLSearchParams('type=magiclink&token=abc'))).toBeNull();
    expect(parseEmailLink(new URLSearchParams('code=abc'))).toBeNull();
  });
});

describe('isEmailLinkType', () => {
  it('accepts exactly the link types the token table stores', () => {
    for (const t of ['signup_confirm', 'recovery', 'email_change']) {
      expect(isEmailLinkType(t)).toBe(true);
    }
    expect(isEmailLinkType('signup')).toBe(false);
    expect(isEmailLinkType(null)).toBe(false);
  });
});

describe('loginFailurePath', () => {
  it('points at /login with the reason the page can explain', () => {
    expect(loginFailurePath('link_expired')).toBe('/login?error=link_expired');
    expect(loginFailurePath('link_invalid')).toBe('/login?error=link_invalid');
  });
});

describe('relativeRedirect', () => {
  it('emits a 303 with a relative Location and no caching', () => {
    const res = relativeRedirect('/reset-password');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/reset-password');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  // The whole point: behind a Cloudflare Tunnel `request.nextUrl.origin`
  // is `https://localhost:3000`, so an absolute Location resolves nowhere.
  it('never upgrades the path to an absolute URL', () => {
    const res = relativeRedirect('/dashboard');
    expect(res.headers.get('location')).not.toMatch(/^https?:/);
  });
});
