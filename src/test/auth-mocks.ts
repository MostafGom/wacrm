// Building blocks for mocking the signed-in caller in unit tests.
//
// requireRole / getCurrentAccount run for real (so role checks are
// exercised); only the session lookup, the DB runner and the profiles
// repository are replaced. Usage in a test file:
//
//   const caller = vi.hoisted(() => ({ userId: 'user-1', accountId: 'acct-1', role: 'agent' as string | null }))
//   vi.mock('@/lib/auth/server-session', async () => (await import('@/test/auth-mocks')).sessionModule(caller))
//   vi.mock('@/server/repos/profiles', async () => (await import('@/test/auth-mocks')).profilesModule(caller))
//   vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule())
//
// Set `caller.userId = null` for a signed-out request.

export interface MockCaller {
  userId: string | null;
  accountId: string;
  role: string | null;
  accountName?: string;
}

export function sessionModule(caller: MockCaller) {
  return {
    getServerSession: async () =>
      caller.userId
        ? {
            sessionId: "session-1",
            expiresAt: new Date(Date.now() + 86_400_000),
            user: {
              id: caller.userId,
              email: "caller@example.test",
              user_metadata: {},
              app_metadata: {},
              email_confirmed_at: null,
              created_at: new Date(0).toISOString(),
              last_sign_in_at: null,
            },
          }
        : null,
  };
}

export function profilesModule(caller: MockCaller) {
  return {
    PROFILE_COLUMNS: [],
    getProfileByUserId: async () =>
      caller.userId
        ? { id: "profile-1", user_id: caller.userId, account_id: caller.accountId, account_role: caller.role }
        : undefined,
    getAccountSummary: async () => ({
      id: caller.accountId,
      name: caller.accountName ?? "Acme",
      default_currency: "USD",
    }),
    listAccountProfiles: async () => [],
  };
}

/**
 * `@/server/db` with runners that just invoke the callback with a dummy
 * transaction. Pair with mocked repositories — nothing reaches Postgres.
 */
export function dbModule(fakeDb: unknown = {}) {
  const run = (fn: (db: unknown) => unknown) => Promise.resolve(fn(fakeDb));
  return {
    asUser: (_userId: string, fn: (db: unknown) => unknown) => run(fn),
    asService: (fn: (db: unknown) => unknown) => run(fn),
    asAnon: (fn: (db: unknown) => unknown) => run(fn),
    withRole: (_role: string, _userId: string | null, fn: (db: unknown) => unknown) => run(fn),
    sql: Object.assign(() => ({ execute: async () => ({ rows: [] }) }), { raw: () => ({}) }),
  };
}
