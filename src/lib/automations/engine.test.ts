import { describe, it, expect, beforeEach, vi } from "vitest";

// The engine talks to the database only through repository modules, run
// under asService. Those modules are replaced by an in-memory fake that
// applies the same predicates the SQL does (account scoping, status
// gates, branch scopes), so the regressions below assert on what the
// engine actually asked the database to do.
const h = vi.hoisted(() => {
  const state = {
    owned: null as { id: string } | null,
    ownedCustomField: null as { id: string } | null,
    /** Conversation the account-scoped lookups resolve. */
    ownedConversation: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    /** Contact-column writes: [accountId, contactId, field, value]. */
    contactUpdates: [] as unknown[][],
    upsertCalls: [] as { contact_id: string; custom_field_id: string; value: string }[],
    logInserts: [] as Record<string, unknown>[],
    /** Each log patch, minus appended steps (status / error_message). */
    logUpdates: [] as Record<string, unknown>[],
    // automation_pending_executions rows, mutated in place by updates.
    pending: [] as Record<string, unknown>[],
  };

  const byPosition = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    (a.position as number) - (b.position as number);

  const automations = {
    getAutomation: vi.fn(async (_db: unknown, accountId: string, id: string) =>
      state.automations.find((a) => a.id === id && a.account_id === accountId),
    ),
    listActiveAutomationsForTrigger: vi.fn(async (_db: unknown, accountId: string, triggerType: string) =>
      state.automations.filter(
        (a) => a.account_id === accountId && a.trigger_type === triggerType && a.is_active,
      ),
    ),
    listScopeSteps: vi.fn(
      async (
        _db: unknown,
        automationId: string,
        scope: { parentStepId: string | null; branch: string | null; startPosition: number },
      ) =>
        state.steps
          .filter(
            (s) =>
              s.automation_id === automationId &&
              (s.position as number) >= scope.startPosition &&
              (scope.parentStepId === null
                ? (s.parent_step_id ?? null) === null
                : s.parent_step_id === scope.parentStepId && s.branch === (scope.branch ?? "yes")),
          )
          .sort(byPosition),
    ),
    getStepPlacement: vi.fn(async (_db: unknown, automationId: string, stepId: string) => {
      const s = state.steps.find((x) => x.id === stepId && x.automation_id === automationId);
      return s
        ? { id: s.id, parent_step_id: s.parent_step_id ?? null, branch: s.branch ?? null, position: s.position }
        : undefined;
    }),
    incrementAutomationExecutionCount: vi.fn(async () => {}),
  };

  const runs = {
    insertAutomationLog: vi.fn(async (_db: unknown, values: Record<string, unknown>) => {
      state.logInserts.push({ ...values, steps_executed: [] });
      return { id: "log1" };
    }),
    updateAutomationLog: vi.fn(
      async (_db: unknown, _accountId: string, _logId: string, patch: Record<string, unknown>) => {
        const { appendSteps: _appended, ...rest } = patch;
        void _appended;
        state.logUpdates.push(rest);
      },
    ),
    insertPendingExecution: vi.fn(async (_db: unknown, values: Record<string, unknown>) => {
      const row = {
        id: `p${state.pending.length + 1}`,
        created_at: new Date(Date.now() + state.pending.length).toISOString(),
        ...values,
      };
      state.pending.push(row);
      return { id: row.id };
    }),
    supersedeAwaitingReplies: vi.fn(async (_db: unknown, accountId: string, contactId: string | null) => {
      for (const p of state.pending) {
        if (p.account_id === accountId && p.contact_id === contactId && p.status === "awaiting_reply") {
          p.status = "superseded";
        }
      }
    }),
    findAwaitingReply: vi.fn(async (_db: unknown, accountId: string, contactId: string, now: Date) =>
      state.pending
        .filter(
          (p) =>
            p.account_id === accountId &&
            p.contact_id === contactId &&
            p.status === "awaiting_reply" &&
            (p.run_at as string) > now.toISOString(),
        )
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0],
    ),
    claimPendingExecution: vi.fn(async (_db: unknown, id: string, from: string) => {
      const p = state.pending.find((x) => x.id === id && x.status === from);
      if (!p) return false;
      p.status = "running";
      return true;
    }),
    setPendingExecutionStatus: vi.fn(async (_db: unknown, accountId: string, id: string, status: string) => {
      const p = state.pending.find((x) => x.id === id && x.account_id === accountId);
      if (p) p.status = status;
    }),
    expireAwaitingReplyRows: vi.fn(async (_db: unknown, now: Date) => {
      const hit = state.pending.filter(
        (p) => p.status === "awaiting_reply" && (p.run_at as string) <= now.toISOString(),
      );
      hit.forEach((p) => (p.status = "expired"));
      return hit.map((p) => ({ id: p.id, account_id: p.account_id, log_id: p.log_id ?? null }));
    }),
  };

  const data = {
    contactInAccount: vi.fn(async () => Boolean(state.owned)),
    conversationInAccount: vi.fn(async () => Boolean(state.ownedConversation)),
    findConversationIdForContact: vi.fn(async () => state.ownedConversation?.id ?? null),
    customFieldInAccount: vi.fn(async () => Boolean(state.ownedCustomField)),
    getContactFieldValue: vi.fn(async () => undefined),
    contactHasTag: vi.fn(async () => false),
    deleteContactTag: vi.fn(async () => {}),
    updateContactField: vi.fn(async (...args: unknown[]) => {
      state.contactUpdates.push(args.slice(1));
    }),
    upsertContactCustomValue: vi.fn(
      async (_db: unknown, _accountId: string, contactId: string, customFieldId: string, value: string) => {
        state.upsertCalls.push({ contact_id: contactId, custom_field_id: customFieldId, value });
      },
    ),
    assignContactConversations: vi.fn(async () => {}),
    closeContactConversations: vi.fn(async () => {}),
    firstAccountMemberUserId: vi.fn(async () => null),
    getAccountDefaultCurrency: vi.fn(async () => "USD"),
    insertDeal: vi.fn(async () => {}),
  };

  return { state, automations, runs, data };
});

