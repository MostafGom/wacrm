// Client for the fake services (e2e/fakes/server.mjs).

import { expect } from "@playwright/test";

import { FAKES_URL } from "./env";

export interface OutboundMessage {
  id: string;
  at: number;
  to: string;
  phoneNumberId: string;
  type: string;
  status: string;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface HookDelivery {
  at: number;
  name: string;
  event: string | null;
  signatureValid: boolean | null;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string>;
}

async function call<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await fetch(`${FAKES_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`fakes ${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const digits = (s: string) => s.replace(/\D/g, "");

/** A unique fake customer number (+1 555 2xx xxxx) — never collides with the specials. */
export function randomCustomerPhone(): string {
  return `+1555${String(2000000 + Math.floor(Math.random() * 7999999)).padStart(7, "0")}`;
}

/** A unique fake business phone-number id (one per test account). */
export function randomPhoneNumberId(): string {
  return `1${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1e5)
    .toString()
    .padStart(5, "0")}`;
}

export interface InboundInput {
  from: string;
  name?: string;
  /** Which business number (whatsapp_config.phone_number_id) receives it. */
  phone_number_id: string;
  text?: string;
  button_reply?: { id: string; title: string };
  list_reply?: { id: string; title: string; description?: string };
  button?: { text: string; payload?: string };
  reaction?: { message_id: string; emoji: string };
  location?: { latitude: number; longitude: number; name?: string };
  media?: { kind: "image" | "document" | "audio" | "video"; caption?: string; filename?: string };
  context_id?: string;
}

export const fakes = {
  /** The customer sends a message (signed Meta webhook → app). */
  async inbound(input: InboundInput): Promise<{ id: string }> {
    const r = await call<{ id: string; status: number }>("/__sim/inbound", input);
    expect(r.status, "app webhook should accept the signed delivery").toBe(200);
    return { id: r.id };
  },

  outbound(filter: { to?: string; phoneNumberId?: string } = {}): Promise<OutboundMessage[]> {
    const q = new URLSearchParams();
    if (filter.to) q.set("to", digits(filter.to));
    if (filter.phoneNumberId) q.set("phone_number_id", filter.phoneNumberId);
    return call(`/__sim/outbound?${q}`);
  },

  /** Wait until the business has sent `count` messages matching `predicate`. */
  async waitForOutbound(
    filter: { to?: string; phoneNumberId?: string },
    predicate: (m: OutboundMessage) => boolean = () => true,
    count = 1,
    timeout = 20_000,
  ): Promise<OutboundMessage[]> {
    let found: OutboundMessage[] = [];
    await expect
      .poll(
        async () => {
          found = (await fakes.outbound(filter)).filter(predicate);
          return found.length;
        },
        { timeout, message: `waiting for ${count} outbound message(s) to ${filter.to ?? filter.phoneNumberId}` },
      )
      .toBeGreaterThanOrEqual(count);
    return found;
  },

  setStatus(messageId: string, status: "sent" | "delivered" | "read" | "failed") {
    return call("/__sim/status", { message_id: messageId, status });
  },

  templateStatus(input: { template_id: string; name: string; language: string; event: string; waba_id: string }) {
    return call("/__sim/template-status", input);
  },

  settings(input: { holdStatuses?: boolean; failDeliveryTo?: string[]; rejectSendTo?: string[] }) {
    return call("/__sim/settings", input);
  },

  setHookSecret(name: string, secret: string) {
    return call(`/__hooks/${name}/secret`, { secret }, "PUT");
  },

  hooks(name: string): Promise<HookDelivery[]> {
    return call(`/__hooks?name=${encodeURIComponent(name)}`);
  },

  async waitForHooks(name: string, predicate: (h: HookDelivery) => boolean, count = 1, timeout = 20_000) {
    let found: HookDelivery[] = [];
    await expect
      .poll(
        async () => {
          found = (await fakes.hooks(name)).filter(predicate);
          return found.length;
        },
        { timeout, message: `waiting for webhook deliveries to ${name}` },
      )
      .toBeGreaterThanOrEqual(count);
    return found;
  },

  aiLog(): Promise<Array<{ provider: string; prompt?: string; reply?: string; kind?: string }>> {
    return call("/__ai/log");
  },

  /** Base URL the app should use for the OpenAI-compatible fake. */
  aiCompatBaseUrl: "http://fakes:4010/compat/v1",
  /** Webhook URL (as the app sees it) for a named receiver. */
  hookUrl: (name: string) => `http://fakes:4010/__hooks/${name}`,
};
