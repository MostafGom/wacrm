// System plumbing: health check, route protection, cron endpoints and
// the compose cron sidecar, and the Meta webhook handshake/signature.

import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";

import { expect, test } from "@playwright/test";

import { anonymousPage, api, composeExec, connectWhatsApp, newOwner, pageAs } from "../support/accounts";
import { BASE_URL, COMPOSE, CRON_SECRET, META_APP_SECRET } from "../support/env";

// Every top-level dashboard route (src/app/(dashboard)/*) plus a few
// nested ones — src/proxy.ts sends all of them to /login when signed out.
const PROTECTED_ROUTES = [
  "/dashboard",
  "/inbox",
  "/contacts",
  "/pipelines",
  "/broadcasts",
  "/broadcasts/new",
  "/automations",
  "/automations/new",
  "/flows",
  "/agents",
  "/notifications",
  "/settings",
  "/settings?tab=members",
];

test.describe("health", () => {
  test("GET /api/health reports the app and database are up", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

test.describe("route protection", () => {
  test("signed out, every dashboard route redirects to /login", async ({ browser }) => {
    const { context, page } = await anonymousPage(browser);
    for (const route of PROTECTED_ROUTES) {
      await page.goto(route);
      await expect(page, `${route} should bounce to /login`).toHaveURL(/\/login(\?|$)/);
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    }
    await context.close();
  });

  test("signed out, the redirect is a server-side 307 to /login (no page rendered)", async () => {
    for (const route of PROTECTED_ROUTES) {
      const res = await fetch(`${BASE_URL}${route}`, { redirect: "manual" });
      expect(res.status, route).toBe(307);
      expect(new URL(res.headers.get("location")!, BASE_URL).pathname, route).toBe("/login");
    }
  });

  test("a garbage session cookie counts as signed out and is cleared", async () => {
    const res = await fetch(`${BASE_URL}/dashboard`, {
      redirect: "manual",
      headers: { cookie: "wacrm_session=not-a-real-session" },
    });
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!, BASE_URL).pathname).toBe("/login");
    expect(res.headers.get("set-cookie") ?? "").toMatch(/wacrm_session=;/);
  });

  test("public pages stay reachable while signed out", async ({ browser }) => {
    const { context, page } = await anonymousPage(browser);
    for (const route of ["/login", "/signup", "/forgot-password", "/reset-password"]) {
      await page.goto(route);
      await expect(page, route).toHaveURL(new RegExp(`${route}$`));
    }
    await context.close();
  });

  test("signed-out calls to /api/whatsapp/* get 401 JSON, the webhook is exempt", async () => {
    const send = await api(null, "POST", "/api/whatsapp/send", { to: "+15550001111", message: "x" });
    expect(send.status).toBe(401);
    expect(send.body).toEqual({ error: "Unauthorized" });
    const cfg = await api(null, "GET", "/api/whatsapp/config");
    expect(cfg.status).toBe(401);
    // The webhook answers on its own terms (400: missing verify params), not the proxy's 401.
    const hook = await fetch(`${BASE_URL}/api/whatsapp/webhook`);
    expect(hook.status).toBe(400);
  });

  test("signed in, the auth pages send you to the dashboard (or to the invite)", async ({ browser }) => {
    const owner = await newOwner();
    const { context, page } = await pageAs(browser, owner);
    for (const route of ["/login", "/signup", "/forgot-password"]) {
      await page.goto(route);
      await expect(page, route).toHaveURL(/\/dashboard$/);
    }
    // Forwarded invite link while already signed in → straight to /join.
    const res = await fetch(`${BASE_URL}/login?invite=abc123`, {
      redirect: "manual",
      headers: { cookie: `wacrm_session=${owner.session}` },
    });
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!, BASE_URL).pathname).toBe("/join/abc123");
    await context.close();
  });
});

