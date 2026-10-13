import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  TagTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
} from '@/types'
import { asService } from '@/server/db'
import {
  getAutomation,
  getStepPlacement,
  incrementAutomationExecutionCount,
  listActiveAutomationsForTrigger,
  listScopeSteps,
} from '@/server/repos/automations'
import {
  claimPendingExecution,
  expireAwaitingReplyRows,
  findAwaitingReply,
  insertAutomationLog,
  insertPendingExecution,
  setPendingExecutionStatus,
  supersedeAwaitingReplies,
  updateAutomationLog,
  type LogPatch,
} from '@/server/repos/automation-runs'
import {
  assignContactConversations,
  closeContactConversations,
  contactHasTag,
  contactInAccount,
  conversationInAccount,
  customFieldInAccount,
  deleteContactTag,
  findConversationIdForContact,
  firstAccountMemberUserId,
  getAccountDefaultCurrency,
  getContactFieldValue,
  insertDeal,
  updateContactField,
  upsertContactCustomValue,
  type WritableContactField,
} from '@/server/repos/engine-data'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from '@/lib/contacts/tag-chain'
import { engineSendText, engineSendTemplate, engineSendInteractive } from './meta-send'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { getT } from '@/lib/i18n/translate'

/** Step errors land in automation_logs and are shown on the logs page. */
const tErr = getT('LibErrors.engine')

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactive_reply_id?: string
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(input: DispatchInput): Promise<void> {
  try {
    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs as the service role,
    // which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const contactId = input.contactId
      let owned: boolean
      try {
        owned = await asService((db) => contactInAccount(db, input.accountId, contactId))
      } catch (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr)
        return
      }
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return
      }
    }

    // Same argument for `context.conversation_id` (GHSA-m4fx-g6pr-hrw8).
    // It rides in on the same caller-supplied body, and every send step
    // writes a `messages` row and a `conversations` preview update keyed
    // on it as the service role — so an unvalidated id let a
    // caller inject a message into another tenant's conversation. Refuse
    // the same way: silently, with no existence oracle.
    if (input.context?.conversation_id) {
      const conversationId = input.context.conversation_id
      let conv: boolean
      try {
        conv = await asService((db) => conversationInAccount(db, input.accountId, conversationId))
      } catch (convErr) {
        console.error('[automations] conversation ownership check failed:', convErr)
        return
      }
      if (!conv) {
        console.warn(
          '[automations] conversation not in account, refusing dispatch',
          input.context.conversation_id,
        )
        return
      }
    }

    let automations: Automation[]
    try {
      automations = await asService((db) =>
        listActiveAutomationsForTrigger(db, input.accountId, input.triggerType),
      )
    } catch (error) {
      console.error('[automations] fetch failed:', error)
      return
    }
    if (automations.length === 0) return

    for (const automation of automations) {
      if (!triggerMatches(automation, input.context)) continue
      try {
        await executeAutomation(automation, input)
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string
  /** Tenancy key: the automation is looked up within this account. */
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
}): Promise<void> {
  let automation: Automation | undefined
  try {
    automation = await asService((db) =>
      getAutomation(db, pending.account_id, pending.automation_id),
    )
  } catch (error) {
    console.error('[automations] resume: automation lookup failed', pending.automation_id, error)
  }

  if (!automation) {
    console.error('[automations] resume: missing automation', pending.automation_id)
    await markPending(pending.account_id, pending.id, 'failed')
    return
  }

  try {
    await runResumed({
      automation,
      contactId: pending.contact_id,
      context: pending.context ?? {},
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    })
    await markPending(pending.account_id, pending.id, 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.account_id, pending.id, 'failed')
  }
}

/** How long a `wait_for_reply` step waits: WhatsApp's 24h service window. */
export const REPLY_WAIT_MS = 24 * 60 * 60 * 1000

export interface AwaitingReplyInput {
  accountId: string
  contactId: string
  /** The inbound that may be the reply. Overwrites the parked run's
   *  message fields so the steps after the wait see the reply. */
  context: Pick<AutomationContext, 'message_text' | 'conversation_id' | 'interactive_reply_id'>
}

