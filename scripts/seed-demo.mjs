#!/usr/bin/env node
// Demo data for hands-on testing against the local e2e stack
// (`npm run e2e:up`, then `npm run e2e:seed`).
//
// Everything goes through the app's HTTP API and the fake-WhatsApp
// simulator (never SQL), so seeding exercises the real code paths:
//   - owner / admin / agent / viewer users (signed up + email-confirmed via Mailpit)
//   - the default fake WhatsApp number (100000000000001 / WABA 200000000000001), templates synced
//   - tags, a custom field, ~30 contacts, a sales pipeline with deals
//   - inbound conversations from the simulator (text, image, button reply)
//   - an active welcome automation and the "welcome_menu" flow
//   - AI against the fake OpenAI-compatible provider, with one knowledge document
//
// Then open http://localhost:3000 (app) next to http://localhost:4010 (phone simulator).
// Run it once per fresh stack: the default number can only belong to one account.

import { randomBytes } from "node:crypto";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const FAKES_URL = process.env.E2E_FAKES_URL ?? "http://localhost:4010";
const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";
const PASSWORD = process.env.SEED_PASSWORD ?? "Passw0rd!demo";
const PHONE_NUMBER_ID = process.env.SEED_PHONE_NUMBER_ID ?? "100000000000001";
const WABA_ID = `2${PHONE_NUMBER_ID.slice(1)}`;