vi.mock("@/server/db", async () => (await import("@/test/auth-mocks")).dbModule());
vi.mock("@/server/repos/automations", () => h.automations);
vi.mock("@/server/repos/automation-runs", () => h.runs);
vi.mock("@/server/repos/engine-data", () => h.data);

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
}));

import {
  expireAwaitingReplies,
  resumeAwaitingReply,
  runAutomationsForTrigger,
  triggerMatches,
} from "./engine";
import { engineSendInteractive, engineSendText } from "./meta-send";
import type { Automation, KeywordMatchTriggerConfig } from "@/types";

const ACCOUNT = "acct-1";

beforeEach(() => {
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.ownedConversation = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.contactUpdates = [];
  h.state.upsertCalls = [];
  h.state.logInserts = [];
  h.state.logUpdates = [];
  h.state.pending = [];
  vi.clearAllMocks();
});

describe("runAutomationsForTrigger — tenant isolation", () => {
  it("refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)", async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "victim-contact-uuid",
      context: { message_text: "manual trigger" },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.data.contactInAccount).toHaveBeenCalledWith(expect.anything(), ACCOUNT, "victim-contact-uuid");
    expect(h.automations.listActiveAutomationsForTrigger).not.toHaveBeenCalled();
    expect(h.state.contactUpdates).toHaveLength(0);
  });

  it("proceeds past the guard when the contact belongs to the account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.automations.listActiveAutomationsForTrigger).toHaveBeenCalled();
  });

  it("refuses a caller-supplied conversation_id from another account (GHSA-m4fx-g6pr-hrw8)", async () => {
    // POST /api/automations/engine copies `body.context` verbatim into
    // the run, so this id is attacker-controlled. The contact is the
    // caller's own — only the conversation is foreign, which is exactly
    // what made this a cross-tenant message-injection primitive.
    h.state.owned = { id: "c1" };
    h.state.ownedConversation = null; // not in this account
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "victim-conversation-uuid" },
    });

    expect(h.data.conversationInAccount).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT,
      "victim-conversation-uuid",
    );
    expect(h.automations.listActiveAutomationsForTrigger).not.toHaveBeenCalled();
    expect(h.state.contactUpdates).toHaveLength(0);
  });

  it("proceeds when the conversation belongs to the account", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedConversation = { id: "conv-1" };
    h.state.automations = [];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    expect(h.automations.listActiveAutomationsForTrigger).toHaveBeenCalled();
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The write is keyed on both the contact and the automation's account.
    expect(h.state.contactUpdates).toEqual([[ACCOUNT, "c1", "company", "pwned-by-automation"]]);
  });
});