/**
 * Hand an inbound message to the contact's automation run that is parked
 * at a `wait_for_reply` step, if there is one.
 *
 * Returns true when a parked run took the message — the caller then
 * skips the content triggers (`new_message_received`, `keyword_match`,
 * `interactive_reply`) and AI auto-reply for it, the same way a Flow
 * consuming a message suppresses them.
 *
 * Must never throw — it runs inside the webhook's `after()` block.
 */
export async function resumeAwaitingReply(input: AwaitingReplyInput): Promise<boolean> {
  let claimedId: string | null = null
  try {
    // Newest first; a park supersedes older waits, so normally there is
    // at most one. The deadline is checked here rather than trusted to
    // the cron sweep, so an expired wait is never resumed even when the
    // cron isn't running.
    let pending: PendingRow | undefined
    try {
      pending = (await asService((db) =>
        findAwaitingReply(db, input.accountId, input.contactId, new Date()),
      )) as PendingRow | undefined
    } catch (error) {
      console.error('[automations] awaiting-reply lookup failed:', error)
      return false
    }
    if (!pending) return false
    const parked = pending

    // Claim it. Gated on the CURRENT status so two deliveries racing on
    // the same parked run can't both resume it.
    const claimed = await asService((db) => claimPendingExecution(db, parked.id, 'awaiting_reply'))
    if (!claimed) return false
    claimedId = pending.id

    const automation = await asService((db) =>
      getAutomation(db, input.accountId, parked.automation_id),
    )
    if (!automation || !automation.is_active) {
      // Paused or deleted while waiting: drop the wait and let the
      // message go through the normal triggers instead.
      await markPending(input.accountId, pending.id, 'expired')
      await setLogError(input.accountId, pending.log_id, tErr('pausedWhileWaitingForReply'))
      return false
    }

    await runResumed({
      automation,
      contactId: pending.contact_id,
      context: {
        ...(pending.context ?? {}),
        // Always overwrite all three, so a typed reply can't inherit a
        // stale tap id from the message that started the run.
        message_text: input.context.message_text ?? '',
        conversation_id: input.context.conversation_id,
        interactive_reply_id: input.context.interactive_reply_id,
      },
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_reply',
    })
    await markPending(input.accountId, pending.id, 'done')
    return true
  } catch (err) {
    console.error('[automations] awaiting-reply resume failed:', err)
    if (claimedId) {
      // The message was already taken by the claim; report it consumed so
      // it doesn't ALSO fan out to other automations.
      await markPending(input.accountId, claimedId, 'failed')
      return true
    }
    return false
  }
}

/**
 * Close out `wait_for_reply` runs whose 24h deadline passed with no
 * reply. Called from the automations cron. Nothing is sent to the
 * customer; the log stays `partial` with an explanatory error_message.
 * Returns how many runs expired.
 */
export async function expireAwaitingReplies(now: Date = new Date()): Promise<number> {
  let rows: { id: string; account_id: string; log_id: string | null }[]
  try {
    rows = await asService((db) => expireAwaitingReplyRows(db, now))
  } catch (error) {
    console.error('[automations] expire awaiting replies failed:', error)
    return 0
  }
  for (const row of rows) {
    await setLogError(row.account_id, row.log_id, tErr('noReplyWithin24h'))
  }
  return rows.length
}

interface PendingRow {
  id: string
  automation_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext | null
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

async function executeAutomation(automation: Automation, input: DispatchInput) {
  let log: { id: string }
  try {
    log = await asService((db) =>
      insertAutomationLog(db, {
        automation_id: automation.id,
        // Tenancy: matches automation.account_id (NOT NULL post-017).
        account_id: automation.account_id,
        // Audit: keeps the historical "author of this automation"
        // pointer so logs still attribute to the right user even
        // after teammates join the account.
        user_id: automation.user_id,
        contact_id: input.contactId ?? null,
        trigger_event: input.triggerType,
        // steps_executed starts as [].
        // Seeded pessimistically. The row is written BEFORE any step runs,
        // and every terminal path below overwrites it (`appendResults` at
        // the outermost scope, or `finalizeLog`). Seeding 'success' meant a
        // run that died mid-flight — the process frozen, the pod recycled —
        // left a permanent `status: 'success'` with `steps_executed: []`,
        // indistinguishable from an automation that genuinely had nothing
        // to do. 'failed' inverts that: the status only becomes success if
        // execution actually reached the end. See issue #409.
        status: 'failed',
      }),
    )
  } catch (logErr) {
    console.error('[automations] cannot create log:', logErr)
    return
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  })

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  try {
    await asService((db) => incrementAutomationExecutionCount(db, automation.id))
  } catch (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr)
  }
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
}

