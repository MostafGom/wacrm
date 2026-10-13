import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

// --- Scenario knob the mock reads -------------------------------------------
// `mockSession` — what validateSession() resolves to for any token.
let mockSession: { user: { id: string }; sessionId: string; expiresAt: Date } | null = null;

vi.mock("@/lib/auth/session", () => ({
  SESSION_COOKIE: "wacrm_session",
  validateSession: async (token: string | undefined) => (token ? mockSession : null),
  sessionCookieOptions: (expires: Date) => ({ httpOnly: true, sameSite: "lax", secure: false, path: "/", expires }),
}));

// Imported after the mock is registered.
const { proxy } = await import("./proxy");

const EXPIRES = new Date(Date.now() + 86_400_000);

function req(url: string, token?: string) {
  const r = new NextRequest(url);
  if (token) r.cookies.set("wacrm_session", token);
  return r;
}

beforeEach(() => {
  mockSession = null;
});

afterEach(() => vi.clearAllMocks());

describe("proxy — redirects and the sliding session cookie", () => {
  it("redirects a signed-in user off /login and refreshes the cookie", async () => {
    mockSession = { user: { id: "user-1" }, sessionId: "s1", expiresAt: EXPIRES };

    const res = await proxy(req("https://app.test/login", "tok"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    expect(res.cookies.get("wacrm_session")?.value).toBe("tok");
  });

  it("clears a dead session cookie when redirecting to /login", async () => {
    mockSession = null;

    const res = await proxy(req("https://app.test/dashboard", "revoked"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get("wacrm_session")?.value).toBe("");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockSession = { user: { id: "user-1" }, sessionId: "s1", expiresAt: EXPIRES };

    const res = await proxy(req("https://app.test/login?invite=abc123", "tok"));

    expect(res.headers.get("location")).toContain("/join/abc123");
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockSession = { user: { id: "user-1" }, sessionId: "s1", expiresAt: EXPIRES };

    const res = await proxy(req("https://app.test/dashboard", "tok"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get("wacrm_session")?.value).toBe("tok");
  });

  it("401s signed-out calls to /api/whatsapp/* except the webhook", async () => {
    const api = await proxy(req("https://app.test/api/whatsapp/send"));
    expect(api.status).toBe(401);
    const hook = await proxy(req("https://app.test/api/whatsapp/webhook"));
    expect(hook.status).not.toBe(401);
  });
});

describe("proxy — every dashboard route requires a session", () => {
  // Read the route group rather than hard-coding a list, so a new page added
  // under src/app/(dashboard)/ fails here until it is added to
  // protectedPaths. /flows, /agents and /notifications were missed that way
  // and rendered a broken page to signed-out visitors instead of redirecting.
  const dashboardRoutes = readdirSync(join(__dirname, "app", "(dashboard)"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `/${entry.name}`);

  it("finds the dashboard route group", () => {
    expect(dashboardRoutes).toContain("/dashboard");
  });

  it.each(dashboardRoutes)("redirects a signed-out visitor from %s to /login", async (route) => {
    mockSession = null;

    const res = await proxy(req(`https://app.test${route}`));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});