describe("automation_logs — status is seeded pessimistically (issue #409)", () => {
  it("writes the log row as 'failed' before any step runs", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The insert happens before execution, so a run killed mid-flight must
    // not leave behind a row that claims it succeeded.
    expect(h.state.logInserts).toHaveLength(1);
    expect(h.state.logInserts[0]).toMatchObject({
      status: "failed",
      steps_executed: [],
    });
  });

  it("still promotes the log to 'success' once the steps complete", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The seed is only a floor — the outermost scope still writes the real
    // verdict, so a completed run reports success as it always did.
    const withStatus = h.state.logUpdates.filter((u) => "status" in u);
    expect(withStatus.at(-1)).toMatchObject({ status: "success" });
  });
});

describe("update_contact_field — custom fields", () => {
  it("upserts contact_custom_values when the field is account-owned", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "Premium")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(h.state.contactUpdates).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0]).toEqual({
      contact_id: "c1",
      custom_field_id: "cf1",
      value: "Premium",
    });
  });

  it("interpolates {{ vars.* }} into the custom value", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "{{ vars.source }}")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { vars: { source: "WhatsApp Ad" } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].value).toBe("WhatsApp Ad");
  });

  it("refuses to write a custom field from another account", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:foreign-cf", "x")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.state.contactUpdates).toHaveLength(0);
  });
});

describe("send_webhook — SSRF guard (GHSA-8jqh-598v-rfxc)", () => {
  it("refuses a private / link-local destination and never calls fetch", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    // Aimed at the cloud metadata endpoint — the classic SSRF target.
    h.state.steps = [webhookStep("http://169.254.169.254/latest/meta-data/")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The automation matched and its steps were loaded (so we genuinely
    // reached the send_webhook case)...
    expect(h.automations.listScopeSteps).toHaveBeenCalled();
    // ...yet the guard blocked it before any outbound request left the box.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

function webhookStep(url: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "send_webhook",
    position: 0,
    parent_step_id: null,
    step_config: { url, headers: { "Metadata-Flavor": "Google" }, body_template: "{}" },
  };
}

function automationWithUpdateStep() {
  return {
    id: "a1",
    account_id: ACCOUNT,
    user_id: "u1",
    trigger_type: "new_message_received",
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field: "company", value: "pwned-by-automation" },
  };
}

function customStep(field: string, value: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}

describe("triggerMatches — interactive_reply", () => {
  function automation(reply_ids: string[]): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "menu step",
      trigger_type: "interactive_reply",
      trigger_config: { reply_ids },
      is_active: true,
      execution_count: 0,
      created_at: "",
      updated_at: "",
    };
  }

  it("matches when the tapped id is in reply_ids (exact)", () => {
    expect(
      triggerMatches(automation(["yes", "no"]), { interactive_reply_id: "yes" }),
    ).toBe(true);
  });

  it("does not match a different id", () => {
    expect(
      triggerMatches(automation(["yes"]), { interactive_reply_id: "maybe" }),
    ).toBe(false);
  });

  it("does not match on a substring (exact only)", () => {
    expect(
      triggerMatches(automation(["yes"]), { interactive_reply_id: "yes_please" }),
    ).toBe(false);
  });

  it("does not match when no reply id is present or config is empty", () => {
    expect(triggerMatches(automation(["yes"]), {})).toBe(false);
    expect(triggerMatches(automation([]), { interactive_reply_id: "yes" })).toBe(false);
  });
});

describe("triggerMatches — tag_added", () => {
  function automation(tagId?: string): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "tag follow-up",
      trigger_type: "tag_added",
      trigger_config: tagId ? { tag_id: tagId } : {},
      is_active: true,
      execution_count: 0,
      created_at: "",
      updated_at: "",
    };
  }

  it("matches only the exact tag id", () => {
    expect(triggerMatches(automation("tag-a"), { tag_id: "tag-a" })).toBe(true);
    expect(triggerMatches(automation("tag-a"), { tag_id: "tag-ab" })).toBe(false);
  });

  it("fails closed when the config or event tag is missing", () => {
    expect(triggerMatches(automation(), { tag_id: "tag-a" })).toBe(false);
    expect(triggerMatches(automation("tag-a"), {})).toBe(false);
    expect(triggerMatches(automation("tag-a"), undefined)).toBe(false);
  });
});