/**
 * How a scope ended. `suspended` means a `wait` / `wait_for_reply` step
 * parked the run: every enclosing scope must stop too, or the steps
 * after a condition would run before the branch's own remaining steps.
 */
type ScopeOutcome = 'completed' | 'suspended' | 'failed'

async function executeStepsFrom(args: ExecuteArgs): Promise<ScopeOutcome> {
  const accountId = args.automation.account_id
  let steps: AutomationStep[]
  try {
    steps = await asService((db) =>
      listScopeSteps(db, args.automation.id, {
        parentStepId: args.parentStepId,
        branch: args.branch,
        startPosition: args.startPosition,
      }),
    )
  } catch (stepsErr) {
    await finalizeLog(accountId, args.logId, 'failed', errorText(stepsErr))
    return 'failed'
  }
  if (steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(accountId, args.logId, 'success', null)
    }
    return 'completed'
  }

  const results: AutomationLogStepResult[] = []
  let status: 'success' | 'partial' | 'failed' = 'success'
  let errorMessage: string | null = null

  for (const step of steps) {
    // `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      try {
        await asService((db) =>
          insertPendingExecution(db, {
            automation_id: args.automation.id,
            // Tenancy: account_id required NOT NULL post-017.
            account_id: args.automation.account_id,
            user_id: args.automation.user_id,
            contact_id: args.contactId,
            log_id: args.logId,
            parent_step_id: args.parentStepId,
            branch: args.branch,
            next_step_position: step.position + 1,
            context: args.context,
            run_at: new Date(Date.now() + ms).toISOString(),
            status: 'pending',
          }),
        )
      } catch (err) {
        console.error('[automations] enqueue wait failed:', err)
      }
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      return suspend(args, results, errorMessage)
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        const branchOutcome = await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        })
        // The branch parked: stop here too. The steps after this
        // condition run when the branch resumes and climbs back out
        // (see runResumed).
        if (branchOutcome === 'suspended') {
          return suspend(args, results, errorMessage)
        }
        continue
      }

      const detail = await runStep(step, args)
      if (waitsForReply(step)) {
        await parkForReply(step, args)
        results.push({
          step_id: step.id,
          step_type: step.step_type,
          status: 'success',
          detail: `${detail}; waiting for reply`,
        })
        return suspend(args, results, errorMessage)
      }
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      status = 'failed'
      errorMessage = msg
      break
    }
  }

  if (args.parentStepId === null) {
    await appendResults(accountId, args.logId, results, status, errorMessage)
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(accountId, args.logId, results, null, errorMessage)
  }
  return status === 'failed' ? 'failed' : 'completed'
}

/** Record a parked scope's results and report the suspension upward. */
async function suspend(
  args: ExecuteArgs,
  results: AutomationLogStepResult[],
  errorMessage: string | null,
): Promise<ScopeOutcome> {
  // Only the outermost scope owns the log status (same rule as below).
  await appendResults(
    args.automation.account_id,
    args.logId,
    results,
    args.parentStepId === null ? 'partial' : null,
    errorMessage,
  )
  return 'suspended'
}

/**
 * Continue a parked run, then climb out of every enclosing condition
 * branch. A run can park inside a branch; once that branch's remaining
 * steps finish, execution has to carry on after the condition that owns
 * it, in the condition's own scope, all the way back to the root.
 */
async function runResumed(args: ExecuteArgs): Promise<void> {
  const accountId = args.automation.account_id
  let outcome = await executeStepsFrom(args)
  let owner = args.parentStepId

  while (outcome === 'completed' && owner !== null) {
    const ownerId: string = owner
    const c = await asService((db) => getStepPlacement(db, args.automation.id, ownerId))
    if (!c) {
      // The condition was deleted while the run was parked — nothing
      // left to climb into. What did run, ran successfully.
      await setLogStatus(accountId, args.logId, 'success')
      return
    }
    owner = c.parent_step_id ?? null
    outcome = await executeStepsFrom({
      ...args,
      parentStepId: owner,
      branch: c.branch ?? null,
      startPosition: c.position + 1,
    })
  }

  // A nested scope never sets the log status itself, so a failure there
  // has to be promoted here or the log stays `partial` forever.
  if (outcome === 'failed' && owner !== null) {
    await setLogStatus(accountId, args.logId, 'failed')
  }
}

