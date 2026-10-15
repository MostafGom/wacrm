#!/usr/bin/env node
// ============================================================
// Fake external services for local end-to-end testing.
// NEVER part of a production deployment (docker-compose.e2e.yml only).
//
//   /v21.0/...            fake Meta WhatsApp Cloud (Graph) API
//   /media/:id            bytes for fake inbound media
//   /__sim/...            customer simulator API (sends signed inbound
//                         webhooks to the app, lists what the app sent)
//   /                     simulator UI (a fake WhatsApp phone)
//   /openai/v1/...        fake OpenAI chat + embeddings
//   /anthropic/v1/...     fake Anthropic messages
//   /compat/v1/...        fake OpenAI-compatible provider
//   /__hooks/:name        outbound webhook receiver (verifies signatures)
//   POST /__reset         clear all state
//
// Dependency-free Node 20+. State is in memory.
// ============================================================

import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { samplePdf, samplePng, sampleOgg } from "./media.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cfg = {
  port: Number(process.env.PORT ?? 4010),
  // Where the app's Meta webhook lives (inside the compose network).
  appWebhookUrl: process.env.APP_WEBHOOK_URL ?? "http://app:3000/api/whatsapp/webhook",
  // How the APP reaches this service (media download URLs we hand out).
  internalUrl: (process.env.FAKES_INTERNAL_URL ?? "http://fakes:4010").replace(/\/+$/, ""),
  appSecret: (process.env.META_APP_SECRET ?? "e2e-meta-app-secret").split(",")[0].trim(),
  appId: process.env.META_APP_ID ?? "900000000000001",
  phoneNumberId: process.env.FAKE_PHONE_NUMBER_ID ?? "100000000000001",
  wabaId: process.env.FAKE_WABA_ID ?? "200000000000001",
  displayPhone: process.env.FAKE_DISPLAY_PHONE ?? "+1 555-000-0001",
  verifiedName: process.env.FAKE_VERIFIED_NAME ?? "Fake Business",
  statusDelayMs: Number(process.env.FAKE_STATUS_DELAY_MS ?? 250),
};

// ------------------------------------------------------------
// State
// ------------------------------------------------------------

let templateSeq = 0; // never reused, even after deletes

/** Templates Meta "already has" (synced by the app). */
function fixtureTemplates() {
  return [
    {
      id: "700000000000001",
      name: "order_update",
      language: "en_US",
      status: "APPROVED",
      category: "UTILITY",
      components: [
        { type: "BODY", text: "Hi {{1}}, your order {{2}} has shipped!", example: { body_text: [["Jane", "#1001"]] } },
        { type: "FOOTER", text: "Fake Business" },
      ],
      quality_score: { score: "GREEN" },
    },
    {
      id: "700000000000002",
      name: "promo_image",
      language: "en_US",
      status: "APPROVED",
      category: "MARKETING",
      components: [
        { type: "HEADER", format: "IMAGE", example: { header_handle: ["https://example.com/promo.png"] } },
        { type: "BODY", text: "Hello {{1}}! This week only: {{2}} off everything.", example: { body_text: [["Jane", "20%"]] } },
      ],
      quality_score: { score: "GREEN" },
    },
    {
      id: "700000000000003",
      name: "appointment_confirm",
      language: "en",
      status: "APPROVED",
      category: "UTILITY",
      components: [
        { type: "BODY", text: "Can you make it to your appointment tomorrow?" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Yes" },
            { type: "QUICK_REPLY", text: "No" },
          ],
        },
      ],
      quality_score: { score: "UNKNOWN" },
    },
  ];
}

function freshState() {
  return {
    seq: 0,
    templates: fixtureTemplates(),
    /** Messages the app sent through the fake Graph API. */
    outbound: [],
    /** Messages the simulator sent to the app (as the customer). */
    inbound: [],
    /** Customer phone (digits) → display name. */
    customers: new Map([
      ["15550001001", "Alice Customer"],
      ["15550001002", "Bob Buyer"],
    ]),
    /** Outbound webhook deliveries received. */
    hooks: [],
    hookSecrets: new Map(),
    aiLog: [],
    /** Statuses webhooks we sent back to the app. */
    statusLog: [],
    settings: {
      holdStatuses: false,
      // Accepted by the API, then reported `failed` (131026) via webhook.
      failDeliveryTo: new Set(["15550000999"]),
      // Rejected synchronously by the send API (131030).
      rejectSendTo: new Set(["15550000998"]),
    },
    media: new Map(),
    /** Business phone-number ids the app has looked up (one per test account). */
    knownNumbers: new Set(),
  };
}

