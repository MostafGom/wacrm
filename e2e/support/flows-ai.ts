// Helpers shared by the Flows (09) and AI (10) specs.

import { expect } from "@playwright/test";

import { api, type TestUser } from "./accounts";
import { fakes, type InboundInput, type OutboundMessage } from "./fakes";

const digits = (s: string) => s.replace(/\D/g, "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The account's conversation with `phone` (polls until the webhook has created it). */
export async function conversationFor(user: TestUser, phone: string): Promise<Json> {
  let found: Json = null;
  await expect
    .poll(
      async () => {
        const r = await api(user, "GET", "/api/conversations");
        found = (r.body.conversations ?? []).find(
          (c: Json) => digits(c.contact?.phone ?? "") === digits(phone),
        );
        return Boolean(found);
      },
      { message: `conversation with ${phone}` },
    )
    .toBe(true);
  return found;
}

/** Fresh read of one conversation row. */
export async function getConversation(user: TestUser, id: string): Promise<Json> {
  const r = await api(user, "GET", `/api/conversations/${id}`);
  expect(r.status).toBe(200);
  return r.body.conversation;
}

/**
 * "The app has finished processing this inbound" barrier.
 *
 * The WhatsApp webhook fires the public `message.received` webhook as
 * the very LAST step of inbound processing — after the flow runner,
 * automations and the AI auto-reply. Registering an endpoint on the
 * fake receiver lets a test wait for that delivery and then assert that
 * something did NOT happen (no flow reply, no AI reply) without sleeps.
 */
export async function processingBarrier(admin: TestUser, label: string) {
  const name = `${label}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
  const key = await api(admin, "POST", "/api/account/api-keys", { name: `barrier ${name}`, scopes: ["webhooks:manage"] });
  expect(key.status, JSON.stringify(key.body)).toBe(201);
  const hook = await api(
    null,
    "POST",
    "/api/v1/webhooks",
    { url: fakes.hookUrl(name), events: ["message.received"] },
    { authorization: `Bearer ${key.body.plaintext}` },
  );
  expect(hook.status, JSON.stringify(hook.body)).toBeLessThan(300);

  return {
    /** Wait until the app has fully processed the inbound with this Meta id. */
    async processed(waMessageId: string) {
      await fakes.waitForHooks(name, (h) => h.body?.data?.whatsapp_message_id === waMessageId);
    },
    /** Customer sends a message and the test waits for it to be fully processed. */
    async send(input: InboundInput) {
      const { id } = await fakes.inbound(input);
      await this.processed(id);
      return id;
    },
  };
}

export type Barrier = Awaited<ReturnType<typeof processingBarrier>>;

// ---- outbound predicates --------------------------------------------

export const isButtons = (m: OutboundMessage) => m.type === "interactive" && m.body.interactive?.type === "button";
export const isList = (m: OutboundMessage) => m.type === "interactive" && m.body.interactive?.type === "list";
export const isText = (re: RegExp | string) => (m: OutboundMessage) =>
  m.type === "text" && (typeof re === "string" ? m.body.text?.body === re : re.test(m.body.text?.body ?? ""));

/** Count of outbound messages to `to` matching `predicate`. */
export async function outboundCount(
  filter: { to?: string; phoneNumberId?: string },
  predicate: (m: OutboundMessage) => boolean = () => true,
): Promise<number> {
  return (await fakes.outbound(filter)).filter(predicate).length;
}
