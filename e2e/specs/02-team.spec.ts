// Team management: invite links (create / copy / join / revoke / expire),
// role changes, removal, owner-issued reset links, and the role matrix
// (what each of owner / admin / agent / viewer can see and do).

import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  addMember,
  anonymousPage,
  api,
  connectWhatsApp,
  login,
  newOwner,
  pageAs,
  sql,
  uniqueEmail,
  type Role,
  type TestUser,
} from "../support/accounts";
import { BASE_URL, PASSWORD } from "../support/env";
import { waitForAuthLink } from "../support/mail";

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", agent: "Agent", viewer: "Viewer" };

const tokenOf = (url: string) => new URL(url).pathname.split("/").pop()!;

async function openMembers(page: Page) {
  await page.goto("/settings?tab=members");
  await expect(page.getByRole("heading", { name: "Team members" })).toBeVisible();
}

/** Invite through Settings → Team members; returns the copied link. */
async function inviteViaUi(
  page: Page,
  opts: { role: Exclude<Role, "owner">; label: string; validFor?: "1 day" | "7 days" | "30 days" },
): Promise<string> {
  await page.getByRole("button", { name: "Invite member" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite a teammate" });
  await expect(dialog).toBeVisible();

  const [roleSelect, expirySelect] = [dialog.getByRole("combobox").nth(0), dialog.getByRole("combobox").nth(1)];
  await expect(roleSelect).toContainText("Agent"); // default
  await expect(dialog.getByText("Use features; no settings")).toBeVisible();
  if (opts.role !== "agent") {
    await roleSelect.click();
    await page.getByRole("option", { name: ROLE_LABEL[opts.role], exact: true }).click();
    await expect(roleSelect).toContainText(ROLE_LABEL[opts.role]);
  }
  await expect(
    dialog.getByText(opts.role === "admin" ? "Manage members + everything" : opts.role === "viewer" ? "Read-only across the app" : "Use features; no settings"),
  ).toBeVisible();
  if (opts.validFor && opts.validFor !== "7 days") {
    await expirySelect.click();
    await page.getByRole("option", { name: opts.validFor, exact: true }).click();
  }
  await dialog.getByPlaceholder("e.g. Sara — support team").fill(opts.label);
  await dialog.getByRole("button", { name: "Generate link" }).click();

  const created = page.getByRole("dialog", { name: "Invite created" });
  await expect(created).toBeVisible();
  const days = opts.validFor ? Number.parseInt(opts.validFor, 10) : 7;
  await expect(created).toContainText(`join the account as ${ROLE_LABEL[opts.role]}`);
  await expect(created).toContainText(`valid for ${days} ${days === 1 ? "day" : "days"}`);
  const url = await created.getByRole("textbox").inputValue();
  expect(url).toMatch(new RegExp(`^${BASE_URL}/join/[\\w-]{20,}$`));

  await created.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByText("Invite link copied")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(url);

  const share = created.getByRole("link", { name: "Send via WhatsApp" });
  expect(decodeURIComponent((await share.getAttribute("href"))!)).toContain(url);

  await created.getByRole("button", { name: "Done" }).click();
  await expect(created).toBeHidden();
  return url;
}

function memberRow(page: Page, email: string) {
  return page.getByRole("listitem").filter({ hasText: email });
}

function inviteRow(page: Page, label: string) {
  return page.getByRole("listitem").filter({ hasText: label });
}

/** Signed-in session from a browser context's cookie jar. */
async function sessionFrom(page: Page): Promise<string> {
  return (await page.context().cookies()).find((c) => c.name === "wacrm_session")!.value;
}

/** A brand-new person signs up through the invite link and accepts it. */
async function joinAsNewUser(browser: Browser, url: string, name: string, accountName: string, role: Role) {
  const { context, page } = await anonymousPage(browser);
  const email = uniqueEmail(`join-${role}`);
  await page.goto(url);
  await expect(page.getByText(`You're invited to ${accountName}`)).toBeVisible();
  await expect(page.getByText(`You'll join as ${ROLE_LABEL[role]}`)).toBeVisible();

  await page.getByRole("button", { name: "Create account & join" }).click();
  await expect(page).toHaveURL(new RegExp(`/signup\\?invite=${tokenOf(url)}$`));
  await expect(page.getByText("Verify your email, then accept the invitation to join your team.")).toBeVisible();
  const startedAt = Date.now();
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  // The confirmation link brings them back to the invitation, signed in.
  const { link } = await waitForAuthLink(email, /confirm your email/i, startedAt);
  expect(decodeURIComponent(link)).toContain(`next=/join/${tokenOf(url)}`);
  await page.goto(link);
  await expect(page).toHaveURL(new RegExp(`/join/${tokenOf(url)}$`));
  await expect(page.getByText(`Accepting moves your login into ${accountName}`)).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  const session = await sessionFrom(page);
  await context.close();
  return { email, session };
}

async function peek(token: string) {
  return (await api(null, "GET", `/api/invitations/${token}/peek`)).body;
}

// ------------------------------------------------------------
// Invitations
// ------------------------------------------------------------

test.describe("invitations", () => {
  test.describe.configure({ mode: "serial" });

  let owner: TestUser;
  let accountName: string;

  test.beforeAll(async () => {
    owner = await newOwner("Tara Teamlead");
    accountName = (await api(owner, "GET", "/api/me")).body.account.name;
  });

  test("empty state, then invite an admin; a new person joins through the link", async ({ browser }) => {
    const { context, page } = await pageAs(browser, owner);
    await openMembers(page);
    await expect(page.getByText("No pending invitations.")).toBeVisible();
    await expect(page.getByText("1 member")).toBeVisible();

    const url = await inviteViaUi(page, { role: "admin", label: "Ada — admin" });
    const row = inviteRow(page, "Ada — admin");
    await expect(row).toContainText("Admin");
    await expect(row).toContainText(/expires in [67] days/);
    await expect(page.getByText("The plaintext invite URL is only shown once")).toBeVisible();

    const joined = await joinAsNewUser(browser, url, "Ada Admin", accountName, "admin");
    const me = await api({ session: joined.session, ip: owner.ip }, "GET", "/api/me");
    expect(me.body.profile.account_id).toBe(owner.accountId);
    expect(me.body.profile.account_role).toBe("admin");

    await page.reload();
    await expect(memberRow(page, joined.email)).toContainText("Ada Admin");
    await expect(memberRow(page, joined.email).getByRole("combobox")).toContainText("Admin");
    await expect(page.getByText("2 members")).toBeVisible();
    await expect(inviteRow(page, "Ada — admin")).toHaveCount(0);
    await expect(page.getByText("No pending invitations.")).toBeVisible();

    // The link is spent.
    expect(await peek(tokenOf(url))).toEqual({ ok: false, reason: "used" });
    await context.close();
  });

  test("an existing user with an empty account of their own redeems an agent link (1-day expiry)", async ({ browser }) => {
    const { context, page } = await pageAs(browser, owner);
    await openMembers(page);
    const url = await inviteViaUi(page, { role: "agent", label: "Existing agent", validFor: "1 day" });
    await expect(inviteRow(page, "Existing agent")).toContainText(/expires in (23|24) hours|expires in 1 day/);

    const peeked = await peek(tokenOf(url));
    expect(peeked).toMatchObject({ ok: true, account_name: accountName, role: "agent" });

    // Someone who already signed up elsewhere (own, empty workspace), signed in.
    const existing = await newOwner("Eli Existing");
    const { context: ec, page: ep } = await pageAs(browser, existing);
    await ep.goto(url);
    await expect(ep.getByText(`You're invited to ${accountName}`)).toBeVisible();
    await ep.getByRole("button", { name: "Accept invitation" }).click();
    await expect(ep).toHaveURL(/\/dashboard$/);

    const me = await api(existing, "GET", "/api/me");
    expect(me.body.profile.account_id).toBe(owner.accountId);
    expect(me.body.profile.account_role).toBe("agent");
    await page.reload();
    await expect(memberRow(page, existing.email).getByRole("combobox")).toContainText("Agent");
    await ec.close();
    await context.close();
  });

  test("a signed-out existing user goes through “I already have an account” to accept a viewer link (30 days)", async ({ browser }) => {
    const { context, page } = await pageAs(browser, owner);
    await openMembers(page);
    const url = await inviteViaUi(page, { role: "viewer", label: "Viewer via login", validFor: "30 days" });
    await expect(inviteRow(page, "Viewer via login")).toContainText(/expires in (29|30) days/);

    const existing = await newOwner("Vic Viewer");
    const { context: ac, page: ap } = await anonymousPage(browser);
    await ap.goto(url);
    await ap.getByRole("button", { name: "I already have an account" }).click();
    await expect(ap).toHaveURL(new RegExp(`/login\\?invite=${tokenOf(url)}$`));
    await expect(ap.getByText("Sign in to accept")).toBeVisible();
    await ap.getByLabel("Email").fill(existing.email);
    await ap.getByLabel("Password").fill(PASSWORD);
    await ap.getByRole("button", { name: "Sign in" }).click();
    await expect(ap).toHaveURL(new RegExp(`/join/${tokenOf(url)}$`));
    await ap.getByRole("button", { name: "Accept invitation" }).click();
    await expect(ap).toHaveURL(/\/dashboard$/);

    const me = await api(existing, "GET", "/api/me");
    expect(me.body.profile.account_id).toBe(owner.accountId);
    expect(me.body.profile.account_role).toBe("viewer");
    await ac.close();
    await context.close();
  });

  test("someone already in another shared team gets the conflict dialog, not a silent failure", async ({ browser }) => {
    const otherOwner = await newOwner("Other Team");
    const busy = await addMember(otherOwner, "agent", "Busy Agent");
    const inv = await api(owner, "POST", "/api/account/invitations", { role: "agent", label: "conflict" });
    expect(inv.status).toBe(201);

    const { context, page } = await pageAs(browser, busy);
    await page.goto(inv.body.url);
    await page.getByRole("button", { name: "Accept invitation" }).click();
    const dialog = page.getByRole("dialog", { name: `Can't join ${accountName} with this account` });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("You are already in a shared account");
    await dialog.getByRole("button", { name: "Stay signed in" }).click();
    await expect(dialog).toBeHidden();

    // Still where they were; the invite is still usable by someone else.
    expect((await api(busy, "GET", "/api/me")).body.profile.account_id).toBe(otherOwner.accountId);
    expect(await peek(inv.body.token)).toMatchObject({ ok: true });
    await context.close();
  });

  test("used, revoked, expired and unknown links show the right error page and can't be redeemed", async ({ browser }) => {
    const { context, page } = await pageAs(browser, owner);
    await openMembers(page);

    // Used.
    const usedInv = await api(owner, "POST", "/api/account/invitations", { role: "viewer", label: "will be used" });
    const user1 = await newOwner("Used Once");
    expect((await api(user1, "POST", `/api/invitations/${usedInv.body.token}/redeem`)).status).toBe(200);

    // Revoked through the UI.
    const revokeUrl = await inviteViaUi(page, { role: "agent", label: "Revoke me" });
    await inviteRow(page, "Revoke me").getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Invitation revoked")).toBeVisible();
    await expect(inviteRow(page, "Revoke me")).toHaveCount(0);

    // Expired: backdate the expiry (the app has no way to age an invite).
    const expInv = await api(owner, "POST", "/api/account/invitations", { role: "agent", label: "Expire me" });
    sql(`UPDATE account_invitations SET expires_at = now() - interval '1 minute' WHERE id = '${expInv.body.invitation.id}'`);
    await page.reload();
    await expect(inviteRow(page, "Expire me")).toHaveCount(0); // pending list hides expired invites

    const { context: ac, page: ap } = await anonymousPage(browser);
    const cases: [string, string, string][] = [
      [usedInv.body.url, "Invite already used", "used"],
      [revokeUrl, "Invite not found", "not_found"],
      [expInv.body.url, "Invite expired", "expired"],
      [`${BASE_URL}/join/${randomUUID()}`, "Invite not found", "not_found"],
    ];
    for (const [url, title, reason] of cases) {
      await ap.goto(url);
      await expect(ap.getByText(title), url).toBeVisible();
      await expect(ap.getByRole("button", { name: "Create a new account instead" })).toBeVisible();
      await expect(ap.getByRole("button", { name: "Sign in" })).toBeVisible();
      expect(await peek(tokenOf(url))).toEqual({ ok: false, reason });
    }
    await ac.close();

    // Redeeming any of them is refused.
    const late = await newOwner("Too Late");
    for (const [url] of cases) {
      const r = await api(late, "POST", `/api/invitations/${tokenOf(url)}/redeem`);
      expect(r.status, url).toBe(400);
    }
    expect((await api(late, "GET", "/api/me")).body.profile.account_id).toBe(late.accountId);
    // Signed out → 401.
    expect((await api(null, "POST", `/api/invitations/${tokenOf(cases[0][0])}/redeem`)).status).toBe(401);
    await context.close();
  });

  test("invite validation: owner role and over-long labels are refused", async () => {
    const owner2 = await newOwner();
    expect((await api(owner2, "POST", "/api/account/invitations", { role: "owner" })).status).toBe(400);
    expect((await api(owner2, "POST", "/api/account/invitations", { role: "bogus" })).status).toBe(400);
    expect((await api(owner2, "POST", "/api/account/invitations", { role: "agent", label: "x".repeat(81) })).status).toBe(400);
    expect((await api(owner2, "DELETE", `/api/account/invitations/${randomUUID()}`)).status).toBe(404);
  });
});

// ------------------------------------------------------------
// Managing members
// ------------------------------------------------------------

test.describe("managing members", () => {
  test("change a member's role from the roster", async ({ browser }) => {
    const owner = await newOwner();
    const agent = await addMember(owner, "agent", "Riley Role");
    const { context, page } = await pageAs(browser, owner);
    await openMembers(page);

    const row = memberRow(page, agent.email);
    await expect(row.getByRole("combobox")).toContainText("Agent");
    await row.getByRole("combobox").click();
    await page.getByRole("option", { name: "Viewer", exact: true }).click();
    await expect(page.getByText("Updated Riley Role to Viewer")).toBeVisible();
    await expect(row.getByRole("combobox")).toContainText("Viewer");

    expect((await api(agent, "GET", "/api/me")).body.profile.account_role).toBe("viewer");
    const members = (await api(owner, "GET", "/api/account/members")).body.members;
    expect(members.find((m: { user_id: string }) => m.user_id === agent.userId).role).toBe("viewer");

    // Promote to admin, then reload: the change persisted.
    await row.getByRole("combobox").click();
    await page.getByRole("option", { name: "Admin", exact: true }).click();
    await expect(page.getByText("Updated Riley Role to Admin")).toBeVisible();
    await page.reload();
    await expect(memberRow(page, agent.email).getByRole("combobox")).toContainText("Admin");

    // The owner row and your own row are not editable; owner can't be granted by PATCH.
    await expect(memberRow(page, owner.email).getByRole("combobox")).toHaveCount(0);
    await expect(memberRow(page, owner.email)).toContainText("Owner");
    await expect(memberRow(page, owner.email)).toContainText("You");
    expect((await api(owner, "PATCH", `/api/account/members/${agent.userId}`, { role: "owner" })).status).toBe(400);
    await context.close();
  });

  test("remove a member: they drop off the roster and get a fresh personal account", async ({ browser }) => {
    const owner = await newOwner();
    const agent = await addMember(owner, "agent", "Rory Remove");
    const { context, page } = await pageAs(browser, owner);
    await openMembers(page);

    const row = memberRow(page, agent.email);
    // The remove button is the icon-only (trash) button at the end of the row.
    await row.getByRole("button").last().click();
    const dialog = page.getByRole("dialog", { name: "Remove member" });
    await expect(dialog).toContainText("Remove Rory Remove from the account?");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();

    await row.getByRole("button").last().click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove member" }).click();
    await expect(page.getByText("Removed Rory Remove")).toBeVisible();
    await expect(memberRow(page, agent.email)).toHaveCount(0);

    const me = (await api(agent, "GET", "/api/me")).body.profile;
    expect(me.account_id).not.toBe(owner.accountId);
    expect(me.account_role).toBe("owner");
    const ids = (await api(owner, "GET", "/api/account/members")).body.members.map((m: { user_id: string }) => m.user_id);
    expect(ids).not.toContain(agent.userId);
    // The owner can't be removed.
    const admin = await addMember(owner, "admin");
    expect((await api(admin, "DELETE", `/api/account/members/${owner.userId}`)).status).toBeGreaterThanOrEqual(400);
    await context.close();
  });

  test("the owner generates a password-reset link for a member", async ({ browser }) => {
    const owner = await newOwner();
    const agent = await addMember(owner, "agent", "Kim Keyless");
    const { context, page } = await pageAs(browser, owner);
    await openMembers(page);

    await memberRow(page, agent.email).getByRole("button", { name: "Password reset link" }).click();
    const dialog = page.getByRole("dialog", { name: "Password reset link" });
    await expect(dialog).toContainText("Share this single-use link with Kim Keyless");
    const link = await dialog.getByRole("textbox").inputValue();
    expect(link).toMatch(new RegExp(`^${BASE_URL}/auth/callback\\?type=recovery&token=`));
    await dialog.getByRole("button", { name: "Copy" }).click();
    await expect(page.getByText("Link copied")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    await dialog.getByRole("button", { name: "Close" }).first().click();
    await expect(dialog).toBeHidden();

    // The member uses it.
    const { context: mc, page: mp } = await anonymousPage(browser);
    await mp.goto(link);
    await expect(mp).toHaveURL(/\/reset-password$/);
    await mp.getByLabel("New password", { exact: true }).fill("Res3t-by-owner");
    await mp.getByLabel("Confirm new password").fill("Res3t-by-owner");
    await mp.getByRole("button", { name: "Update password" }).click();
    await expect(mp.getByText("Password updated")).toBeVisible();
    await mc.close();
    await login(agent.email, "Res3t-by-owner");

    // Owner-only: admins don't get the button or the endpoint; no links for outsiders.
    const admin = await addMember(owner, "admin");
    expect((await api(admin, "POST", `/api/account/members/${agent.userId}/reset-link`)).status).toBe(403);
    const outsider = await newOwner();
    expect((await api(owner, "POST", `/api/account/members/${outsider.userId}/reset-link`)).status).toBe(404);
    const { context: adc, page: adp } = await pageAs(browser, admin);
    await openMembers(adp);
    await expect(memberRow(adp, agent.email)).toBeVisible();
    await expect(adp.getByRole("button", { name: "Password reset link" })).toHaveCount(0);
    await adc.close();
    await context.close();
  });
});

// ------------------------------------------------------------
// Role matrix
// ------------------------------------------------------------

test.describe("role matrix", () => {
  const team = {} as Record<Role, TestUser>;

  test.beforeAll(async () => {
    team.owner = await newOwner("Matrix Owner");
    team.admin = await addMember(team.owner, "admin", "Matrix Admin");
    team.agent = await addMember(team.owner, "agent", "Matrix Agent");
    team.viewer = await addMember(team.owner, "viewer", "Matrix Viewer");
    await connectWhatsApp(team.owner);
  });

  const ROLES: Role[] = ["owner", "admin", "agent", "viewer"];
  const rank: Record<Role, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };

  // [method, path, body, minimum role, status when allowed]. Bodies for
  // writes are deliberately invalid so allowed roles stop at validation
  // (no side effects) while lower roles must stop at the role gate (403).
  const API_MATRIX: [string, string | ((t: typeof team) => string), unknown, Role, number][] = [
    ["GET", "/api/contacts", undefined, "viewer", 200],
    ["GET", "/api/conversations", undefined, "viewer", 200],
    ["GET", "/api/tags", undefined, "viewer", 200],
    ["GET", "/api/pipelines", undefined, "viewer", 200],
    ["GET", "/api/broadcasts", undefined, "viewer", 200],
    ["GET", "/api/automations", undefined, "viewer", 200],
    ["GET", "/api/flows", undefined, "viewer", 200],
    ["GET", "/api/custom-fields", undefined, "viewer", 200],
    ["GET", "/api/dashboard/metrics", undefined, "viewer", 200],
    ["GET", "/api/settings/overview", undefined, "viewer", 200],
    ["GET", "/api/whatsapp/templates", undefined, "viewer", 200],
    ["GET", "/api/account/members", undefined, "viewer", 200],
    ["POST", "/api/contacts", {}, "agent", 400],
    ["POST", "/api/deals", {}, "agent", 400],
    ["POST", "/api/broadcasts", {}, "agent", 400],
    ["POST", "/api/automations", {}, "agent", 400],
    ["POST", "/api/flows", {}, "agent", 400],
    ["POST", "/api/quick-replies", {}, "agent", 400],
    ["POST", "/api/whatsapp/send", {}, "agent", 400],
    ["GET", "/api/account/invitations", undefined, "admin", 200],
    ["POST", "/api/account/invitations", { role: "owner" }, "admin", 400],
    ["DELETE", `/api/account/invitations/${randomUUID()}`, undefined, "admin", 404],
    ["PATCH", (t) => `/api/account/members/${t.agent.userId}`, { role: "bogus" }, "admin", 400],
    ["PATCH", "/api/account", {}, "admin", 400],
    ["POST", "/api/tags", {}, "admin", 400],
    ["POST", "/api/pipelines", {}, "admin", 400],
    ["POST", "/api/custom-fields", {}, "admin", 400],
    ["POST", "/api/account/api-keys", {}, "admin", 400],
    ["GET", "/api/ai/usage", undefined, "admin", 200],
    ["POST", "/api/account/transfer-ownership", {}, "owner", 400],
  ];

  for (const [method, pathOrFn, body, min, okStatus] of API_MATRIX) {
    const label = typeof pathOrFn === "string" ? pathOrFn.replace(/[0-9a-f-]{36}/, ":id") : "/api/account/members/:id";
    test(`API ${method} ${label}: ${min}+ allowed`, async () => {
      const path = typeof pathOrFn === "string" ? pathOrFn : pathOrFn(team);
      const got: Record<string, number> = {};
      for (const role of ROLES) got[role] = (await api(team[role], method, path, body)).status;
      const want = Object.fromEntries(ROLES.map((r) => [r, rank[r] >= rank[min] ? okStatus : 403]));
      expect(got).toEqual(want);
    });
  }

  test("API: WhatsApp connect/disconnect is admin-only (403 agent/viewer, 200 admin)", async () => {
    const config = (r: Role, pn: string) =>
      api(team[r], "POST", "/api/whatsapp/config", {
        phone_number_id: pn,
        waba_id: `2${pn.slice(1)}`,
        access_token: "e2e-access-token",
        verify_token: `verify-${pn}`,
      });
    const pn = `1${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1e5).toString().padStart(5, "0")}`;
    const before = (await api(team.owner, "GET", "/api/whatsapp/config")).body;

    for (const role of ["agent", "viewer"] as const) {
      expect((await config(role, pn)).status, `POST as ${role}`).toBe(403);
      expect((await api(team[role], "DELETE", "/api/whatsapp/config")).status, `DELETE as ${role}`).toBe(403);
    }
    // Nothing changed for the account.
    expect((await api(team.owner, "GET", "/api/whatsapp/config")).body).toEqual(before);

    const saved = await config("admin", pn);
    expect(saved.status).toBe(200);
    const del = await api(team.admin, "DELETE", "/api/whatsapp/config");
    expect(del.status).toBe(200);
    expect((await api(team.owner, "GET", "/api/whatsapp/config")).body.connected).toBe(false);
    // Reconnect for the UI checks below.
    await connectWhatsApp(team.owner);
  });

  test("API: members list shows emails only to admins and owners", async () => {
    for (const role of ROLES) {
      const members = (await api(team[role], "GET", "/api/account/members")).body.members as { email: string | null }[];
      expect(members).toHaveLength(4);
      const emails = members.map((m) => m.email);
      if (rank[role] >= rank.admin) expect(emails).toContain(team.agent.email);
      else expect(emails.every((e) => e === null), role).toBe(true);
    }
  });

  for (const role of ROLES) {
    test(`UI as ${role}: sidebar role chip, members page and settings gates`, async ({ browser }) => {
      const { context, page } = await pageAs(browser, team[role]);
      const canManage = rank[role] >= rank.admin;

      await page.goto("/dashboard");
      // Members of a shared account see its name + their role chip in the
      // sidebar (the owner's solo-named account hides the strip).
      if (role !== "owner") {
        await expect(page.getByRole("complementary").getByText("Matrix Owner", { exact: true })).toBeVisible();
        await expect(page.getByRole("complementary").getByText(ROLE_LABEL[role], { exact: true })).toBeVisible();
      }

      await openMembers(page);
      await expect(page.getByText("4 members")).toBeVisible();
      await expect(page.getByRole("button", { name: "Invite member" })).toHaveCount(canManage ? 1 : 0);
      await expect(page.getByRole("heading", { name: "Pending invitations" })).toHaveCount(canManage ? 1 : 0);
      // Inline role editors: everyone except the owner row and yourself, for admins+.
      const expectedSelects = canManage ? (role === "owner" ? 3 : 2) : 0;
      await expect(page.getByRole("main").getByRole("combobox")).toHaveCount(expectedSelects);
      await expect(page.getByRole("button", { name: "Password reset link" })).toHaveCount(role === "owner" ? 3 : 0);
      // Teammates' emails are hidden from agents and viewers.
      const teammate = role === "owner" ? team.admin : team.owner;
      await expect(page.getByRole("main").getByText(teammate.name)).toBeVisible();
      await expect(page.getByRole("main").getByText(teammate.email)).toHaveCount(canManage ? 1 : 0);

      await page.goto("/settings?tab=api");
      await expect(page.getByRole("button", { name: "New API key" })).toHaveCount(canManage ? 1 : 0);

      await page.goto("/settings?tab=deals");
      await expect(page.getByText("Only account admins can change the default currency.")).toHaveCount(canManage ? 0 : 1);
      await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(canManage ? 1 : 0);
      await context.close();
    });

    test(`UI as ${role}: create buttons across the app`, async ({ browser }) => {
      const { context, page } = await pageAs(browser, team[role]);
      const canSend = rank[role] >= rank.agent;
      const canEditSettings = rank[role] >= rank.admin;
      const enabled = async (btn: ReturnType<Page["getByRole"]>, on: boolean, what: string) => {
        await expect(btn.first(), what).toBeVisible();
        if (on) await expect(btn.first(), what).toBeEnabled();
        else await expect(btn.first(), what).toBeDisabled();
      };

      await page.goto("/contacts");
      await enabled(page.getByRole("button", { name: "Add Contact" }), canSend, "Add Contact");
      await enabled(page.getByRole("button", { name: "Import" }), canSend, "Import");
      await expect(page.getByRole("button", { name: "Custom fields" })).toHaveCount(canEditSettings ? 1 : 0);
      if (!canSend) {
        await expect(page.locator('[title="Read-only — your role can\'t add or import contacts"]').first()).toBeVisible();
      }

      await page.goto("/broadcasts");
      await enabled(page.getByRole("button", { name: "New Broadcast" }), canSend, "New Broadcast");

      await page.goto("/automations");
      await enabled(page.getByRole("button", { name: "Create Automation" }), canSend, "Create Automation");

      await page.goto("/flows");
      await enabled(page.getByRole("button", { name: "New flow" }), canSend, "New flow");

      await page.goto("/pipelines");
      await enabled(page.getByRole("button", { name: /Add Pipeline|New Pipeline/ }), canEditSettings, "Add Pipeline");

      await page.goto("/agents");
      await expect(page.getByRole("tab", { name: "Playground" })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Usage" })).toHaveCount(canEditSettings ? 1 : 0);
      await context.close();
    });
  }

  for (const role of ["agent", "viewer"] as const) {
    test(`UI as ${role}: WhatsApp settings can't be saved or reset`, async ({ browser }) => {
      const { context, page } = await pageAs(browser, team[role]);
      await page.goto("/settings?tab=whatsapp");
      await expect(page.getByRole("button", { name: "Save Configuration" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Reset Configuration" })).toHaveCount(0);
      await expect(page.getByText("Only admins and owners can change the WhatsApp connection.")).toBeVisible();
      await context.close();
    });
  }
});
