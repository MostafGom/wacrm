/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT is ON CONFLICT DO NOTHING and the runner exits.
 *
 * Every DB step is its own short service-role transaction (asService),
 * so no connection is held across a Meta call.
 */

import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { asService, serviceRunner } from "@/server/db";
import {
  contactHasTag,
  findMessageIdByWaId,
  getContactFieldValue,
  handoffConversation,
} from "@/server/repos/engine-data";
import { getFlow, incrementFlowExecutionCount, listActiveFlows, listFlowNodes } from "@/server/repos/flows";
import {
  advanceRunNodeKey,
  endRun as endRunRow,
  getActiveRunForContact,
  hasReplyForMetaMessage,
  insertActiveRun,
  insertRunEvent,
  updateRun,
  type FlowRunEndStatus,
  type FlowRunEventType,
} from "@/server/repos/flow-runs";
import { removeContactTag } from "@/lib/contacts/tag-write";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from "./types";
import { matchesWholeWord } from "@/lib/keyword-match";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a DB / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact/whole-word match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "word") {
      if (matchesWholeWord(text, raw, cfg.case_sensitive)) return true;
      continue;
    }
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * The strings an inbound message offers to a flow's *entry* trigger.
 *
 * Typed text offers itself. A button / list tap offers two: the visible
 * title — what the customer would have typed had the button not been
 * there — and the stable reply_id, because the automation engine's
 * `interactive_reply` trigger routes on the id, so an author moving a
 * menu into a flow reaches for the same value.
 *
 * Matching the id does mean a keyword that happens to be a substring of
 * an id can fire (ids are author-controlled slugs, defaulting to
 * `btn_1`). That is the same substring semantic keyword triggers
 * already have for typed text, and the alternative — ignoring the id —
 * silently breaks the author who keyed on it.
 */
