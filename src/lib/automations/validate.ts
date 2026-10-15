import type { AutomationTriggerType } from '@/types'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { getT } from '@/lib/i18n/translate'

const t = getT('Validation.automations')

// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in engine.ts's runStep;
// they're the same invariants, enforced one step earlier so failures
// surface at save time.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. */
  path: string
  message: string
}

interface StepLike {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: StepLike[]; no?: StepLike[] }
}

/** The bits of a `message_templates` row activation checks need. */
export interface TemplateBody {
  name: string
  language: string | null
  body_text: string
}

export interface ActivationContext {
  /**
   * The account's templates referenced by send_template steps. When a
   * step's template is found here, every {{n}} in its body must have a
   * value in `step_config.variables`. Omitted (or no match): skipped,
   * since the engine still sends a template it has no local copy of.
   */
  templates?: TemplateBody[]
}

export function validateStepsForActivation(
  steps: StepLike[],
  ctx: ActivationContext = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: t('needsStep'),
    })
    return issues
  }
  walk(steps, '', issues, ctx)
  return issues
}

/** Template names used by send_template steps anywhere in the tree. */
export function templateNamesInSteps(steps: StepLike[]): string[] {
  const names = new Set<string>()
  const visit = (list: StepLike[] | undefined) => {
    if (!Array.isArray(list)) return
    for (const s of list) {
      const name = s.step_config?.template_name
      if (s.step_type === 'send_template' && nonEmpty(name)) names.add(String(name))
      visit(s.branches?.yes)
      visit(s.branches?.no)
    }
  }
  visit(steps)
  return [...names]
}

/**
 * Positional body placeholders a template needs, as the `variables`
 * keys the engine sends in order: "Hi {{1}}, {{2}}" → ["1", "2"].
 */
export function templateVariableKeys(bodyText: string): string[] {
  const seen = new Set<number>()
  for (const m of bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const n = Number(m[1])
    if (n >= 1) seen.add(n)
  }
  return [...seen].sort((a, b) => a - b).map(String)
}

/**
 * The template a send_template step will use, by name + language,
 * tolerant of the en / en_US split (same order as the send path's
 * pickTemplateRow: exact, then same base language, then en_US / en).
 */
export function findTemplateBody(
  templates: TemplateBody[],
  name: string,
  language: string | null | undefined,
): TemplateBody | undefined {
  const rows = templates.filter((tpl) => tpl.name === name)
  if (rows.length === 0) return undefined
  const base = (l: string) => l.toLowerCase().split(/[_-]/)[0]
  if (language) {
    const wanted = language.toLowerCase()
    return (
      rows.find((r) => r.language?.toLowerCase() === wanted) ??
      rows.find((r) => r.language && base(r.language) === base(language))
    )
  }
  return rows.find((r) => r.language === 'en_US') ?? rows.find((r) => r.language === 'en') ?? rows[0]
}

