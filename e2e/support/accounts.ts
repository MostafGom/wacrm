// Test accounts, created the real way: sign up → confirm via the emailed
// link (Mailpit) → session cookie. Every spec makes its own account(s),
// so specs are isolated from each other and can run in parallel.

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

import type { Browser, BrowserContext, Page } from "@playwright/test";

import { BASE_URL, COMPOSE, CRON_SECRET, PASSWORD } from "./env";
import { randomPhoneNumberId } from "./fakes";
import { waitForAuthLink } from "./mail";

export type Role = "owner" | "admin" | "agent" | "viewer";

export interface TestUser {
  email: string;
  password: string;
  name: string;
  role: Role;
  userId: string;
  accountId: string;
  /** Value of the wacrm_session cookie. */
  session: string;
  /** Spoofed client IP so per-IP auth rate limits don't trip across specs. */
  ip: string;
}

export interface Connection {
  phoneNumberId: string;
  wabaId: string;
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;

export const uniqueEmail = (label = "user") =>
  `${label}.${Date.now().toString(36)}${randomUUID().slice(0, 6)}@e2e.test`.toLowerCase();

// ------------------------------------------------------------
// Raw HTTP as a user (cookie session)
// ------------------------------------------------------------

export interface ApiResponse<T = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  status: number;
  body: T;
  headers: Headers;
}

export async function api<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any
  user: Pick<TestUser, "session" | "ip"> | null,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    origin: BASE_URL,
    "x-forwarded-for": user?.ip ?? randomIp(),
    ...extraHeaders,
  };
  if (user) headers.cookie = `wacrm_session=${user.session}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

/** Follow an emailed /auth/callback link and return the session it mints. */
export async function followAuthLink(link: string, ip = randomIp()): Promise<{ session: string | null; location: string | null }> {
  const res = await fetch(link, { redirect: "manual", headers: { "x-forwarded-for": ip } });
  const cookie = res.headers.get("set-cookie") ?? "";
  const session = /wacrm_session=([^;]+)/.exec(cookie)?.[1] ?? null;
  return { session: session || null, location: res.headers.get("location") };
}

export async function login(email: string, password = PASSWORD, ip = randomIp()): Promise<string> {
  const r = await api(null, "POST", "/api/auth/login", { email, password }, { "x-forwarded-for": ip });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
  const session = /wacrm_session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1];
  if (!session) throw new Error("login returned no session cookie");
  return session;
}

/** Sign up + confirm via email. Returns a signed-in user. */
export async function signUp(opts: { name?: string; email?: string; inviteToken?: string } = {}): Promise<TestUser> {
  const email = opts.email ?? uniqueEmail("owner");
  const name = opts.name ?? "E2E User";
  const ip = randomIp();
  const startedAt = Date.now();
  const r = await api(null, "POST", "/api/auth/signup", {
    email,
    password: PASSWORD,
    data: { full_name: name },
    inviteToken: opts.inviteToken ?? null,
  }, { "x-forwarded-for": ip });
  if (r.status !== 200) throw new Error(`signup ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);

  // SMTP is on in the e2e stack → confirmation required.
  const { link } = await waitForAuthLink(email, /confirm your email/i, startedAt);
  const { session } = await followAuthLink(link, ip);
  if (!session) throw new Error("confirmation link did not sign the user in");

  const me = await api({ session, ip }, "GET", "/api/me");
  return {
    email,
    password: PASSWORD,
    name,
    role: "owner",
    userId: me.body.profile.user_id,
    accountId: me.body.profile.account_id,
    session,
    ip,
  };
}

/** A fresh owner with their own account. */
export const newOwner = (name = "Olivia Owner") => signUp({ name, email: uniqueEmail("owner") });

/** Invite a teammate with `role` into owner's account (sign up → confirm → redeem). */
export async function addMember(owner: TestUser, role: Exclude<Role, "owner">, name?: string): Promise<TestUser> {
  const inv = await api(owner, "POST", "/api/account/invitations", { role, label: `e2e ${role}` });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const member = await signUp({ name: name ?? `${role[0].toUpperCase()}${role.slice(1)} Member`, email: uniqueEmail(role), inviteToken: inv.body.token });
  const redeem = await api(member, "POST", `/api/invitations/${inv.body.token}/redeem`);
  if (redeem.status !== 200) throw new Error(`redeem failed: ${redeem.status} ${JSON.stringify(redeem.body)}`);
  const me = await api(member, "GET", "/api/me");
  return { ...member, role, accountId: me.body.profile.account_id };
}

/** Connect a fresh fake WhatsApp number to the owner's account (fake Meta). */
export async function connectWhatsApp(admin: TestUser): Promise<Connection> {
  const phoneNumberId = randomPhoneNumberId();
  const wabaId = `2${phoneNumberId.slice(1)}`;
  const r = await api(admin, "POST", "/api/whatsapp/config", {
    phone_number_id: phoneNumberId,
    waba_id: wabaId,
    access_token: "e2e-access-token",
    verify_token: `verify-${phoneNumberId}`,
    pin: "123456",
  });
  if (r.status >= 300) throw new Error(`connect WhatsApp failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { phoneNumberId, wabaId };
}

/** Pull the fake WABA's approved templates into the account. */
export async function syncTemplates(admin: TestUser): Promise<void> {
  const r = await api(admin, "POST", "/api/whatsapp/templates/sync");
  if (r.status >= 300) throw new Error(`template sync failed: ${r.status} ${JSON.stringify(r.body)}`);
}

// ------------------------------------------------------------
// Browser
// ------------------------------------------------------------

export function storageStateFor(user: Pick<TestUser, "session">) {
  return {
    cookies: [
      {
        name: "wacrm_session",
        value: user.session,
        domain: new URL(BASE_URL).hostname,
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };
}

/** A browser context + page signed in as `user`. */
export async function pageAs(browser: Browser, user: TestUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    storageState: storageStateFor(user),
    extraHTTPHeaders: { "x-forwarded-for": user.ip },
    permissions: ["clipboard-read", "clipboard-write", "microphone", "notifications"],
  });
  const page = await context.newPage();
  return { context, page };
}

/** Anonymous browser context (own client IP for rate limits). */
export async function anonymousPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": randomIp() } });
  return { context, page: await context.newPage() };
}

// ------------------------------------------------------------
// Operator helpers
// ------------------------------------------------------------

/** Run both cron endpoints once (what the compose `cron` sidecar does). */
export async function runCron(): Promise<{ automations: unknown; flows: unknown }> {
  const call = async (path: string) => {
    const r = await fetch(`${BASE_URL}${path}`, { headers: { "x-cron-secret": CRON_SECRET } });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  };
  return { automations: await call("/api/automations/cron"), flows: await call("/api/flows/cron") };
}

/** `docker compose exec` into a service of the e2e stack. */
export function composeExec(service: string, args: string[], env: Record<string, string> = {}): string {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return execFileSync("docker", [...COMPOSE, "exec", "-T", ...envArgs, service, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Superuser SQL against the e2e database (only for things the app can't do — e.g. time travel). */
export function sql(query: string): string {
  return composeExec("db", ["psql", "-U", "postgres", "-d", "wacrm", "-Atc", query]);
}
