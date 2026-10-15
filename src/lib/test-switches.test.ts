// The env switches that point the app at local fakes for end-to-end
// testing (docker-compose.e2e.yml). Unset → production behaviour.

import { afterEach, describe, expect, it, vi } from "vitest";

import { metaApiBase } from "@/lib/whatsapp/meta-api";
import { normalizeWebhookUrl } from "@/lib/webhooks/endpoints";
import { isDeliverableUrl, webhookAllowedPrivateHosts } from "@/lib/webhooks/ssrf";

const ENV_KEYS = ["META_GRAPH_BASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "WEBHOOK_ALLOWED_PRIVATE_HOSTS"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("META_GRAPH_BASE_URL", () => {
  it("defaults to the real Graph API", () => {
    delete process.env.META_GRAPH_BASE_URL;
    expect(metaApiBase()).toBe("https://graph.facebook.com/v21.0");
  });

  it("can point at a fake, without a trailing slash", () => {
    process.env.META_GRAPH_BASE_URL = "http://fakes:4010/v21.0/";
    expect(metaApiBase()).toBe("http://fakes:4010/v21.0");
  });
});

describe("OPENAI_BASE_URL / ANTHROPIC_BASE_URL", () => {
  async function urlCalledBy(run: () => Promise<unknown>): Promise<string> {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 500 }),
    );
    await run().catch(() => {});
    return String(fetchSpy.mock.calls[0]?.[0]);
  }

  it("default to the real providers and follow the overrides", async () => {
    const { generateOpenAi: generateOpenAI } = await import("@/lib/ai/providers/openai");
    const { generateAnthropic } = await import("@/lib/ai/providers/anthropic");
    const callOpenAI = () =>
      generateOpenAI({ apiKey: "k", model: "m", systemPrompt: "s", messages: [{ role: "user", content: "hi" }], timeoutMs: 1000 } as never);
    const callAnthropic = () =>
      generateAnthropic({ apiKey: "k", model: "m", systemPrompt: "s", messages: [{ role: "user", content: "hi" }], timeoutMs: 1000 } as never);

    delete process.env.OPENAI_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    expect(await urlCalledBy(callOpenAI)).toBe("https://api.openai.com/v1/chat/completions");
    vi.restoreAllMocks();
    expect(await urlCalledBy(callAnthropic)).toBe("https://api.anthropic.com/v1/messages");
    vi.restoreAllMocks();

    process.env.OPENAI_BASE_URL = "http://fakes:4010/openai/v1";
    process.env.ANTHROPIC_BASE_URL = "http://fakes:4010/anthropic/v1";
    expect(await urlCalledBy(callOpenAI)).toBe("http://fakes:4010/openai/v1/chat/completions");
    vi.restoreAllMocks();
    expect(await urlCalledBy(callAnthropic)).toBe("http://fakes:4010/anthropic/v1/messages");
  });
});

describe("WEBHOOK_ALLOWED_PRIVATE_HOSTS", () => {
  it("is empty by default: private hosts and http stay blocked", async () => {
    delete process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS;
    expect(webhookAllowedPrivateHosts().size).toBe(0);
    expect(await isDeliverableUrl("http://fakes:4010/__hooks/a", { allowPrivateHosts: webhookAllowedPrivateHosts() })).toBe(false);
    expect(normalizeWebhookUrl("http://fakes:4010/__hooks/a")).toBeNull();
    expect(normalizeWebhookUrl("https://example.com/hook")).toBe("https://example.com/hook");
  });

  it("allows exactly the listed hosts (and http to them)", async () => {
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = " Fakes , 10.0.0.5";
    const hosts = webhookAllowedPrivateHosts();
    expect(await isDeliverableUrl("http://fakes:4010/__hooks/a", { allowPrivateHosts: hosts })).toBe(true);
    expect(await isDeliverableUrl("http://10.0.0.5/x", { allowPrivateHosts: hosts })).toBe(true);
    expect(await isDeliverableUrl("http://10.0.0.6/x", { allowPrivateHosts: hosts })).toBe(false);
    expect(normalizeWebhookUrl("http://fakes:4010/__hooks/a")).toBe("http://fakes:4010/__hooks/a");
    expect(normalizeWebhookUrl("http://other:4010/hook")).toBeNull();
  });
});