function walk(steps: StepLike[], prefix: string, issues: ValidationIssue[], ctx: ActivationContext): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`
    validateOne(s, path, issues, ctx)
    if (s.step_type === 'condition' && s.branches) {
      if (s.branches.yes) walk(s.branches.yes, `${path}.yes.`, issues, ctx)
      if (s.branches.no) walk(s.branches.no, `${path}.no.`, issues, ctx)
    }
  })
}

/** "HH:mm-HH:mm" (minutes optional, 24:00 allowed as an end of day). */
const TIME_WINDOW_RE = /^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/

function isTimeWindow(v: unknown): boolean {
  const m = typeof v === 'string' ? TIME_WINDOW_RE.exec(v) : null
  if (!m) return false
  const ok = (h: string, min: string | undefined) => {
    const hh = Number(h)
    const mm = Number(min ?? 0)
    return mm < 60 && (hh < 24 || (hh === 24 && mm === 0))
  }
  return ok(m[1], m[2]) && ok(m[3], m[4])
}

/**
 * Each subject reads different fields at run time (engine.ts,
 * evaluateCondition), so each requires different ones here.
 */
function validateCondition(c: Record<string, unknown>, path: string, issues: ValidationIssue[]): void {
  if (!nonEmpty(c.subject)) {
    issues.push({ path: `${path}.subject`, message: t('conditionSubjectRequired') })
    if (!nonEmpty(c.operand)) {
      issues.push({ path: `${path}.operand`, message: t('conditionOperandRequired') })
    }
    return
  }
  switch (c.subject) {
    case 'tag_presence':
    case 'contact_field':
      // The tag id / the contact column. contact_field's `value` may be
      // empty: it then matches a field that is empty.
      if (!nonEmpty(c.operand)) {
        issues.push({ path: `${path}.operand`, message: t('conditionOperandRequired') })
      }
      break
    case 'message_content':
      // Only `value` is read: an empty one would match every message.
      if (!nonEmpty(c.value)) {
        issues.push({ path: `${path}.value`, message: t('conditionValueRequired') })
      }
      break
    case 'time_of_day':
      if (!nonEmpty(c.operand)) {
        issues.push({ path: `${path}.operand`, message: t('conditionOperandRequired') })
      } else if (!isTimeWindow(c.operand)) {
        issues.push({ path: `${path}.operand`, message: t('conditionTimeInvalid') })
      }
      break
    default:
      issues.push({
        path: `${path}.subject`,
        message: t('conditionSubjectInvalid'),
      })
  }
}

function validateOne(step: StepLike, path: string, issues: ValidationIssue[], ctx: ActivationContext): void {
  const c = step.step_config ?? {}
  switch (step.step_type) {
    case 'send_message':
      if (!nonEmpty(c.text)) {
        issues.push({ path: `${path}.text`, message: t('messageTextRequired') })
      }
      break
    case 'send_buttons':
    case 'send_list': {
      // The whole step_config IS the interactive payload; validate it
      // against Meta's limits (same check the engine runs before send).
      const result = validateInteractivePayload(c)
      if (!result.ok) {
        issues.push({ path: `${path}.interactive`, message: result.error })
      }
      break
    }
    case 'send_template':
      if (!nonEmpty(c.template_name)) {
        issues.push({ path: `${path}.template_name`, message: t('templateNameRequired') })
        break
      }
      {
        const tpl = ctx.templates
          ? findTemplateBody(ctx.templates, String(c.template_name), c.language as string | undefined)
          : undefined
        const vars = (c.variables ?? {}) as Record<string, unknown>
        for (const key of tpl ? templateVariableKeys(tpl.body_text) : []) {
          if (!nonEmpty(vars[key])) {
            issues.push({
              path: `${path}.variables.${key}`,
              message: t('templateVariableRequired', { placeholder: `{{${key}}}` }),
            })
          }
        }
      }
      break
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({ path: `${path}.tag_id`, message: t('tagRequired') })
      }
      break
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: t('agentRequired'),
        })
      }
      break
    case 'update_contact_field':
      if (!nonEmpty(c.field)) {
        issues.push({ path: `${path}.field`, message: t('fieldNameRequired') })
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({ path: `${path}.value`, message: t('fieldValueRequired') })
      }
      break
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({ path: `${path}.pipeline_id`, message: t('pipelineRequired') })
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: t('stageRequired') })
      }
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: t('titleRequired') })
      }
      break
    case 'wait':
      if (typeof c.amount !== 'number' || !Number.isFinite(c.amount) || c.amount <= 0) {
        issues.push({ path: `${path}.amount`, message: t('waitAmountInvalid') })
      }
      if (!['minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: t('waitUnitInvalid'),
        })
      }
      break
    case 'condition':
      validateCondition(c, path, issues)
      break
    case 'send_webhook':
      if (!nonEmpty(c.url)) {
        issues.push({ path: `${path}.url`, message: t('webhookUrlRequired') })
        break
      }
      try {
        const u = new URL(String(c.url))
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          issues.push({
            path: `${path}.url`,
            message: t('webhookUrlScheme'),
          })
        }
      } catch {
        issues.push({ path: `${path}.url`, message: t('webhookUrlInvalid') })
      }
      break
    case 'close_conversation':
      // No config required.
      break
    default:
      issues.push({ path, message: t('unknownStepType', { type: step.step_type }) })
  }
}

export function validateTriggerForActivation(
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({ path: 'trigger.keywords', message: t('keywordRequired') })
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({ path: 'trigger.keywords', message: t('keywordsEmpty') })
    }
    // A missing match_type defaults to "contains" at runtime (see
    // automations/engine.ts and flows/engine.ts, which both read
    // `match_type ?? "contains"`), so only an explicit, unrecognised
    // value is invalid here. This keeps activation validation in step
    // with the engine and with the builder's "Contains" default — an
    // automation that shows the default in the UI must not be rejected.
    if (
      cfg.match_type != null &&
      cfg.match_type !== 'exact' &&
      cfg.match_type !== 'contains' &&
      cfg.match_type !== 'word'
    ) {
      issues.push({
        path: 'trigger.match_type',
        message: t('matchTypeInvalid'),
      })
    }
  } else if (triggerType === 'time_based') {
    if (!nonEmpty(cfg.schedule)) {
      issues.push({ path: 'trigger.schedule', message: t('scheduleRequired') })
    }
  } else if (triggerType === 'tag_added') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({ path: 'trigger.tag_id', message: t('tagRequired') })
    }
  } else if (triggerType === 'interactive_reply') {
    const ids = cfg.reply_ids
    if (!Array.isArray(ids) || ids.length === 0) {
      issues.push({
        path: 'trigger.reply_ids',
        message: t('replyIdRequired'),
      })
    } else if (ids.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.reply_ids',
        message: t('replyIdsEmpty'),
      })
    }
  }

  return issues
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}