function waitsForReply(step: AutomationStep): boolean {
  if (step.step_type !== 'send_buttons' && step.step_type !== 'send_list') return false
  return (step.step_config as SendButtonsStepConfig).wait_for_reply === true
}

/**
 * Park the run after an interactive send until the contact replies.
 * The newest menu wins: any other run already waiting on this contact
 * is superseded, so a reply can never resume a stale menu.
 */
async function parkForReply(step: AutomationStep, args: ExecuteArgs): Promise<void> {
  try {
    // One transaction: the supersede and the new wait land together.
    await asService(async (db) => {
      await supersedeAwaitingReplies(db, args.automation.account_id, args.contactId)
      await insertPendingExecution(db, {
        automation_id: args.automation.id,
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        contact_id: args.contactId,
        log_id: args.logId,
        parent_step_id: args.parentStepId,
        branch: args.branch,
        next_step_position: step.position + 1,
        context: args.context,
        // For awaiting_reply rows run_at is the reply deadline (migration 045).
        run_at: new Date(Date.now() + REPLY_WAIT_MS).toISOString(),
        status: 'awaiting_reply',
      })
    })
  } catch (error) {
    throw new Error(tErr('parkForReplyFailed', { message: errorText(error) }))
  }
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  const accountId = args.automation.account_id

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error(tErr('needsContact', { step: 'send_message' }))
      const text = interpolate(cfg.text, args)
      if (!text.trim()) throw new Error(tErr('emptyText'))
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent via Meta (${whatsapp_message_id})`
    }

    case 'send_buttons':
    case 'send_list': {
      const payload = step.step_config as SendButtonsStepConfig | SendListStepConfig
      if (!args.contactId) throw new Error(tErr('needsContact', { step: step.step_type }))
      // Validate against Meta's limits before the network call so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation.
      const check = validateInteractivePayload(payload)
      if (!check.ok) throw new Error(check.error)
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendInteractive({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        payload,
      })
      return `interactive sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error(tErr('needsContact', { step: 'send_template' }))
      if (!cfg.template_name) throw new Error(tErr('needsTemplateName'))
      const conversationId = await resolveConversationId(args)
      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'add_tag': {
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error(tErr('needsContactAndTag', { step: 'add_tag' }))
      const contactId = args.contactId
      const added = await asService((tx) =>
        addContactTagIfAbsent(tx, {
          accountId: args.automation.account_id,
          contactId,
          tagId: cfg.tag_id,
        }),
      )
      if (!added) return `tag ${cfg.tag_id} already present`

      const depth = getTagChainDepth(args.context)
      if (depth >= MAX_TAG_CHAIN_DEPTH) {
        console.warn('[automations] tag_added chain depth limit reached', {
          automationId: args.automation.id,
          contactId: args.contactId,
          tagId: cfg.tag_id,
          depth,
        })
        return `tag ${cfg.tag_id} added; tag_added dispatch skipped at depth ${depth}`
      }

      await runAutomationsForTrigger({
        accountId: args.automation.account_id,
        triggerType: 'tag_added',
        contactId: args.contactId,
        context: {
          ...args.context,
          tag_id: cfg.tag_id,
          vars: {
            ...(args.context.vars ?? {}),
            _tag_chain_depth: depth + 1,
          },
        },
      })
      return `tag ${cfg.tag_id} added and tag_added dispatched`
    }

    case 'remove_tag': {
      // contact_tags carries no account_id; the repo scopes the delete
      // through the contact's account.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error(tErr('needsContactAndTag', { step: 'remove_tag' }))
      const contactId = args.contactId
      await asService((db) => deleteContactTag(db, accountId, contactId, cfg.tag_id))
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error(tErr('needsContact', { step: 'assign_conversation' }))
      const contactId = args.contactId
      let agentId: string | null | undefined = cfg.agent_id
      if (cfg.mode === 'round_robin') {
        // Pick any member of the account. The existing implementation
        // only ever returned the automation's author; preserving that
        // shape until a real round-robin algorithm replaces it.
        agentId = await asService((db) => firstAccountMemberUserId(db, accountId))
      }
      if (!agentId) return 'no agent resolved'
      const assignee = agentId
      await asService((db) => assignContactConversations(db, accountId, contactId, assignee))
      return `assigned to ${agentId}`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error(tErr('needsContact', { step: 'update_contact_field' }))
      const contactId = args.contactId
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args)

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) {
          return `field ${cfg.field} not writable from automations`
        }
        // Defense in depth: the service role bypasses RLS, so confirm
        // the field definition belongs to this account before writing.
        const field = await asService((db) => customFieldInAccount(db, accountId, customFieldId))
        if (!field) {
          return `field ${cfg.field} not writable from automations`
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the repo's account check.
        await asService((db) => upsertContactCustomValue(db, accountId, contactId, customFieldId, value))
        return `custom field updated`
      }

      const allowed = new Set(['name', 'email', 'company'])
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`
      }
      // Defense in depth: scope the service-role write to the account so
      // a future caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      const builtin = cfg.field as WritableContactField
      await asService((db) => updateContactField(db, accountId, contactId, builtin, value))
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error(tErr('needsPipelineStage'))
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to USD if the row is somehow
      // missing the value (pre-021 forks).
      await asService(async (db) => {
        const currency = await getAccountDefaultCurrency(db, accountId)
        await insertDeal(db, {
          // Tenancy + audit, same split as automation_logs above.
          account_id: accountId,
          user_id: args.automation.user_id,
          pipeline_id: cfg.pipeline_id,
          stage_id: cfg.stage_id,
          contact_id: args.contactId,
          title: interpolate(cfg.title, args),
          value: cfg.value ?? 0,
          currency: currency ?? 'USD',
        })
      })
      return 'deal created'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error(tErr('needsUrl'))
      // SSRF guard: the URL and headers are account-controlled and the
      // server makes the request, so refuse any destination that resolves
      // to a private / loopback / link-local / reserved address. Mirrors
      // the webhook_endpoints delivery path (see lib/webhooks/deliver.ts).
      if (!(await isDeliverableUrl(cfg.url))) {
        throw new Error(tErr('destinationNotAllowed'))
      }
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above. Bound the request
        // so a hung/slow internal host can't tie up the runner.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(tErr('webhookStatus', { status: String(res.status) }))
      return `webhook ${res.status}`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error(tErr('needsContact', { step: 'close_conversation' }))
      const contactId = args.contactId
      await asService((db) => closeContactConversations(db, accountId, contactId))
      return 'conversation closed'
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) {
    // Re-verify rather than trust the context. Dispatch already checks
    // a caller-supplied id, but a resumed run replays a context that
    // was persisted rows ago, and this is the last point before a
    // service-role write keyed on it (GHSA-m4fx-g6pr-hrw8).
    let owned: boolean
    try {
      owned = await asService((db) => conversationInAccount(db, args.automation.account_id, fromCtx))
    } catch (error) {
      throw new Error(getT('LibErrors.send')('conversationLookupFailed', { message: errorText(error) }))
    }
    if (!owned) throw new Error(tErr('conversationNotInAccount'))
    return fromCtx
  }
  if (!args.contactId) throw new Error(tErr('noContactForConversation'))
  const contactId = args.contactId
  let id: string | null
  try {
    id = await asService((db) =>
      findConversationIdForContact(db, args.automation.account_id, contactId),
    )
  } catch (error) {
    throw new Error(getT('LibErrors.send')('conversationLookupFailed', { message: errorText(error) }))
  }
  if (!id) {
    throw new Error(
      tErr(args.triggerEvent === 'tag_added' ? 'tagAddedNoConversation' : 'noConversation'),
    )
  }
  return id
}

/** Letter, digit or underscore in any script — the "inside a word" test. */
const WORD_CHAR = '[\\p{L}\\p{N}_]'

/**
 * Whole-word keyword test, behind `match_type: 'word'` (issue #409 — a
 * one-letter keyword under `contains` fires on every message containing
 * that letter, e.g. "k" on "thanks").
 *
 * Deliberately NOT `\b`, which is defined against `[A-Za-z0-9_]` and so
 * breaks two cases that matter for WhatsApp traffic:
 *
 *   - A keyword carrying punctuation: `/\bhi!\b/` demands a word character
 *     after the "!", so it never matches "say hi!".
 *   - Any non-Latin script: every character of "안녕" is a non-word
 *     character to `\b`, so `/\b안녕\b/` matches nothing at all.
 *
 * Unicode-aware lookarounds handle both. Note this really is word-based:
 * it won't find "안녕" inside "안녕하세요", because a language that doesn't
 * delimit words with spaces has no word edge there. That's what `contains`
 * is for, and it stays the default.
 *
 * Exported for direct unit testing of the escaping / boundary edges.
 */
export function matchesWholeWord(
  text: string,
  keyword: string,
  caseSensitive = false,
): boolean {
  if (!keyword) return false
  // The keyword is account-supplied free text, so metacharacters have to
  // be literal — otherwise "(" is an unterminated group and RegExp throws.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`,
    caseSensitive ? 'u' : 'iu',
  )
  return pattern.test(text)
}