describe("tag_added — conversation policy", () => {
  it("records a clear failed step when the contact has no conversation", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [{
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "tag outreach",
      trigger_type: "tag_added",
      trigger_config: { tag_id: "tag-a" },
      is_active: true,
    }];
    h.state.steps = [{
      id: "s1",
      automation_id: "a1",
      step_type: "send_message",
      position: 0,
      parent_step_id: null,
      step_config: { text: "Hello" },
    }];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "tag-a" },
    });

    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({
      status: "failed",
      error_message: "tag_added automation cannot send: contact has no existing conversation",
    }));
  });
});

describe("triggerMatches — keyword_match", () => {
  function automation(
    cfg: Partial<KeywordMatchTriggerConfig> & { keywords: string[] },
  ): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "kw",
      trigger_type: "keyword_match",
      trigger_config: { match_type: "contains", ...cfg },
      is_active: true,
    } as unknown as Automation;
  }

  const on = (a: Automation, text: string) =>
    triggerMatches(a, { message_text: text });

  it("keeps `contains` as a raw substring test", () => {
    // Issue #409 asked for this to become word-boundary matching. It
    // deliberately did NOT change: existing automations relying on
    // substring behaviour ("cat" firing on "category") must keep working,
    // and `contains` is the builder's default. `word` is the opt-in fix.
    expect(on(automation({ keywords: ["k"] }), "thanks")).toBe(true);
    expect(on(automation({ keywords: ["cat"] }), "category")).toBe(true);
  });

  it("`word` matches only standalone words", () => {
    const a = automation({ keywords: ["k"], match_type: "word" });
    expect(on(a, "thanks")).toBe(false);
    expect(on(a, "k")).toBe(true);
    expect(on(a, "press k to continue")).toBe(true);
    expect(on(a, "press K!")).toBe(true);
  });

  it("`word` respects punctuation and line edges around the keyword", () => {
    const a = automation({ keywords: ["hi"], match_type: "word" });
    expect(on(a, "hi")).toBe(true);
    expect(on(a, "hi!")).toBe(true);
    expect(on(a, "(hi)")).toBe(true);
    expect(on(a, "say hi.")).toBe(true);
    expect(on(a, "this")).toBe(false);
    expect(on(a, "hiya")).toBe(false);
  });

  it("`word` handles a keyword that itself carries punctuation", () => {
    // `\b` can't do this: /\bhi!\b/ demands a word char after the "!",
    // so it never matches. Hence the lookaround implementation.
    const a = automation({ keywords: ["hi!"], match_type: "word" });
    expect(on(a, "say hi!")).toBe(true);
    expect(on(a, "hi! there")).toBe(true);
  });

  it("`word` treats regex metacharacters in a keyword as literal", () => {
    // Account-supplied free text — an unescaped "(" would throw.
    const a = automation({ keywords: ["c++ (beginner)"], match_type: "word" });
    expect(on(a, "I want the c++ (beginner) course")).toBe(true);
    expect(on(a, "I want the cxx beginner course")).toBe(false);
    expect(() => on(automation({ keywords: ["("], match_type: "word" }), "(")).not.toThrow();
  });

  it("`word` is case-insensitive unless case_sensitive is set", () => {
    expect(on(automation({ keywords: ["Hi"], match_type: "word" }), "hi")).toBe(true);
    expect(
      on(
        automation({ keywords: ["Hi"], match_type: "word", case_sensitive: true }),
        "hi",
      ),
    ).toBe(false);
    expect(
      on(
        automation({ keywords: ["Hi"], match_type: "word", case_sensitive: true }),
        "Hi",
      ),
    ).toBe(true);
  });

  it("`word` finds a space-delimited keyword in a non-Latin script", () => {
    // ASCII `\b` fails outright here — every character of "안녕" is a
    // non-word character to it, so /\b안녕\b/ matches nothing.
    const a = automation({ keywords: ["안녕"], match_type: "word" });
    expect(on(a, "안녕")).toBe(true);
    expect(on(a, "저기 안녕 하세요")).toBe(true);
    // Documented limitation, not an accident: a language written without
    // spaces has no word edge inside a run of characters.
    expect(on(a, "안녕하세요")).toBe(false);
  });

  it("`exact` still requires the whole message to be the keyword", () => {
    const a = automation({ keywords: ["hi"], match_type: "exact" });
    expect(on(a, "hi")).toBe(true);
    expect(on(a, "hi there")).toBe(false);
  });

  it("ignores empty keywords and empty messages in `word` mode", () => {
    expect(on(automation({ keywords: [""], match_type: "word" }), "anything")).toBe(false);
    expect(on(automation({ keywords: ["hi"], match_type: "word" }), "")).toBe(false);
  });
});