export function entryTriggerTexts(message: ParsedInbound): string[] {
  if (message.kind === "text") return [message.text];
  return [...new Set([message.reply_title, message.reply_id])].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

async function loadActiveRunForContact(
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one; the repo's LIMIT 1 is forgiving: pick the newest, let
  // the cron sweep clean up the stale one.
  try {
    return (await asService((db) => getActiveRunForContact(db, accountId, contactId))) ?? null;
  } catch (error) {
    console.error("[flows] loadActiveRunForContact error:", errorText(error));
    return null;
  }
}

async function loadFlow(
  accountId: string,
  flowId: string,
): Promise<FlowRow | null> {
  try {
    return (await asService((db) => getFlow(db, accountId, flowId))) ?? null;
  } catch (error) {
    console.error("[flows] loadFlow error:", errorText(error));
    return null;
  }
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  accountId: string,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  let rows: FlowNodeRow[];
  try {
    rows = await asService((db) => listFlowNodes(db, accountId, flowId));
  } catch (error) {
    console.error("[flows] loadAllNodes error:", errorText(error));
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of rows) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  flowRunId: string,
  event_type: FlowRunEventType,
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    await asService((db) =>
      insertRunEvent(db, { flow_run_id: flowRunId, event_type, node_key, payload }),
    );
  } catch (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", errorText(error));
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Across ALL of this contact's runs in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  return asService((db) => hasReplyForMetaMessage(db, accountId, contactId, metaMessageId));
}

async function findEntryFlow(
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<FlowRow | null> {
  // A tap used to be rejected outright here, on the reasoning that
  // interactive replies are responses to existing prompts. That holds
  // only while a prompt is outstanding — and this function runs solely
  // when the contact has NO active run, so there is nothing the tap
  // could be answering. What it actually blocked was issue #490: an
  // *automation* sends the buttons, the customer taps one, and the flow
  // whose keyword matches that button never starts. Retyping the label
  // by hand worked, which is the tell — same words, different envelope.
  const candidates = entryTriggerTexts(message);

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  let flows: FlowRow[];
  try {
    flows = await asService((db) => listActiveFlows(db, accountId));
  } catch {
    return null;
  }

  for (const flow of flows) {
    if (flow.trigger_type === "keyword") {
      const cfg = flow.trigger_config as KeywordTriggerConfig;
      if (candidates.some((text) => matchesKeywordTrigger(text, cfg))) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      // Also reachable by a tap now: a broadcast template with a
      // quick-reply button can genuinely be what prompts a contact's
      // first-ever inbound. The automations dispatcher has always
      // treated a tap that way (the webhook pushes
      // `first_inbound_message` regardless of envelope) — flows were
      // the inconsistent half.
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  // Every customer-visible string is interpolated against run.vars —
  // same treatment send_message / collect_input already get (#553).
  // `reply_id` is deliberately NOT interpolated: it is the routing key
  // matchReplyId compares the tapped button against, so it must reach
  // Meta byte-for-byte as authored. Interpolation can push a title past
  // Meta's 20-char cap; meta-api's validator throws a descriptive error
  // and the caller logs it — we never truncate silently.
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    buttons: cfg.buttons.map((b) => ({
      id: b.reply_id,
      title: interpolateVars(b.title, run.vars),
    })),
  });
  await logEvent(run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  await stashPromptMessageId(run, whatsapp_message_id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  // See sendButtonsAndSuspend — interpolate every visible string,
  // never the row `reply_id`.
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    buttonLabel: interpolateVars(cfg.button_label, run.vars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    sections: cfg.sections.map((s) => ({
      title: interpolateOptionalVars(s.title, run.vars),
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: interpolateVars(r.title, run.vars),
        description: interpolateOptionalVars(r.description, run.vars),
      })),
    })),
  });
  await logEvent(run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  await stashPromptMessageId(run, whatsapp_message_id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  if (run.conversation_id) {
    await handoff(run, run.conversation_id, cfg.assign_to);
  }
  await logEvent(run.id, "handoff", node.node_key, {
    // Same {{vars.*}} interpolation as the message nodes, so a lead
    // capture's note carries the answers it collected.
    note: cfg.note ? interpolateVars(cfg.note, run.vars) : null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(run, "handed_off", "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a DB mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const has = await asService((db) =>
      contactHasTag(db, run.account_id, run.contact_id!, cfg.subject_key),
    );
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = has ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const raw = await asService((db) =>
      getContactFieldValue(db, run.account_id, run.contact_id!, cfg.subject_key),
    );
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * `interpolateVars` for optional config fields (header_text, footer_text,
 * list section titles, row descriptions). An absent field stays absent
 * — `interpolateVars(undefined)` would return "" and meta-api treats
 * header/footer/description by truthiness, so "" is harmless there, but
 * keeping `undefined` means the payload we log and send matches what
 * the author configured rather than sprouting empty strings.
 */
function interpolateOptionalVars(
  template: string | undefined,
  vars: Record<string, unknown>,
): string | undefined {
  return template === undefined || template === null
    ? undefined
    : interpolateVars(template, vars);
}

async function endRun(
  run: FlowRunRow,
  status: FlowRunEndStatus,
  reason: string,
): Promise<void> {
  try {
    await asService((db) => endRunRow(db, run.account_id, run.id, status, reason));
  } catch (error) {
    console.error("[flows] endRun error:", errorText(error));
  }
}

/** Remember our `messages.id` for the prompt just sent (best-effort). */
async function stashPromptMessageId(run: FlowRunRow, whatsappMessageId: string): Promise<void> {
  try {
    await asService(async (db) => {
      const id = await findMessageIdByWaId(db, run.account_id, whatsappMessageId);
      await updateRun(db, run.account_id, run.id, { last_prompt_message_id: id });
    });
  } catch (error) {
    console.error("[flows] last_prompt_message_id update error:", errorText(error));
  }
}

/** Hand the conversation to a human (status pending, optional assignee). */
async function handoff(run: FlowRunRow, conversationId: string, assignTo?: string): Promise<void> {
  try {
    await asService((db) => handoffConversation(db, run.account_id, conversationId, assignTo));
  } catch (error) {
    console.error("[flows] handoff update error:", errorText(error));
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(run, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(run, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(run, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(run, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        await stashPromptMessageId(run, whatsapp_message_id);
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(run, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        run,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(run, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await addContactTagAndDispatch({
            run: serviceRunner,
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              vars: run.vars,
            },
          });
        } else {
          await asService((tx) =>
            removeContactTag(tx, {
              accountId: run.account_id,
              contactId: run.contact_id!,
              tagId: cfg.tag_id,
            }),
          );
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      // Same failure contract as send_message / send_media /
      // collect_input above: log + fail the run. Previously an
      // exception here (Meta error, or meta-api's length validation —
      // now reachable via interpolation, see sendButtonsAndSuspend)
      // escaped to dispatchInboundToFlows' catch, which only
      // console.error'd and left the run active + stuck on the prior
      // node with nothing in flow_run_events.
      try {
        await sendButtonsAndSuspend(run, node);
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "send_buttons_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(run, "failed", "send_buttons_failed");
        return { outcome: "completed" };
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        run,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      try {
        await sendListAndSuspend(run, node);
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "send_list_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(run, "failed", "send_list_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        run,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(run.id, "completed", node.node_key);
      await endRun(run, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(run, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(run, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  run: FlowRunRow,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // A null expected key compares with IS NULL (the repo handles it).
  try {
    return await asService((db) =>
      advanceRunNodeKey(db, run.account_id, run.id, expectedOldKey, newKey),
    );
  } catch (error) {
    console.error("[flows] advanceCurrentNodeKey error:", errorText(error));
    return false;
  }
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  try {
    const activeRun = await loadActiveRunForContact(
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(activeRun.account_id, activeRun.flow_id);
      return handleReplyForActiveRun(activeRun, input.message, nodes);
    }

    // No active run → look for a flow whose entry trigger matches.
    const flow = await findEntryFlow(
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(flow.account_id, flow.id);
    return startNewRun(flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

async function handleReplyForActiveRun(
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(run, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(run, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key) {
      // Persist captured value + reset reprompt count atomically.
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      const capErr = await asService((db) =>
        updateRun(db, run.account_id, run.id, { vars: newVars, reprompt_count: 0 }),
      ).then(
        () => null,
        (err: unknown) => err,
      );
      if (capErr) {
        console.error("[flows] capture update error:", errorText(capErr));
      } else {
        // Mirror the UPDATE in-memory so downstream interpolation in
        // the advance loop sees the captured var without us having to
        // re-SELECT the whole row.
        run.vars = newVars;
        run.reprompt_count = 0;
        await logEvent(run.id, "node_entered", currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
        });
        matched = cfg.next_node_key;
      }
    }
  }

  if (matched) {
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      try {
        await asService((db) => updateRun(db, run.account_id, run.id, { reprompt_count: 0 }));
        run.reprompt_count = 0;
      } catch (error) {
        console.error("[flows] reprompt reset error:", errorText(error));
      }
    }
    const outcome = await advanceFromNodeKey(run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(
    (await loadFlow(run.account_id, run.flow_id))?.fallback_policy,
  );
  const newReprompts = run.reprompt_count + 1;
  try {
    await asService((db) => updateRun(db, run.account_id, run.id, { reprompt_count: newReprompts }));
  } catch (error) {
    console.error("[flows] reprompt count error:", errorText(error));
  }

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    // The interactive helpers interpolate run.vars themselves, so a
    // reprompt renders the same text the original prompt did. A send
    // failure here is logged but does not end the run — the customer
    // still has the original prompt on screen and can retry.
    try {
      if (currentNode.node_type === "send_buttons") {
        await sendButtonsAndSuspend(run, currentNode);
      } else if (currentNode.node_type === "send_list") {
        await sendListAndSuspend(run, currentNode);
      } else if (currentNode.node_type === "collect_input") {
        // Customer typed something we couldn't accept (empty after trim,
        // or var_key missing — rare). Re-send the prompt so they try again.
        const cfg = currentNode.config as unknown as CollectInputNodeConfig;
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      }
    } catch (err) {
      await logEvent(run.id, "error", currentNode.node_key, {
        reason: "reprompt_send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await handoff(run, run.conversation_id);
    }
    await logEvent(run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(run, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(run, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function startNewRun(
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // INSERT … ON CONFLICT DO NOTHING on the partial unique index
  // `idx_one_active_run_per_contact`: a concurrent start for the same
  // contact inserts nothing, and we return consumed:true (the parallel
  // webhook handles it).
  let inserted: FlowRunRow | undefined;
  try {
    inserted = await asService((db) =>
      insertActiveRun(db, {
        flow_id: flow.id,
        // Tenancy: NOT NULL post-017. The partial unique index
        // `idx_one_active_run_per_contact` is over (account_id,
        // contact_id) WHERE status='active', so two accounts sharing
        // a contact phone number each run their own flows independently.
        account_id: flow.account_id,
        // Audit: preserves the flow's author on the run row for log
        // attribution.
        user_id: flow.user_id,
        contact_id: input.contactId,
        conversation_id: input.conversationId,
        current_node_key: flow.entry_node_id,
      }),
    );
  } catch (insErr) {
    console.error("[flows] startNewRun insert error:", errorText(insErr));
    return { consumed: false, outcome: "no_match" };
  }
  if (!inserted) {
    // Another webhook is starting the run for this contact.
    return { consumed: true, outcome: "duplicate_inbound_ignored" };
  }
  const run = inserted;
  await logEvent(run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  try {
    await asService((db) => incrementFlowExecutionCount(db, flow.id));
  } catch (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", errorText(incErr));
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