export function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig
    if (!cfg?.keywords || cfg.keywords.length === 0) return false
    const text = (ctx?.message_text ?? '').toString()
    if (!text) return false
    if (cfg.match_type === 'word') {
      return cfg.keywords.some((raw) =>
        matchesWholeWord(text, raw, cfg.case_sensitive),
      )
    }
    const haystack = cfg.case_sensitive ? text : text.toLowerCase()
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase()
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
    })
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig
    const replyId = ctx?.interactive_reply_id
    if (!replyId || !Array.isArray(cfg?.reply_ids) || cfg.reply_ids.length === 0) {
      return false
    }
    return cfg.reply_ids.includes(replyId)
  }

  if (automation.trigger_type === 'tag_added') {
    const cfg = automation.trigger_config as TagTriggerConfig
    const tagId = ctx?.tag_id
    return Boolean(tagId && cfg?.tag_id && cfg.tag_id === tagId)
  }

  return true
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  const accountId = args.automation.account_id
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      const contactId = args.contactId
      const tagId = cfg.operand
      // contact_tags has no account_id column (its RLS keys off the parent
      // contact); the repo joins the contact to scope by account.
      return asService((db) => contactHasTag(db, accountId, contactId, tagId))
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      const contactId = args.contactId
      const field = cfg.operand
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service role.
      const v = await asService((db) => getContactFieldValue(db, accountId, contactId, field))
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00").
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    default:
      return false
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(args.context.message_text ?? '')
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '')
    return ''
  })
}