// ------------------------------------------------------------
// wait_for_reply — park after Send Buttons / List, resume on reply
// ------------------------------------------------------------

describe("wait_for_reply", () => {
  function menuAutomation(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      trigger_type: "new_message_received",
      trigger_config: {},
      is_active: true,
      ...overrides,
    };
  }

  function step(
    id: string,
    step_type: string,
    position: number,
    step_config: Record<string, unknown>,
    parent?: { id: string; branch: "yes" | "no" },
  ) {
    return {
      id,
      automation_id: "a1",
      step_type,
      position,
      parent_step_id: parent?.id ?? null,
      branch: parent?.branch ?? null,
      step_config,
    };
  }

  const buttons = (wait: boolean) => ({
    kind: "buttons",
    body: "Which service?",
    buttons: [
      { id: "web", title: "Website" },
      { id: "mkt", title: "Marketing" },
    ],
    ...(wait ? { wait_for_reply: true } : {}),
  });
  const say = (text: string) => ({ text });
  const contains = (value: string) => ({
    subject: "message_content",
    operand: "contains",
    value,
  });

  // The user's menu: buttons, then branch on what was tapped, then a
  // closing root step after the condition.
  function userMenu(wait = true) {
    return [
      step("btn", "send_buttons", 0, buttons(wait)),
      step("cond", "condition", 1, contains("Website")),
      step("yes1", "send_message", 0, say("crm.stelltech.ai"), { id: "cond", branch: "yes" }),
      step("no1", "send_message", 0, say("Other options"), { id: "cond", branch: "no" }),
      step("after", "send_message", 2, say("Thanks for contacting")),
    ];
  }

  const sentTexts = () =>
    vi.mocked(engineSendText).mock.calls.map(([a]) => (a as { text: string }).text);

  async function trigger(text: string) {
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: text, conversation_id: "conv1" },
    });
  }

  function reply(text: string, interactive_reply_id?: string) {
    return resumeAwaitingReply({
      accountId: ACCOUNT,
      contactId: "c1",
      context: { message_text: text, conversation_id: "conv1", interactive_reply_id },
    });
  }

  beforeEach(() => {
    h.state.owned = { id: "c1" };
    h.state.ownedConversation = { id: "conv1" };
    h.state.automations = [menuAutomation()];
  });

  it("parks after the buttons instead of evaluating the condition on the trigger text", async () => {
    h.state.steps = userMenu();

    await trigger("Hii");

    expect(engineSendInteractive).toHaveBeenCalledTimes(1);
    // Neither branch nor the closing step ran yet.
    expect(engineSendText).not.toHaveBeenCalled();
    expect(h.state.pending).toHaveLength(1);
    const parked = h.state.pending[0];
    expect(parked).toMatchObject({
      status: "awaiting_reply",
      account_id: ACCOUNT,
      contact_id: "c1",
      parent_step_id: null,
      branch: null,
      next_step_position: 1,
    });
    const deadline = Date.parse(parked.run_at as string) - Date.now();
    expect(deadline).toBeGreaterThan(23.9 * 3_600_000);
    expect(deadline).toBeLessThanOrEqual(24 * 3_600_000);
    expect(h.state.logUpdates.at(-1)).toMatchObject({ status: "partial" });
  });

  it("resumes with the tapped button, so the condition takes the YES branch", async () => {
    h.state.steps = userMenu();
    await trigger("Hii");

    const consumed = await reply("Website", "web");

    expect(consumed).toBe(true);
    expect(sentTexts()).toEqual(["crm.stelltech.ai", "Thanks for contacting"]);
    expect(h.state.pending[0].status).toBe("done");
    expect(h.state.logUpdates.at(-1)).toMatchObject({ status: "success" });
  });

  it("routes a non-matching reply down the NO branch", async () => {
    h.state.steps = userMenu();
    await trigger("Hii");

    await reply("Marketing", "mkt");

    expect(sentTexts()).toEqual(["Other options", "Thanks for contacting"]);
  });

  it("hands the reply to steps after the wait as {{ message.text }}", async () => {
    h.state.steps = [
      step("btn", "send_buttons", 0, buttons(true)),
      step("echo", "send_message", 1, say("You picked {{ message.text }}")),
    ];
    await trigger("Hii");

    await reply("Website", "web");

    expect(sentTexts()).toEqual(["You picked Website"]);
  });

  it("stops the enclosing scopes when a branch parks, then climbs back out on resume", async () => {
    // Buttons inside the "Hii" YES branch, with a step after them in the
    // branch and another after the condition at the root.
    h.state.steps = [
      step("hii", "condition", 0, contains("Hii")),
      step("btn", "send_buttons", 0, buttons(true), { id: "hii", branch: "yes" }),
      step("inBranch", "send_message", 1, say("in branch"), { id: "hii", branch: "yes" }),
      step("atRoot", "send_message", 1, say("at root")),
    ];

    await trigger("Hii");
    // The root step after the condition must NOT have run ahead.
    expect(engineSendText).not.toHaveBeenCalled();
    expect(h.state.pending[0]).toMatchObject({
      parent_step_id: "hii",
      branch: "yes",
      next_step_position: 1,
    });

    await reply("anything");

    expect(sentTexts()).toEqual(["in branch", "at root"]);
    expect(h.state.logUpdates.at(-1)).toMatchObject({ status: "success" });
  });

  it("does not resume a run whose 24h deadline has passed", async () => {
    h.state.steps = userMenu();
    await trigger("Hii");
    h.state.pending[0].run_at = new Date(Date.now() - 1000).toISOString();

    const consumed = await reply("Website", "web");

    expect(consumed).toBe(false);
    expect(engineSendText).not.toHaveBeenCalled();
    expect(h.state.pending[0].status).toBe("awaiting_reply");
  });

  it("supersedes an older waiting run for the same contact", async () => {
    h.state.steps = userMenu();
    await trigger("Hii");
    await trigger("Hii");

    expect(h.state.pending.map((r) => r.status)).toEqual(["superseded", "awaiting_reply"]);
  });

  it("releases the message when the automation was paused while waiting", async () => {
    h.state.steps = userMenu();
    await trigger("Hii");
    h.state.automations = [menuAutomation({ is_active: false })];

    const consumed = await reply("Website", "web");

    expect(consumed).toBe(false);
    expect(engineSendText).not.toHaveBeenCalled();
    expect(h.state.pending[0].status).toBe("expired");
  });

  it("re-verifies the reply's conversation before sending (GHSA-m4fx-g6pr-hrw8)", async () => {
    h.state.steps = userMenu();
    await trigger("Hii");
    // The conversation no longer resolves inside this account.
    h.state.ownedConversation = null;

    await reply("Website", "web");

    expect(engineSendText).not.toHaveBeenCalled();
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ error_message: "conversation does not belong to this account" }),
    );
  });

  it("returns false when nothing is waiting for the contact", async () => {
    expect(await reply("hello")).toBe(false);
  });

  it("without the checkbox, keeps today's single-pass behaviour", async () => {
    h.state.steps = userMenu(false);

    await trigger("Hii");

    expect(h.state.pending).toHaveLength(0);
    // The condition ran immediately against "Hii" — the documented
    // single-pass semantics that wait_for_reply exists to opt out of.
    expect(sentTexts()).toEqual(["Other options", "Thanks for contacting"]);
  });

  it("expires lapsed waits and explains why on the log", async () => {
    h.state.steps = userMenu();
    await trigger("Hii");
    h.state.pending[0].run_at = new Date(Date.now() - 1000).toISOString();

    const expired = await expireAwaitingReplies();

    expect(expired).toBe(1);
    expect(h.state.pending[0].status).toBe("expired");
    expect(h.state.logUpdates.at(-1)).toEqual({ error_message: "no reply within 24h" });
  });
});
