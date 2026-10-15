// Authentication, driven through the real pages: sign up + email
// confirmation (Mailpit), sign in / out, forgot + reset password,
// settings → password / email / sign out everywhere, the operator CLI
// and the login rate limit.

import { randomBytes } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  anonymousPage,
  api,
  composeExec,
  login,
  newOwner,
  pageAs,
  uniqueEmail,
  type TestUser,
} from "../support/accounts";
import { BASE_URL, PASSWORD } from "../support/env";
import { countEmails, waitForAuthLink } from "../support/mail";

const NEW_PASSWORD = "N3wPassw0rd!e2e";

const ownIp = () => `10.${200 + (randomBytes(1)[0] % 50)}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;

/** Status of a password login attempt (no throw). */
async function tryLogin(email: string, password: string, ip = ownIp()) {
  return api(null, "POST", "/api/auth/login", { email, password }, { "x-forwarded-for": ip });
}

async function signInViaUi(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function fillSignup(page: Page, opts: { name: string; email: string; password: string; confirm?: string }) {
  await page.getByLabel("Full name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password", { exact: true }).fill(opts.password);
  await page.getByLabel("Confirm password").fill(opts.confirm ?? opts.password);
  await page.getByRole("button", { name: "Create account" }).click();
}

/** Fresh context in its own browser session, signed in via a second login. */
async function secondSession(user: TestUser): Promise<TestUser> {
  return { ...user, session: await login(user.email, user.password), ip: ownIp() };
}

async function expectSignedOut(user: Pick<TestUser, "session" | "ip">) {
  const me = await api(user, "GET", "/api/me");
  expect(me.status).toBe(401);
}

async function expectSignedIn(user: Pick<TestUser, "session" | "ip">) {
  const me = await api(user, "GET", "/api/me");
  expect(me.status).toBe(200);
  return me.body;
}

async function openAnon(browser: Browser) {
  return anonymousPage(browser);
}

// ------------------------------------------------------------
// Sign up
// ------------------------------------------------------------

test.describe("sign up", () => {
  test("sign up in the UI, refused before confirming, confirm from the email, land on the dashboard", async ({ browser }) => {
    const { context, page } = await openAnon(browser);
    const email = uniqueEmail("signup");
    const startedAt = Date.now();

    await page.goto("/login");
    await page.getByRole("link", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByText("Get started with CRM Template for WhatsApp")).toBeVisible();

    await fillSignup(page, { name: "Sam Signup", email, password: PASSWORD });
    await expect(page.getByText("Check your email")).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    // Not confirmed yet: sign-in is refused with a pointer to the inbox.
    await page.getByRole("button", { name: "Back to sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Email not confirmed. Check your inbox for the confirmation link.")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect((await tryLogin(email, PASSWORD)).body.error.code).toBe("email_not_confirmed");

    // Open the emailed link in the browser → signed in on the dashboard.
    const mail = await waitForAuthLink(email, /confirm your email/i, startedAt);
    expect(mail.subject).toBe("Confirm your email");
    await page.goto(mail.link);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("main").getByRole("heading", { name: "Dashboard" })).toBeVisible();

    // The new user owns a fresh workspace and can now sign in normally.
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === "wacrm_session")!.value;
    const me = await expectSignedIn({ session, ip: ownIp() });
    expect(me.profile.full_name).toBe("Sam Signup");
    expect(me.profile.email).toBe(email);
    expect(me.profile.account_role).toBe("owner");
    expect((await tryLogin(email, PASSWORD)).status).toBe(200);

    // The confirmation link is single-use.
    const { context: other, page: again } = await openAnon(browser);
    await again.goto(mail.link);
    await expect(again).toHaveURL(/\/login\?error=link_expired/);
    await expect(again.getByText(/That link has expired/)).toBeVisible();
    await other.close();
    await context.close();
  });

  test("sign-up form validation messages", async ({ browser }) => {
    const { context, page } = await openAnon(browser);
    const existing = await newOwner();
    const email = uniqueEmail("signupval");

    await page.goto("/signup");
    await fillSignup(page, { name: "Val", email, password: "abcdef1", confirm: "abcdef2" });
    await expect(page.getByText("Passwords do not match")).toBeVisible();

    await fillSignup(page, { name: "Val", email, password: "abc12" });
    await expect(page.getByText("Password must be at least 6 characters")).toBeVisible();

    await fillSignup(page, { name: "Val", email: existing.email, password: PASSWORD });
    await expect(page.getByText("A user with this email address has already been registered.")).toBeVisible();

    // Nothing was created for the rejected attempts.
    expect((await tryLogin(email, "abcdef1")).body.error.code).toBe("invalid_credentials");
    expect(await countEmails(email)).toBe(0);

    // The server enforces the same floor on its own.
    const weak = await api(null, "POST", "/api/auth/signup", { email, password: "abc", data: { full_name: "x" } });
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe("weak_password");
    const badEmail = await api(null, "POST", "/api/auth/signup", { email: "not-an-email", password: PASSWORD });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.error.code).toBe("validation_failed");
    await context.close();
  });

  test.fixme("ALLOW_SIGNUPS=false blocks open sign-up but still allows invite sign-ups", async () => {
    // needs restart: ALLOW_SIGNUPS is read from the app container's
    // environment, so flipping it means recreating the app service,
    // which would break every other spec running against the stack.
    // Expected: POST /api/auth/signup → 403 signup_disabled ("Sign-ups are
    // disabled on this workspace…") without an invite; 200 with a valid
    // pending invite token; the /signup page shows that message.
  });
});

// ------------------------------------------------------------
// Sign in / out
// ------------------------------------------------------------

test.describe("sign in and out", () => {
  test("login through the UI, then sign out from the account menu", async ({ browser }) => {
    const user = await newOwner("Lena Login");
    const { context, page } = await openAnon(browser);

    await signInViaUi(page, user.email, user.password);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("main").getByRole("heading", { name: "Dashboard" })).toBeVisible();
    const session = (await context.cookies()).find((c) => c.name === "wacrm_session")!.value;
    await expectSignedIn({ session, ip: ownIp() });

    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // The session is revoked server-side, not just dropped from the browser.
    await expectSignedOut({ session, ip: ownIp() });
    await page.goto("/inbox");
    await expect(page).toHaveURL(/\/login$/);

    // Signing out of one device leaves the other sessions alone.
    await expectSignedIn(user);
    await context.close();
  });

  test("a wrong password shows an error and does not sign in", async ({ browser }) => {
    const user = await newOwner();
    const { context, page } = await openAnon(browser);
    await signInViaUi(page, user.email, "definitely-wrong");
    await expect(page.getByText("Invalid login credentials.")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect((await context.cookies()).find((c) => c.name === "wacrm_session")).toBeUndefined();
    // Email is case-insensitive; the right password still works afterwards.
    await page.getByLabel("Email").fill(user.email.toUpperCase());
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await context.close();
  });

  test("an unknown email fails with the same generic error", async ({ browser }) => {
    const { context, page } = await openAnon(browser);
    await signInViaUi(page, uniqueEmail("nobody"), PASSWORD);
    await expect(page.getByText("Invalid login credentials.")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    const r = await tryLogin(uniqueEmail("nobody"), PASSWORD);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_credentials");
    await context.close();
  });

  test("cross-origin login attempts are refused", async () => {
    const user = await newOwner();
    const r = await api(null, "POST", "/api/auth/login", { email: user.email, password: user.password }, {
      origin: "https://evil.example",
      "x-forwarded-for": ownIp(),
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("forbidden_origin");
  });

  test("per-IP login rate limit: the 11th attempt in a minute gets 429, other IPs are unaffected", async ({ browser }) => {
    const ip = ownIp();
    const victim = await newOwner();
    // Ten failures from our own spoofed IP (unique emails, so no per-email bucket is shared).
    for (let i = 0; i < 10; i++) {
      const r = await tryLogin(uniqueEmail("rl"), "wrong-password", ip);
      expect(r.status, `attempt ${i + 1}`).toBe(400);
    }
    const blocked = await tryLogin(victim.email, victim.password, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("over_request_rate_limit");

    // The UI from the same IP shows the message.
    const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": ip } });
    const page = await context.newPage();
    await signInViaUi(page, victim.email, victim.password);
    await expect(page.getByText("Too many attempts. Please wait a minute and try again.")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await context.close();

    // A different client IP signs in fine.
    expect((await tryLogin(victim.email, victim.password, ownIp())).status).toBe(200);
  });
});

// ------------------------------------------------------------
// Forgot / reset password
// ------------------------------------------------------------

test.describe("forgot password", () => {
  test("request a reset in the UI, reset from the email, sign in with the new password; the link is single-use", async ({ browser }) => {
    const user = await newOwner("Rita Reset");
    const { context, page } = await openAnon(browser);

    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    const startedAt = Date.now();
    await page.getByLabel("Email").fill(user.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("Check your email")).toBeVisible();
    await expect(page.getByText(user.email)).toBeVisible();

    const mail = await waitForAuthLink(user.email, /reset your password/i, startedAt);
    expect(mail.subject).toBe("Reset your password");
    await page.goto(mail.link);
    await expect(page).toHaveURL(/\/reset-password$/);
    await expect(page.getByText("Choose a new password")).toBeVisible();

    // Form validation.
    await page.getByLabel("New password", { exact: true }).fill("abcdef1");
    await page.getByLabel("Confirm new password").fill("abcdef2");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("Passwords do not match")).toBeVisible();
    await page.getByLabel("New password", { exact: true }).fill("abc");
    await page.getByLabel("Confirm new password").fill("abc");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("Password must be at least 6 characters")).toBeVisible();
    // Server-side: re-using the current password is refused.
    await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm new password").fill(PASSWORD);
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("New password should be different from the old password.")).toBeVisible();

    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("Password updated")).toBeVisible();
    await page.getByRole("button", { name: "Continue to dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    // New password works, the old one doesn't, and older sessions were signed out.
    expect((await tryLogin(user.email, PASSWORD)).status).toBe(400);
    expect((await tryLogin(user.email, NEW_PASSWORD)).status).toBe(200);
    await expectSignedOut(user);

    // Using the same link a second time is rejected.
    const { context: other, page: again } = await openAnon(browser);
    await again.goto(mail.link);
    await expect(again).toHaveURL(/\/login\?error=link_expired/);
    await expect(again.getByText(/That link has expired/)).toBeVisible();
    // …and the reset form says so when reached without a recovery session.
    await again.goto("/reset-password");
    await expect(again.getByText("This link is no longer valid")).toBeVisible();
    await expect(again.getByRole("button", { name: "Request a new link" })).toBeVisible();
    await other.close();
    await context.close();
  });

  test("an unknown address gets the same confirmation and no email", async ({ browser }) => {
    const { context, page } = await openAnon(browser);
    const email = uniqueEmail("ghost");
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("Check your email")).toBeVisible();
    expect(await countEmails(email)).toBe(0);
    await context.close();
  });

  test("a tampered or malformed reset link is refused", async ({ browser }) => {
    const { context, page } = await openAnon(browser);
    await page.goto("/auth/callback?type=recovery&token=not-a-real-token&next=/reset-password");
    await expect(page).toHaveURL(/\/login\?error=link_expired/);
    await page.goto("/auth/callback?type=bogus&token=x");
    await expect(page).toHaveURL(/\/login\?error=link_invalid/);
    await expect(page.getByText(/That link couldn.t be used to sign you in/)).toBeVisible();
    await context.close();
  });
});

// ------------------------------------------------------------
// Settings → Login & security / profile email
// ------------------------------------------------------------

test.describe("settings: password, email, sessions", () => {
  test("change password in settings signs out the other sessions, keeps this one", async ({ browser }) => {
    const user = await newOwner("Pat Password");
    const other = await secondSession(user);
    await expectSignedIn(other);

    const { context, page } = await pageAs(browser, user);
    await page.goto("/settings?tab=security");
    await expect(page.getByRole("heading", { name: "Login & security" })).toBeVisible();

    const current = page.getByLabel("Current password");
    const next = page.getByLabel("New password", { exact: true });
    const confirm = page.getByLabel("Confirm new password");
    const submit = page.getByRole("button", { name: "Update password" });

    // Button stays disabled until every field has something in it.
    await expect(submit).toBeDisabled();

    // Validation: the settings form asks for 8+ characters and a matching confirmation.
    await current.fill(PASSWORD);
    await next.fill("short1");
    await confirm.fill("short1");
    // Bypass the native minLength bubble so the app's own message shows.
    await page.locator("form").filter({ has: next }).evaluate((f) => f.setAttribute("novalidate", ""));
    await submit.click();
    await expect(page.getByText("Password must be at least 8 characters")).toBeVisible();

    await next.fill(NEW_PASSWORD);
    await confirm.fill(`${NEW_PASSWORD}x`);
    await submit.click();
    await expect(page.getByText("New password and confirmation do not match")).toBeVisible();

    // Wrong current password.
    await current.fill("not-my-password");
    await confirm.fill(NEW_PASSWORD);
    await submit.click();
    await expect(page.getByText("Current password is incorrect")).toBeVisible();
    await expectSignedIn(other);

    // Same as the old one.
    await current.fill(PASSWORD);
    await next.fill(PASSWORD);
    await confirm.fill(PASSWORD);
    await submit.click();
    await expect(page.getByText(/New password should be different from the old password/)).toBeVisible();

    // Success.
    await current.fill(PASSWORD);
    await next.fill(NEW_PASSWORD);
    await confirm.fill(NEW_PASSWORD);
    await submit.click();
    await expect(page.getByText("Password updated", { exact: true })).toBeVisible();
    await expect(current).toHaveValue("");

    await expectSignedOut(other);
    await expectSignedIn(user);
    await page.reload();
    await expect(page).toHaveURL(/\/settings\?tab=security$/);
    expect((await tryLogin(user.email, PASSWORD)).status).toBe(400);
    expect((await tryLogin(user.email, NEW_PASSWORD)).status).toBe(200);
    await context.close();
  });

  test("change email: confirmation email to the new address, then sign in with it", async ({ browser }) => {
    const user = await newOwner("Eve Email");
    const newEmail = uniqueEmail("changed");
    const { context, page } = await pageAs(browser, user);
    await page.goto("/settings?tab=profile");
    const emailField = page.getByLabel("Email", { exact: true });
    await expect(emailField).toHaveValue(user.email);

    // Client-side shape check.
    await emailField.fill("not-an-email@x");
    await page.locator("form").filter({ has: emailField }).evaluate((f) => f.setAttribute("novalidate", ""));
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Enter a valid email address")).toBeVisible();

    const startedAt = Date.now();
    await emailField.fill(newEmail);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Profile saved — check your email to confirm the address change")).toBeVisible();
    await expect(page.getByText(/both need to confirm before the change takes effect/)).toBeVisible();

    // Not applied until confirmed.
    expect((await expectSignedIn(user)).profile.email).toBe(user.email);
    expect((await tryLogin(newEmail, PASSWORD)).status).toBe(400);

    const mail = await waitForAuthLink(newEmail, /confirm your new email/i, startedAt);
    expect(mail.subject).toBe("Confirm your new email");
    await page.goto(mail.link);
    await expect(page).toHaveURL(/\/settings$/);

    await expect.poll(async () => (await api(user, "GET", "/api/me")).body.profile.email).toBe(newEmail);
    const sessionUser = await api(user, "GET", "/api/auth/session");
    expect(sessionUser.body.session.user.email).toBe(newEmail);
    expect((await tryLogin(newEmail, PASSWORD)).status).toBe(200);
    expect((await tryLogin(user.email, PASSWORD)).status).toBe(400);

    // Taking an address that's already registered is refused.
    const someoneElse = await newOwner();
    await page.goto("/settings?tab=profile");
    await page.getByLabel("Email", { exact: true }).fill(someoneElse.email);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/Email change failed: A user with this email address has already been registered/)).toBeVisible();
    await context.close();
  });

  test("sign out everywhere ends every session, including this one", async ({ browser }) => {
    const user = await newOwner("Sid Signout");
    const other = await secondSession(user);
    const { context, page } = await pageAs(browser, user);
    await page.goto("/settings?tab=security");

    await page.getByRole("button", { name: "Sign out of all devices" }).click();
    const dialog = page.getByRole("dialog", { name: "Sign out everywhere?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expectSignedIn(other);

    await page.getByRole("button", { name: "Sign out of all devices" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Sign out everywhere" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await expectSignedOut(other);
    await expectSignedOut(user);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
    // Password unchanged — signing back in works.
    expect((await tryLogin(user.email, PASSWORD)).status).toBe(200);
    await context.close();
  });
});

// ------------------------------------------------------------
// Operator CLI (scripts/auth-cli.mjs, shipped in the app image)
// ------------------------------------------------------------

test.describe("auth CLI", () => {
  const cli = (...args: string[]) => composeExec("app", ["node", "scripts/auth-cli.mjs", ...args]);

  test("create-user makes a confirmed owner who can sign in through the UI", async ({ browser }) => {
    const email = uniqueEmail("cli");
    const out = cli("create-user", email, PASSWORD, "Cleo", "Cli");
    expect(out).toMatch(new RegExp(`^created ${email.replace(/[.+]/g, "\\$&")} \\([0-9a-f-]{36}\\)$`));

    const { context, page } = await openAnon(browser);
    await signInViaUi(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);
    const session = (await context.cookies()).find((c) => c.name === "wacrm_session")!.value;
    const me = await expectSignedIn({ session, ip: ownIp() });
    expect(me.profile.full_name).toBe("Cleo Cli");
    expect(me.profile.account_role).toBe("owner");
    await context.close();

    // Duplicate email and weak password are refused.
    expect(() => cli("create-user", email, PASSWORD)).toThrow(/duplicate|already exists|unique/i);
    expect(() => cli("create-user", uniqueEmail("cliweak"), "abc")).toThrow(/at least 6 characters/);
  });

  test("reset-link prints a single-use recovery link that resets the password", async ({ browser }) => {
    const user = await newOwner("Rex Reset");
    const first = cli("reset-link", user.email);
    const link = cli("reset-link", user.email.toUpperCase());
    expect(link).toMatch(new RegExp(`^${BASE_URL}/auth/callback\\?type=recovery&token=[\\w-]+&next=%2Freset-password$`));

    const { context, page } = await openAnon(browser);
    // A newer link replaces the older one.
    await page.goto(first);
    await expect(page).toHaveURL(/\/login\?error=link_expired/);

    await page.goto(link);
    await expect(page).toHaveURL(/\/reset-password$/);
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("Password updated")).toBeVisible();
    expect((await tryLogin(user.email, NEW_PASSWORD)).status).toBe(200);
    expect((await tryLogin(user.email, PASSWORD)).status).toBe(400);
    await context.close();

    const { context: c2, page: p2 } = await openAnon(browser);
    await p2.goto(link);
    await expect(p2).toHaveURL(/\/login\?error=link_expired/);
    await c2.close();

    expect(() => cli("reset-link", uniqueEmail("nobody"))).toThrow(/no user with email/);
  });
});
