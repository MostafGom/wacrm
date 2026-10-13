import { beforeEach, describe, expect, it, vi } from 'vitest';

// The auth service talks to Postgres — stub it and script consumeLink.
const mocks = vi.hoisted(() => ({
  consumeLink: vi.fn(),
}));

vi.mock('@/lib/auth/service', () => {
  class AuthFailure extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { AuthFailure, consumeLink: mocks.consumeLink };
});

import { AuthFailure } from '@/lib/auth/service';
import { GET } from './route';

function request(query: string): Request {
  return new Request(`http://localhost:3000/auth/callback?${query}`);
}

beforeEach(() => {
  mocks.consumeLink.mockResolvedValue({
    token: 'session-token',
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /auth/callback', () => {
  it('consumes a recovery token, sets the session cookie and redirects to next', async () => {
    const res = await GET(request('type=recovery&token=tok-1&next=%2Freset-password'));

    expect(mocks.consumeLink).toHaveBeenCalledWith('recovery', 'tok-1', expect.any(Object));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/reset-password');
    expect(res.headers.get('set-cookie')).toContain('wacrm_session=session-token');
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('defaults a recovery link to /reset-password and others to /dashboard', async () => {
    let res = await GET(request('type=recovery&token=a'));
    expect(res.headers.get('location')).toBe('/reset-password');
    res = await GET(request('type=signup_confirm&token=a'));
    expect(res.headers.get('location')).toBe('/dashboard');
  });

  // `next` is attacker-controllable query input: the callback has just
  // minted a session and must not hand the browser to another origin.
  it('refuses an off-origin next and falls back to /dashboard', async () => {
    for (const next of ['//evil.example', 'https://evil.example', '/\\x']) {
      const res = await GET(request(`type=signup_confirm&token=abc&next=${encodeURIComponent(next)}`));
      expect(res.headers.get('location')).toBe('/dashboard');
    }
  });

  it('sends an expired / used token to /login?error=link_expired', async () => {
    mocks.consumeLink.mockRejectedValue(new AuthFailure('otp_expired', 400, 'expired'));

    const res = await GET(request('type=recovery&token=stale'));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login?error=link_expired');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('sends a link with no token or an unknown type to /login?error=link_invalid', async () => {
    for (const q of ['', 'type=recovery', 'type=magiclink&token=x', 'code=abc']) {
      const res = await GET(request(q));
      expect(res.headers.get('location')).toBe('/login?error=link_invalid');
    }
    expect(mocks.consumeLink).not.toHaveBeenCalled();
  });

  it('never caches the response', async () => {
    const res = await GET(request('type=recovery&token=a'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