async function appendResults(
  accountId: string,
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
) {
  if (!logId) return
  // Appended atomically in SQL (jsonb ||), so two scopes finishing
  // back-to-back can't drop each other's results.
  const patch: LogPatch = { appendSteps: newItems }
  // Only overwrite status on the outermost scope — nested branches pass null.
  if (status !== null) patch.status = status
  if (errorMessage) patch.error_message = errorMessage
  await writeLog(accountId, logId, patch)
}

async function finalizeLog(
  accountId: string,
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  await writeLog(accountId, logId, { status, error_message: errorMessage })
}

/** Status-only update, for when error_message must be left as it is. */
async function setLogStatus(
  accountId: string,
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
) {
  if (!logId) return
  await writeLog(accountId, logId, { status })
}

/** Explain why a parked run ended without touching its status. */
async function setLogError(accountId: string, logId: string | null, errorMessage: string) {
  if (!logId) return
  await writeLog(accountId, logId, { error_message: errorMessage })
}

/** Log writes are bookkeeping: a failure is reported, never thrown. */
async function writeLog(accountId: string, logId: string, patch: LogPatch) {
  try {
    await asService((db) => updateAutomationLog(db, accountId, logId, patch))
  } catch (err) {
    console.error('[automations] log update failed:', logId, err)
  }
}

async function markPending(accountId: string, id: string, status: 'done' | 'failed' | 'expired') {
  try {
    await asService((db) => setPendingExecutionStatus(db, accountId, id, status))
  } catch (err) {
    console.error('[automations] pending status update failed:', id, err)
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