const IP = `10.250.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

async function api(session, method, path, body) {
  const headers = { origin: BASE_URL, "x-forwarded-for": IP };
  if (session) headers.cookie = `wacrm_session=${session}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function ok(session, method, path, body) {
  const r = await api(session, method, path, body);
  if (r.status >= 300) fail(`${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function sim(path, body) {
  const res = await fetch(`${FAKES_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(`simulator ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function waitForConfirmLink(email, after) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages = [] } = await res.json();
    const m = messages.find((x) => /confirm your email/i.test(x.Subject) && Date.parse(x.Created) >= after - 1000);
    if (m) {
      const full = await (await fetch(`${MAILPIT_URL}/api/v1/message/${m.ID}`)).json();
      const link = /https?:\/\/\S+\/auth\/callback\?\S+/.exec(full.Text)?.[0];
      if (link) return link;
    }
    await sleep(500);
  }
  fail(`no confirmation email for ${email} in Mailpit (${MAILPIT_URL})`);
}

async function signUp(email, name, inviteToken = null) {
  const startedAt = Date.now();
  await ok(null, "POST", "/api/auth/signup", { email, password: PASSWORD, data: { full_name: name }, inviteToken });
  const link = await waitForConfirmLink(email, startedAt);
  const res = await fetch(link, { redirect: "manual", headers: { "x-forwarded-for": IP } });
  const session = /wacrm_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  if (!session) fail(`confirming ${email} did not sign in`);
  return session;
}

async function main() {
  const health = await fetch(`${BASE_URL}/api/health`).catch(() => null);
  if (!health?.ok) fail(`app not reachable at ${BASE_URL} — run \`npm run e2e:up\` first`);

  const domain = process.env.SEED_DOMAIN ?? "demo.test";
  const users = {
    owner: { email: `owner@${domain}`, name: "Olivia Owner" },
    admin: { email: `admin@${domain}`, name: "Adam Admin" },
    agent: { email: `agent@${domain}`, name: "Ava Agent" },
    viewer: { email: `viewer@${domain}`, name: "Victor Viewer" },
  };

  const existing = await api(null, "POST", "/api/auth/login", { email: users.owner.email, password: PASSWORD });
  if (existing.status === 200) fail(`already seeded (${users.owner.email} exists). Reset with \`npm run e2e:up\`.`);

  // ---- Team ----
  console.log("• users");
  const owner = await signUp(users.owner.email, users.owner.name);
  const sessions = { owner };
  for (const role of ["admin", "agent", "viewer"]) {
    const inv = await ok(owner, "POST", "/api/account/invitations", { role, label: `demo ${role}` });
    const s = await signUp(users[role].email, users[role].name, inv.token);
    await ok(s, "POST", `/api/invitations/${inv.token}/redeem`);
    sessions[role] = s;
  }
  const me = async (s) => (await ok(s, "GET", "/api/me")).profile;
  const agentProfile = await me(sessions.agent);

  // ---- WhatsApp ----
  console.log("• WhatsApp number + templates");
  const conn = await api(owner, "POST", "/api/whatsapp/config", {
    phone_number_id: PHONE_NUMBER_ID,
    waba_id: WABA_ID,
    access_token: "demo-access-token",
    verify_token: "demo-verify-token",
    pin: "123456",
  });
  if (conn.status >= 300) fail(`connect WhatsApp → ${conn.status} ${JSON.stringify(conn.body)} (already used by another account? reset with \`npm run e2e:up\`)`);
  await ok(owner, "POST", "/api/whatsapp/templates/sync");

  // ---- Tags + custom field ----
  console.log("• tags, custom field, contacts");
  const tagDefs = [
    ["VIP", "#eab308"],
    ["Lead", "#3b82f6"],
    ["Customer", "#22c55e"],
    ["Newsletter", "#a855f7"],
  ];
  const tags = {};
  for (const [name, color] of tagDefs) tags[name] = (await ok(owner, "POST", "/api/tags", { name, color })).tag.id;
  const cityField = (await ok(owner, "POST", "/api/custom-fields", { field_name: "City" })).field;

  const first = ["Liam", "Emma", "Noah", "Mia", "Lucas", "Sofia", "Ethan", "Chloe", "Mason", "Zoe", "Leo", "Isla", "Owen", "Ruby", "Eli"];
  const last = ["Garcia", "Kim", "Novak", "Silva", "Haddad", "Okafor", "Rossi", "Tanaka", "Berg", "Murphy"];
  const cities = ["Lisbon", "Berlin", "Austin", "Cairo", "Osaka", "Toronto"];
  const contacts = [];
  for (let i = 0; i < 30; i++) {
    const phone = `+1555300${String(1000 + i).padStart(4, "0")}`;
    const name = `${first[i % first.length]} ${last[(i * 7) % last.length]}`;
    const { contact } = await ok(sessions.agent, "POST", "/api/contacts", {
      name,
      phone,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
      company: i % 3 === 0 ? "Acme Corp" : i % 3 === 1 ? "Globex" : null,
    });
    contacts.push(contact);
    const tagNames = [i % 5 === 0 && "VIP", i % 2 === 0 ? "Customer" : "Lead", i % 4 === 0 && "Newsletter"].filter(Boolean);
    for (const t of tagNames) await ok(sessions.agent, "POST", `/api/contacts/${contact.id}/tags`, { tag_id: tags[t] });
    if (cityField?.id) {
      await ok(sessions.agent, "PUT", `/api/contacts/${contact.id}/custom-values`, {
        values: [{ custom_field_id: cityField.id, value: cities[i % cities.length] }],
      });
    }
    if (i < 3) await ok(sessions.agent, "POST", `/api/contacts/${contact.id}/notes`, { note_text: "Met at the spring trade fair." });
  }

  // ---- Pipeline + deals ----
  console.log("• pipeline + deals");
  const { pipeline } = await ok(owner, "POST", "/api/pipelines", {
    name: "Sales",
    stages: [
      { name: "New", color: "#3b82f6", position: 0 },
      { name: "Qualified", color: "#a855f7", position: 1 },
      { name: "Proposal", color: "#eab308", position: 2 },
      { name: "Negotiation", color: "#f97316", position: 3 },
    ],
  });
  const { stages } = await ok(owner, "GET", `/api/pipelines/${pipeline.id}/stages`);
  {
    for (let i = 0; i < 10; i++) {
      const { deal } = await ok(sessions.agent, "POST", "/api/deals", {
        title: `${contacts[i].name} — ${["Starter plan", "Pro plan", "Onboarding", "Annual renewal"][i % 4]}`,
        pipeline_id: pipeline.id,
        stage_id: stages[i % stages.length].id,
        value: 500 + i * 750,
        currency: "USD",
        contact_id: contacts[i].id,
        assigned_to: i % 2 ? agentProfile.id : null,
      });
      if (i === 8) await ok(sessions.agent, "PATCH", `/api/deals/${deal.id}`, { status: "won" });
      if (i === 9) await ok(sessions.agent, "PATCH", `/api/deals/${deal.id}`, { status: "lost" });
    }
  }

  // ---- Automation + flow ----
  console.log("• automation + flow");
  await ok(owner, "POST", "/api/automations", {
    name: "Thanks for your order",
    trigger_type: "keyword_match",
    trigger_config: { keywords: ["order"], match_type: "contains", case_sensitive: false },
    is_active: true,
    steps: [
      { step_type: "send_message", step_config: { text: "Thanks! An agent will check your order shortly." } },
      { step_type: "add_tag", step_config: { tag_id: tags.Customer } },
    ],
  });
  const { flow } = await ok(owner, "POST", "/api/flows", { template_slug: "welcome_menu" });
  await ok(owner, "POST", `/api/flows/${flow.id}/activate`, { status: "active" });

  // ---- AI ----
  console.log("• AI (fake provider) + knowledge");
  await ok(owner, "POST", "/api/ai/config", {
    provider: "openai_compatible",
    base_url: "http://fakes:4010/compat/v1",
    model: "fake-model",
    api_key: "demo-key",
    system_prompt: "You are the friendly assistant of Fake Business.",
    is_active: true,
    auto_reply_enabled: false,
    handoff_agent_id: agentProfile.user_id,
  });
  await ok(owner, "POST", "/api/ai/knowledge", {
    title: "Shipping policy",
    content: "Standard shipping takes three to five business days.\nExpress shipping arrives the next business day.\nReturns are accepted within thirty days.",
  });

  // ---- Conversations from the simulator ----
  console.log("• inbound conversations");
  const say = (i, extra) =>
    sim("/__sim/inbound", { from: contacts[i].phone, name: contacts[i].name, phone_number_id: PHONE_NUMBER_ID, ...extra });
  await say(0, { text: "Is my order on the way?" }); // the "order" automation replies
  await say(1, { text: "Do you ship to Berlin?" });
  await say(2, { media: { kind: "image", caption: "This is the damaged item" } });
  await say(3, { text: "help" }); // starts the welcome_menu flow
  await sleep(1500);
  await say(3, { button_reply: { id: "existing", title: "Existing customer" } });
  await say(4, { media: { kind: "document", filename: "invoice.pdf", caption: "Invoice attached" } });
  await say(5, { location: { latitude: 38.7223, longitude: -9.1393, name: "Lisbon office" } });
  await say(6, { text: "Can I talk to a human please?" });

  console.log(`
✓ Demo data ready.

  App        ${BASE_URL}
  Simulator  ${FAKES_URL}   (business number ${PHONE_NUMBER_ID})
  Mailpit    ${MAILPIT_URL}

  Password for every user: ${PASSWORD}
${Object.entries(users)
  .map(([role, u]) => `    ${role.padEnd(7)} ${u.email}`)
  .join("\n")}

  Try: send "order" or "help" from the simulator, reply from /inbox,
  or broadcast the "order_update" template to the Customer tag.
`);
}

main().catch((err) => fail(err.stack ?? String(err)));