test.describe("cron endpoints", () => {
  for (const path of ["/api/automations/cron", "/api/flows/cron"]) {
    test(`${path}: missing or wrong secret → 401, right secret → 200`, async () => {
      const missing = await fetch(`${BASE_URL}${path}`);
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ error: "Unauthorized" });

      const wrong = await fetch(`${BASE_URL}${path}`, { headers: { "x-cron-secret": "wrong-secret" } });
      expect(wrong.status).toBe(401);

      // Same length as the real secret, different bytes (exercises the constant-time compare path).
      const sameLength = "x".repeat(CRON_SECRET.length);
      const wrongSameLength = await fetch(`${BASE_URL}${path}`, { headers: { "x-cron-secret": sameLength } });
      expect(wrongSameLength.status).toBe(401);

      const ok = await fetch(`${BASE_URL}${path}`, { headers: { "x-cron-secret": CRON_SECRET } });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(typeof body).toBe("object");
      expect(body.error).toBeUndefined();
    });
  }

  test("the compose cron sidecar is running and can reach both endpoints", async () => {
    const ps = execFileSync("docker", [...COMPOSE, "ps", "--status", "running", "--services"], {
      encoding: "utf8",
    });
    expect(ps.split("\n").map((s) => s.trim())).toContain("cron");

    // From inside the sidecar, with its own configured secret — exactly what its loop runs.
    for (const path of ["/api/automations/cron", "/api/flows/cron"]) {
      const out = composeExec("cron", [
        "sh",
        "-c",
        `curl -sS -o /dev/null -w '%{http_code}' -H "x-cron-secret: $AUTOMATION_CRON_SECRET" http://app:3000${path}`,
      ]);
      expect(out, path).toBe("200");
    }

    // Its loop logs only on failure; nothing should have failed recently.
    const logs = execFileSync("docker", [...COMPOSE, "logs", "--since", "2m", "cron"], { encoding: "utf8" });
    expect(logs).not.toMatch(/cron: .* failed/);
  });
});

test.describe("WhatsApp webhook", () => {
  test.describe.configure({ mode: "serial" });

  let verifyToken = "";

  test.beforeAll(async () => {
    const owner = await newOwner();
    const wa = await connectWhatsApp(owner);
    verifyToken = `verify-${wa.phoneNumberId}`;
  });

  const verifyUrl = (token: string, challenge = "challenge-123", mode = "subscribe") =>
    `${BASE_URL}/api/whatsapp/webhook?${new URLSearchParams({
      "hub.mode": mode,
      "hub.verify_token": token,
      "hub.challenge": challenge,
    })}`;

  test("GET verify: the account's verify token echoes the challenge", async () => {
    const challenge = `ch-${Date.now()}`;
    const res = await fetch(verifyUrl(verifyToken, challenge));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe(challenge);
  });

  test("GET verify: a wrong token is refused with 403", async () => {
    const res = await fetch(verifyUrl(`${verifyToken}-nope`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Verification token mismatch" });
  });

  test("GET verify: missing params or a non-subscribe mode → 400", async () => {
    expect((await fetch(`${BASE_URL}/api/whatsapp/webhook?hub.mode=subscribe`)).status).toBe(400);
    expect((await fetch(verifyUrl(verifyToken, "c", "unsubscribe"))).status).toBe(400);
  });

  const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const sign = (body: string, secret = META_APP_SECRET) =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const post = (body: string, signature?: string) =>
    fetch(`${BASE_URL}/api/whatsapp/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
      body,
    });

  test("POST: a bad, foreign or missing signature is rejected with 401", async () => {
    const bad = await post(payload, "sha256=deadbeef");
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "Invalid signature" });

    // Signed with a different app secret.
    expect((await post(payload, sign(payload, "someone-elses-secret"))).status).toBe(401);
    // Correct signature of a different body (tampered payload).
    expect((await post(payload, sign(`${payload} `))).status).toBe(401);
    // No signature header at all.
    expect((await post(payload)).status).toBe(401);
  });

  test("POST: a correctly signed delivery is accepted", async () => {
    const res = await post(payload, sign(payload));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "received" });
  });
});
