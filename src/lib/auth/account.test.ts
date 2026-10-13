import { afterEach, describe, expect, it, vi } from "vitest";

// getCurrentAccount resolves the caller's account context from the
// session cookie + two point lookups (profile, then account) through
// the profiles repository. Repositories and the DB runner are mocked:
// this test is about the context rules, not SQL (see
// src/server/repos/*.int.test.ts for the queries themselves).

const mocks = vi.hoisted(() => ({
  session: null as { user: { id: string }; sessionId: string; expiresAt: Date } | null,
  profile: undefined as Record<string, unknown> | undefined,
  account: undefined as Record<string, unknown> | undefined,
  profileError: null as Error | null,
  accountError: null as Error | null,
  asUserCalls: [] as string[],
}));

vi.mock("./server-session", () => ({
  getServerSession: async () => mocks.session,
}));

vi.mock("@/server/db", () => ({
  asUser: async (userId: string, fn: (db: unknown) => Promise<unknown>) => {
    mocks.asUserCalls.push(userId);
    return fn({});
  },
}));

vi.mock("@/server/repos/profiles", () => ({
  getProfileByUserId: vi.fn(async () => {
    if (mocks.profileError) throw mocks.profileError;
    return mocks.profile;
  }),
  getAccountSummary: vi.fn(async () => {
    if (mocks.accountError) throw mocks.accountError;
    return mocks.account;
  }),
}));


const { getCurrentAccount, requireRole, ForbiddenError, UnauthorizedError } = await import("./account");
const profilesRepo = await import("@/server/repos/profiles");

function signedIn(id = "user-1") {
  mocks.session = { user: { id }, sessionId: "s1", expiresAt: new Date(Date.now() + 1e6) };
}

afterEach(() => {
  mocks.session = null;
  mocks.profile = undefined;
  mocks.account = undefined;
  mocks.profileError = null;
  mocks.accountError = null;
  mocks.asUserCalls = [];
});

describe("getCurrentAccount", () => {
  it("resolves context from the profile and a point lookup of its account", async () => {
    signedIn();
    mocks.profile = { id: "p1", account_id: "acct-1", account_role: "admin" };
    mocks.account = { id: "acct-1", name: "Acme", default_currency: "USD" };

    const ctx = await getCurrentAccount();

    expect(ctx).toMatchObject({
      userId: "user-1",
      accountId: "acct-1",
      role: "admin",
      account: { id: "acct-1", name: "Acme" },
    });
    // Runs as the caller (RLS applies), keyed on the session user.
    expect(mocks.asUserCalls).toEqual(["user-1"]);
    expect(profilesRepo.getProfileByUserId).toHaveBeenCalledWith(expect.anything(), "user-1");
    expect(profilesRepo.getAccountSummary).toHaveBeenCalledWith(expect.anything(), "acct-1");
  });

  it("throws UnauthorizedError when there is no session", async () => {
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("maps a database error to 'Could not load account context'", async () => {
    signedIn();
    mocks.profileError = new Error("boom");
    const err = await getCurrentAccount().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("Could not load account context");
  });

  it("rejects a profile not linked to an account", async () => {
    signedIn();
    mocks.profile = { id: "p1", account_id: null, account_role: null };
    await expect(getCurrentAccount()).rejects.toThrow("not linked to an account");
  });

  it("rejects a missing profile row", async () => {
    signedIn();
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects an account_id that resolves to no readable account", async () => {
    signedIn();
    mocks.profile = { id: "p1", account_id: "acct-gone", account_role: "owner" };
    await expect(getCurrentAccount()).rejects.toThrow("not linked to an account");
  });
});

describe("requireRole", () => {
  it("enforces the minimum role", async () => {
    signedIn();
    mocks.profile = { id: "p1", account_id: "acct-1", account_role: "agent" };
    mocks.account = { id: "acct-1", name: "Acme" };
    await expect(requireRole("agent")).resolves.toMatchObject({ role: "agent" });
    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