let state = freshState();

const nextId = (prefix) => `${prefix}${Date.now().toString(36)}${(++state.seq).toString(36)}`;
const digits = (s) => String(s ?? "").replace(/\D/g, "");
const nowSec = () => String(Math.floor(Date.now() / 1000));

// ------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": isBuf ? "application/octet-stream" : typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
    "access-control-allow-origin": "*",
    ...headers,
  });
  res.end(payload);
}

const metaError = (res, status, message, code = 100, subcode) =>
  send(res, status, {
    error: { message, type: "OAuthException", code, error_subcode: subcode, fbtrace_id: nextId("Atrace") },
  });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function json(buf) {
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return {};
  }
}

// ------------------------------------------------------------
// Signed webhooks → app
// ------------------------------------------------------------

async function postToApp(payload) {
  const body = JSON.stringify(payload);
  const sig = createHmac("sha256", cfg.appSecret).update(body).digest("hex");
  try {
    const r = await fetch(cfg.appWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${sig}` },
      body,
    });
    return r.status;
  } catch (err) {
    console.error("[fakes] webhook to app failed:", err.message);
    return 0;
  }
}

const envelope = (field, value, entryId = cfg.wabaId) => ({
  object: "whatsapp_business_account",
  entry: [{ id: entryId, changes: [{ field, value }] }],
});

/** Any all-digits id is a valid fake business number (one per test account). */
const isPhoneNumberId = (id) => /^\d{6,20}$/.test(String(id ?? ""));
const displayFor = (phoneNumberId) =>
  phoneNumberId === cfg.phoneNumberId ? cfg.displayPhone : `+1 555-${String(phoneNumberId).slice(-7)}`;
const metadata = (phoneNumberId = cfg.phoneNumberId) => ({
  display_phone_number: digits(displayFor(phoneNumberId)),
  phone_number_id: phoneNumberId,
});

function sendStatus(messageId, recipient, status, errors) {
  const st = { id: messageId, status, timestamp: nowSec(), recipient_id: recipient };
  if (errors) st.errors = errors;
  state.statusLog.push({ at: Date.now(), ...st });
  const out = state.outbound.find((m) => m.id === messageId);
  if (out) out.status = status;
  return postToApp(
    envelope("messages", { messaging_product: "whatsapp", metadata: metadata(out?.phoneNumberId), statuses: [st] }),
  );
}

function scheduleStatuses(messageId, to) {
  if (state.settings.holdStatuses) return;
  const d = cfg.statusDelayMs;
  if (state.settings.failDeliveryTo.has(to)) {
    setTimeout(
      () =>
        void sendStatus(messageId, to, "failed", [
          {
            code: 131026,
            title: "Message undeliverable",
            message: "Message undeliverable",
            error_data: { details: "Receiver is incapable of receiving this message (fake)." },
          },
        ]),
      d,
    );
    return;
  }
  setTimeout(() => void sendStatus(messageId, to, "sent"), d);
  setTimeout(() => void sendStatus(messageId, to, "delivered"), d * 2);
}

// ------------------------------------------------------------
// Fake Graph API
// ------------------------------------------------------------

function authorized(req) {
  const auth = req.headers.authorization ?? "";
  const token = auth.replace(/^(Bearer|OAuth)\s+/i, "") || new URL(req.url, "http://x").searchParams.get("access_token");
  if (!token) return { ok: false, code: 190, message: "An access token is required to request this resource." };
  if (token === "bad-token") return { ok: false, code: 190, message: "Invalid OAuth access token - Cannot parse access token" };
  return { ok: true };
}

async function handleGraph(req, res, parts, url) {
  // parts: path segments after /v21.0
  const auth = authorized(req);
  if (!auth.ok) return metaError(res, 401, auth.message, auth.code);
  const [a, b] = parts;
  const method = req.method;

  // GET /{phone_number_id}?fields=...
  if (method === "GET" && parts.length === 1 && isPhoneNumberId(a) && !state.media.has(a)) {
    state.knownNumbers.add(a);
    return send(res, 200, {
      id: a,
      display_phone_number: displayFor(a),
      verified_name: cfg.verifiedName,
      quality_rating: "GREEN",
    });
  }
  // GET /{media_id}
  if (method === "GET" && parts.length === 1 && state.media.has(a)) {
    const m = state.media.get(a);
    return send(res, 200, {
      url: `${cfg.internalUrl}/media/${a}`,
      mime_type: m.mime,
      file_size: m.bytes.length,
      sha256: createHash("sha256").update(m.bytes).digest("hex"),
      id: a,
      messaging_product: "whatsapp",
    });
  }
  // POST /{phone}/register
  if (method === "POST" && b === "register") return send(res, 200, { success: true });
  // GET|POST /{waba}/subscribed_apps
  if (b === "subscribed_apps") {
    if (method === "POST") return send(res, 200, { success: true });
    return send(res, 200, {
      data: [{ whatsapp_business_api_data: { id: cfg.appId, name: "Fake App", link: "https://example.com" } }],
    });
  }
  // GET /{waba}/phone_numbers
  if (method === "GET" && b === "phone_numbers") {
    return send(res, 200, {
      data: [cfg.phoneNumberId, ...state.knownNumbers].map((id) => ({
        id,
        display_phone_number: displayFor(id),
        verified_name: cfg.verifiedName,
      })),
    });
  }
  // Templates on the WABA
  if (b === "message_templates") {
    // Fixtures (no wabaId) belong to every WABA; submitted ones to their own.
    if (method === "GET") return send(res, 200, { data: state.templates.filter((t) => !t.wabaId || t.wabaId === a) });
    if (method === "POST") {
      const body = json(await readBody(req));
      const tpl = {
        wabaId: a,
        id: String(700000000000100 + ++templateSeq),
        name: body.name,
        language: body.language,
        status: "PENDING",
        category: body.category,
        components: body.components ?? [],
      };
      state.templates.push(tpl);
      // Meta reviews it and reports back through the webhook.
      setTimeout(() => {
        tpl.status = "APPROVED";
        void postToApp(
          envelope(
            "message_template_status_update",
            {
              event: "APPROVED",
              message_template_id: Number(tpl.id),
              message_template_name: tpl.name,
              message_template_language: tpl.language,
              reason: "NONE",
            },
            tpl.wabaId,
          ),
        );
      }, 1500);
      return send(res, 200, { id: tpl.id, status: "PENDING", category: tpl.category });
    }
    if (method === "DELETE") {
      const name = url.searchParams.get("name");
      state.templates = state.templates.filter((t) => t.name !== name);
      return send(res, 200, { success: true });
    }
  }
  // Resumable upload: POST /{app_id}/uploads → { id: "upload:..." }
  if (method === "POST" && b === "uploads") return send(res, 200, { id: nextId("upload:") });
  // Resumable upload step 2: POST /upload:xyz → { h }
  if (method === "POST" && parts.length === 1 && a.startsWith("upload:")) {
    await readBody(req);
    return send(res, 200, { h: `4::${nextId("fakehandle")}` });
  }
  // POST /{phone}/messages
  if (method === "POST" && b === "messages" && isPhoneNumberId(a)) {
    const body = json(await readBody(req));
    // Typing indicator / mark-as-read.
    if (body.status === "read") return send(res, 200, { success: true });
    const to = digits(body.to ?? body.recipient);
    if (!to) return metaError(res, 400, "(#100) The parameter to is required.", 100);
    // The app retries 131030 with trunk-prefix variants of the number
    // (phoneVariants), so reject those too: compare with zeros stripped.
    const noZeros = (n) => n.replace(/0/g, "");
    if ([...state.settings.rejectSendTo].some((r) => noZeros(r) === noZeros(to))) {
      return metaError(res, 400, "(#131030) Recipient phone number not in allowed list", 131030);
    }
    const id = `wamid.FAKE${nextId("")}`;
    state.outbound.push({ id, at: Date.now(), to, phoneNumberId: a, type: body.type, body, status: "accepted" });
    if (body.type !== "reaction") scheduleStatuses(id, to);
    return send(res, 200, {
      messaging_product: "whatsapp",
      contacts: [{ input: to, wa_id: to }],
      messages: [{ id }],
    });
  }
  // Template edit: POST /{template_id}
  if (method === "POST" && parts.length === 1 && state.templates.some((t) => t.id === a)) {
    const body = json(await readBody(req));
    const tpl = state.templates.find((t) => t.id === a);
    if (body.components) tpl.components = body.components;
    return send(res, 200, { success: true });
  }
  return metaError(res, 404, `Unsupported ${method} request. Object with ID '${a}' does not exist (fake).`, 100, 33);
}

// ------------------------------------------------------------
// Customer simulator
// ------------------------------------------------------------

function registerMedia(kind, opts = {}) {
  const id = `9${Date.now()}${++state.seq}`;
  const presets = {
    image: { mime: "image/png", bytes: samplePng() },
    document: { mime: "application/pdf", bytes: samplePdf(), filename: opts.filename ?? "invoice.pdf" },
    audio: { mime: "audio/ogg", bytes: sampleOgg() },
    video: { mime: "video/mp4", bytes: Buffer.from("fake mp4 bytes") },
  };
  const m = presets[kind] ?? presets.image;
  state.media.set(id, m);
  return { id, ...m };
}

/** Build + send one inbound message from a customer. */
async function simulateInbound(input) {
  const from = digits(input.from);
  if (!from) throw new Error("from is required");
  const name = input.name ?? state.customers.get(from) ?? `Customer ${from.slice(-4)}`;
  state.customers.set(from, name);
  const id = `wamid.IN${nextId("")}`;
  const msg = { from, id, timestamp: nowSec() };
  if (input.context_id) msg.context = { from: digits(cfg.displayPhone), id: input.context_id };

  if (input.button_reply) {
    msg.type = "interactive";
    msg.interactive = { type: "button_reply", button_reply: input.button_reply };
  } else if (input.list_reply) {
    msg.type = "interactive";
    msg.interactive = { type: "list_reply", list_reply: input.list_reply };
  } else if (input.button) {
    msg.type = "button";
    msg.button = { text: input.button.text, payload: input.button.payload ?? input.button.text };
  } else if (input.reaction) {
    msg.type = "reaction";
    msg.reaction = { message_id: input.reaction.message_id, emoji: input.reaction.emoji ?? "" };
  } else if (input.location) {
    msg.type = "location";
    msg.location = input.location;
  } else if (input.media) {
    const kind = input.media.kind ?? "image";
    const m = registerMedia(kind, input.media);
    msg.type = kind;
    msg[kind] = { id: m.id, mime_type: m.mime, sha256: "fake" };
    if (input.media.caption && kind !== "audio") msg[kind].caption = input.media.caption;
    if (kind === "document") msg[kind].filename = m.filename;
    if (kind === "audio") msg[kind].voice = true;
  } else {
    msg.type = "text";
    msg.text = { body: String(input.text ?? "") };
  }

  const phoneNumberId = input.phone_number_id ? String(input.phone_number_id) : cfg.phoneNumberId;
  state.inbound.push({ at: Date.now(), from, name, phoneNumberId, message: msg });
  const status = await postToApp(
    envelope("messages", {
      messaging_product: "whatsapp",
      metadata: metadata(phoneNumberId),
      contacts: [{ profile: { name }, wa_id: from }],
      messages: [msg],
    }),
  );
  return { id, status };
}

// ------------------------------------------------------------
// Fake AI providers
// ------------------------------------------------------------

function fakeReply(system, lastUser) {
  const text = String(lastUser ?? "");
  if (/\bhuman\b|\bagent\b|\bperson\b/i.test(text)) {
    return "[[HANDOFF]] Let me connect you with a member of our team.";
  }
  // Cite a knowledge line sharing a word (5+ letters) with the question.
  const words = new Set((text.toLowerCase().match(/[a-z]{5,}/g) ?? []));
  const line = String(system ?? "")
    .split(/\n+/)
    .map((l) => l.trim())
    .find((l) => l.length > 10 && (l.toLowerCase().match(/[a-z]{5,}/g) ?? []).some((w) => words.has(w)));
  return line ? `Fake AI: ${line}` : `Fake AI reply to: "${text.slice(0, 120)}"`;
}

function authOk(req) {
  const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || req.headers["x-api-key"];
  return Boolean(key) && key !== "bad-key";
}

/** Deterministic bag-of-words embedding (1536 dims, L2-normalised). */
function embed(text) {
  const v = new Array(1536).fill(0);
  for (const w of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const h = createHash("sha256").update(w).digest();
    v[h.readUInt16BE(0) % 1536] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

async function handleAi(req, res, provider, rest) {
  const body = json(await readBody(req));
  if (!authOk(req)) {
    return send(res, 401, { error: { message: "Incorrect API key provided (fake)", type: "invalid_request_error" } });
  }
  if (rest === "embeddings") {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    state.aiLog.push({ at: Date.now(), provider, kind: "embeddings", count: inputs.length });
    return send(res, 200, {
      object: "list",
      model: body.model,
      data: inputs.map((t, index) => ({ object: "embedding", index, embedding: embed(t) })),
      usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
    });
  }
  if (provider === "anthropic") {
    const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const content = typeof last?.content === "string" ? last.content : last?.content?.map((c) => c.text).join(" ");
    const reply = fakeReply(body.system, content);
    state.aiLog.push({ at: Date.now(), provider, model: body.model, prompt: content, reply });
    return send(res, 200, {
      id: nextId("msg_"),
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: reply }],
      usage: { input_tokens: 42, output_tokens: 17 },
    });
  }
  const msgs = body.messages ?? [];
  const system = msgs.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const last = [...msgs].reverse().find((m) => m.role === "user")?.content;
  const reply = fakeReply(system, last);
  state.aiLog.push({ at: Date.now(), provider, model: body.model, prompt: last, reply });
  return send(res, 200, {
    id: nextId("chatcmpl-"),
    object: "chat.completion",
    model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
    usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
  });
}

// ------------------------------------------------------------
// Webhook receiver
// ------------------------------------------------------------

function verifyWacrmSignature(secret, header, raw) {
  if (!secret || !header) return null;
  const parts = Object.fromEntries(String(header).split(",").map((p) => p.trim().split("=")));
  if (!parts.t || !parts.v1) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// Router
// ------------------------------------------------------------

const simulatorHtml = () => readFileSync(path.join(__dirname, "simulator.html"), "utf8");

function threadState() {
  const threads = [...state.customers.entries()].map(([phone, name]) => ({
    phone,
    name,
    messages: [
      ...state.inbound.filter((m) => m.from === phone).map((m) => ({ dir: "in", at: m.at, ...m.message })),
      ...state.outbound
        .filter((m) => m.to === phone)
        .map((m) => ({ dir: "out", at: m.at, id: m.id, status: m.status, type: m.type, body: m.body })),
    ].sort((x, y) => x.at - y.at),
  }));
  return {
    config: {
      phoneNumberId: cfg.phoneNumberId,
      wabaId: cfg.wabaId,
      displayPhone: cfg.displayPhone,
      appId: cfg.appId,
    },
    settings: {
      holdStatuses: state.settings.holdStatuses,
      failDeliveryTo: [...state.settings.failDeliveryTo],
      rejectSendTo: [...state.settings.rejectSendTo],
    },
    threads,
    hooks: state.hooks.slice(-100),
    aiLog: state.aiLog.slice(-100),
    templates: state.templates.map(({ id, name, language, status }) => ({ id, name, language, status })),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://fakes");
  const p = url.pathname;
  try {
    if (req.method === "OPTIONS") {
      return send(res, 204, "", {
        "access-control-allow-methods": "GET,POST,PUT,DELETE",
        "access-control-allow-headers": "content-type",
      });
    }
    if (p === "/" || p === "/index.html") return send(res, 200, simulatorHtml());
    if (p === "/health") return send(res, 200, { ok: true });

    if (p.startsWith("/v21.0/")) {
      return await handleGraph(req, res, p.slice("/v21.0/".length).split("/").map(decodeURIComponent), url);
    }
    if (p.startsWith("/media/")) {
      const m = state.media.get(p.slice("/media/".length));
      if (!m) return send(res, 404, { error: "no such media" });
      return send(res, 200, m.bytes, { "content-type": m.mime });
    }

    // --- AI ---
    const ai = /^\/(openai|anthropic|compat)\/v1\/(chat\/completions|embeddings|messages)$/.exec(p);
    if (ai && req.method === "POST") {
      return await handleAi(req, res, ai[1], ai[2] === "embeddings" ? "embeddings" : "chat");
    }
    if (p === "/__ai/log") return send(res, 200, state.aiLog);

    // --- Simulator ---
    if (p === "/__sim/state") return send(res, 200, threadState());
    if (p === "/__sim/outbound") {
      const to = url.searchParams.get("to");
      const pn = url.searchParams.get("phone_number_id");
      return send(
        res,
        200,
        state.outbound.filter((m) => (!to || m.to === digits(to)) && (!pn || m.phoneNumberId === pn)),
      );
    }
    if (p === "/__sim/inbound" && req.method === "GET") return send(res, 200, state.inbound);
    if (p === "/__sim/inbound" && req.method === "POST") {
      return send(res, 200, await simulateInbound(json(await readBody(req))));
    }
    if (p === "/__sim/customers" && req.method === "POST") {
      const body = json(await readBody(req));
      state.customers.set(digits(body.phone), body.name || `Customer ${digits(body.phone).slice(-4)}`);
      return send(res, 200, { ok: true });
    }
    if (p === "/__sim/status" && req.method === "POST") {
      const body = json(await readBody(req));
      const msg = state.outbound.find((m) => m.id === body.message_id);
      if (!msg) return send(res, 404, { error: "unknown message_id" });
      const errors = body.status === "failed" ? [{ code: 131026, title: "Message undeliverable", error_data: { details: "Simulated failure" } }] : undefined;
      return send(res, 200, { status: await sendStatus(msg.id, msg.to, body.status, errors) });
    }
    if (p === "/__sim/template-status" && req.method === "POST") {
      const body = json(await readBody(req));
      const status = await postToApp(
        envelope("message_template_status_update", {
          event: body.event ?? "APPROVED",
          message_template_id: Number(body.template_id),
          message_template_name: body.name,
          message_template_language: body.language ?? "en_US",
          reason: body.reason ?? "NONE",
        }, body.waba_id ?? cfg.wabaId),
      );
      return send(res, 200, { status });
    }
    if (p === "/__sim/settings" && req.method === "POST") {
      const body = json(await readBody(req));
      if (typeof body.holdStatuses === "boolean") state.settings.holdStatuses = body.holdStatuses;
      if (Array.isArray(body.failDeliveryTo)) state.settings.failDeliveryTo = new Set(body.failDeliveryTo.map(digits));
      if (Array.isArray(body.rejectSendTo)) state.settings.rejectSendTo = new Set(body.rejectSendTo.map(digits));
      return send(res, 200, threadState().settings);
    }

    // --- Webhook receiver ---
    const hook = /^\/__hooks\/([A-Za-z0-9_-]+)(\/secret)?$/.exec(p);
    if (hook && hook[2] && req.method === "PUT") {
      state.hookSecrets.set(hook[1], json(await readBody(req)).secret);
      return send(res, 200, { ok: true });
    }
    if (hook && !hook[2] && req.method === "POST") {
      const raw = (await readBody(req)).toString("utf8");
      state.hooks.push({
        at: Date.now(),
        name: hook[1],
        event: req.headers["x-wacrm-event"] ?? null,
        webhookId: req.headers["x-wacrm-webhook-id"] ?? null,
        signatureValid: verifyWacrmSignature(state.hookSecrets.get(hook[1]), req.headers["x-wacrm-signature"], raw),
        body: json(Buffer.from(raw)),
        headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(host|connection)$/.test(k))),
      });
      return send(res, 200, { received: true });
    }
    if (p === "/__hooks" && req.method === "GET") {
      const name = url.searchParams.get("name");
      return send(res, 200, state.hooks.filter((h) => !name || h.name === name));
    }

    if (p === "/__reset" && req.method === "POST") {
      state = freshState();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: `fakes: no route for ${req.method} ${p}` });
  } catch (err) {
    console.error("[fakes] error:", err);
    return send(res, 500, { error: err.message });
  }
});

server.listen(cfg.port, () => {
  console.log(`[fakes] listening on :${cfg.port} (app webhook → ${cfg.appWebhookUrl})`);
});
