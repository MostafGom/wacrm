/**
 * Handlers for Meta's template-lifecycle webhook events.
 *
 * Meta delivers three template-related webhook fields, each with a
 * different `value` shape:
 *
 *   - message_template_status_update      — APPROVED / REJECTED / PAUSED / etc.
 *   - message_template_quality_update     — GREEN / YELLOW / RED quality score
 *   - message_template_components_update  — Meta auto-modified the template
 *
 * The route handler at /api/whatsapp/webhook receives every change and
 * delegates here when `change.field` starts with `message_template_`.
 *
 * ─── Setup requirement (out-of-band) ──────────────────────────────
 * These fields are NOT subscribed to by default. In Meta App Dashboard
 * → WhatsApp → Configuration → Webhooks, you must explicitly toggle
 * each of the three fields above. There is no API to do this for
 * Cloud API apps — it's a one-time manual step per app. Until that's
 * done, status updates only land via the manual "Sync from Meta"
 * button (the legacy fallback, intentionally preserved).
 *
 * ─── Multi-tenant note ────────────────────────────────────────────
 * `meta_template_id` is globally unique per WABA — the lookup doesn't
 * filter by account (the event carries none; Meta's id already names
 * one tenant's template). If two wacrm tenants somehow ended up with the
 * same id (impossible in practice, but a theoretical race during
 * cross-tenant moves), the handler updates both rows and logs a
 * warning so operators can investigate.
 *
 * ─── Unknown templates (issue #534) ───────────────────────────────
 * A template created directly in Meta Business Manager has no local
 * row until someone presses "Sync from Meta", so its status / quality
 * events used to match 0 rows and be dropped. Both handlers now fall
 * back to creating a stub row: the WABA id on the webhook entry
 * resolves the owning account via `whatsapp_config.waba_id`, and the
 * stub carries the identity (name / language / meta_template_id) plus
 * whatever the event told us (status, rejection reason, quality
 * score). Components are NOT known at this point — `body_text` is
 * stored as '' (the same placeholder the sync route uses for a
 * body-less template) and "Sync from Meta" backfills them, matching
 * the stub on (account_id, name, language).
 */

import { asService } from '@/server/db'
import {
  insertTemplateStub,
  listConfigOwnersByWabaId,
  updateTemplatesByMetaId,
  type TemplateEventPatch,
} from '@/server/repos/inbound-templates'
import { normalizeStatus } from './template-status-normalize'

const TEMPLATE_WEBHOOK_FIELDS = new Set([
  'message_template_status_update',
  'message_template_quality_update',
  'message_template_components_update',
])

export function isTemplateWebhookField(field: string): boolean {
  return TEMPLATE_WEBHOOK_FIELDS.has(field)
}

interface TemplateStatusUpdateValue {
  event?: string
  message_template_id?: string | number
  message_template_name?: string
  message_template_language?: string
  reason?: string
}

interface TemplateQualityUpdateValue {
  message_template_id?: string | number
  message_template_name?: string
  message_template_language?: string
  previous_quality_score?: string
  new_quality_score?: string
}

interface TemplateComponentsUpdateValue {
  message_template_id?: string | number
  message_template_name?: string
  message_template_language?: string
}

export interface TemplateWebhookChange {
  field: string
  value: unknown
  /**
   * `entry.id` from the webhook envelope — for template events this is
   * the WABA id. Optional so existing callers / tests keep working;
   * without it an unknown template can only be logged, not stubbed.
   */
  wabaId?: string
}

/** `body_text` is NOT NULL; the sync route uses '' for a body-less template too. */
const STUB_BODY_TEXT = ''
const DEFAULT_TEMPLATE_LANGUAGE = 'en_US'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Run the event's UPDATE (keyed on meta_template_id) in its own short
 * service-role transaction. Returns the touched ids, or null after
 * logging when the statement failed.
 */
async function applyUpdate(
  kind: string,
  metaTemplateId: string,
  update: TemplateEventPatch,
): Promise<string[] | null> {
  try {
    return await asService((db) =>
      updateTemplatesByMetaId(db, metaTemplateId, update),
    )
  } catch (err) {
    console.error(
      `[template-webhook] ${kind} failed for meta_template_id`,
      metaTemplateId,
      errorMessage(err),
    )
    return null
  }
}

/**
 * Dispatch a single change record to the matching handler. Returns
 * silently on unrecognised fields — the caller already pre-filtered
 * via isTemplateWebhookField, but treat unknown values as no-ops
 * defensively in case Meta adds new template fields later.
 *
 * Every database step runs in its own short service-role transaction;
 * failures are logged, never thrown.
 */
export async function handleTemplateWebhookChange(
  change: TemplateWebhookChange,
): Promise<void> {
  switch (change.field) {
    case 'message_template_status_update':
      await handleStatusUpdate(
        change.value as TemplateStatusUpdateValue,
        change.wabaId,
      )
      return
    case 'message_template_quality_update':
      await handleQualityUpdate(
        change.value as TemplateQualityUpdateValue,
        change.wabaId,
      )
      return
    case 'message_template_components_update':
      handleComponentsUpdate(
        change.value as TemplateComponentsUpdateValue,
      )
      return
  }
}

async function handleStatusUpdate(
  value: TemplateStatusUpdateValue,
  wabaId: string | undefined,
): Promise<void> {
  const metaTemplateId =
    value.message_template_id !== undefined
      ? String(value.message_template_id)
      : null
  if (!metaTemplateId || !value.event) {
    console.warn(
      '[template-webhook] status update missing message_template_id or event:',
      value,
    )
    return
  }

  const status = normalizeStatus(value.event)

  // Persist the rejection reason on REJECTED — that's the only event
  // where Meta sends a human-readable explanation. Clear it on any
  // other status flip so the UI doesn't show a stale REJECTED banner
  // after Meta re-approves a resubmitted template.
  const update: TemplateEventPatch = {
    status,
    rejection_reason:
      status === 'REJECTED' ? value.reason ?? 'Rejected by Meta' : null,
    submission_error: null,
  }

  const ids = await applyUpdate('status update', metaTemplateId, update)
  if (!ids) return
  if (ids.length === 0) {
    await createStubForUnknownTemplate({
      kind: 'status update',
      metaTemplateId,
      name: value.message_template_name,
      language: value.message_template_language,
      wabaId,
      fields: update,
    })
    return
  }
  if (ids.length > 1) {
    console.warn(
      `[template-webhook] status update matched ${ids.length} rows for meta_template_id ${metaTemplateId} — investigate.`,
    )
  }
}

async function handleQualityUpdate(
  value: TemplateQualityUpdateValue,
  wabaId: string | undefined,
): Promise<void> {
  const metaTemplateId =
    value.message_template_id !== undefined
      ? String(value.message_template_id)
      : null
  if (!metaTemplateId) {
    console.warn(
      '[template-webhook] quality update missing message_template_id:',
      value,
    )
    return
  }

  const raw = value.new_quality_score
  const score =
    raw && ['GREEN', 'YELLOW', 'RED'].includes(raw.toUpperCase())
      ? (raw.toUpperCase() as 'GREEN' | 'YELLOW' | 'RED')
      : null

  const update: TemplateEventPatch = { quality_score: score }
  const ids = await applyUpdate('quality update', metaTemplateId, update)
  if (!ids) return
  if (ids.length === 0) {
    // A quality event carries no status. Leave `status` to the column
    // default (DRAFT) rather than guessing APPROVED — Meta does score
    // PAUSED templates too. "Sync from Meta" fixes it up.
    await createStubForUnknownTemplate({
      kind: 'quality update',
      metaTemplateId,
      name: value.message_template_name,
      language: value.message_template_language,
      wabaId,
      fields: update,
    })
  }
}

interface StubParams {
  /** For log lines — 'status update' | 'quality update'. */
  kind: string
  metaTemplateId: string
  name: string | undefined
  language: string | undefined
  wabaId: string | undefined
  /** Event-derived columns (status / rejection_reason / quality_score). */
  fields: TemplateEventPatch
}

/**
 * 0-row fallback shared by the status and quality handlers: resolve
 * the tenant from the WABA id and insert a stub `message_templates`
 * row so the event isn't lost. Every early-return path logs the WABA
 * id so an operator can tell which tenant needs a "Sync from Meta".
 *
 * NOTE: the sync itself is not triggered here. Its logic lives inside
 * the POST handler of /api/whatsapp/templates/sync (behind
 * requireRole('admin') and the caller's session), so there is nothing
 * reusable from a webhook context without refactoring that route.
 * The stub is enough for the status / quality to show up in the UI;
 * components arrive on the next manual sync.
 */
async function createStubForUnknownTemplate(p: StubParams): Promise<void> {
  const { kind, metaTemplateId, name, wabaId } = p
  const where = `meta_template_id ${metaTemplateId} (${name ?? 'unnamed'}), WABA ${wabaId ?? 'unknown'}`

  if (!wabaId) {
    console.warn(
      `[template-webhook] ${kind} for unknown template ${where} — no WABA id on the webhook entry, cannot resolve the account; run "Sync from Meta".`,
    )
    return
  }
  if (!name) {
    console.warn(
      `[template-webhook] ${kind} for unknown template ${where} — event has no message_template_name, cannot create a stub row; run "Sync from Meta".`,
    )
    return
  }

  let rows: { account_id: string; user_id: string }[]
  try {
    rows = await asService((db) => listConfigOwnersByWabaId(db, wabaId))
  } catch (err) {
    console.error(
      `[template-webhook] ${kind} for unknown template ${where} — whatsapp_config lookup failed:`,
      errorMessage(err),
    )
    return
  }
  if (rows.length !== 1) {
    console.warn(
      `[template-webhook] ${kind} for unknown template ${where} — ${rows.length === 0 ? 'no' : rows.length} whatsapp_config rows match that WABA id; not creating a stub. Run "Sync from Meta" for the owning account.`,
    )
    return
  }

  const config = rows[0]
  // account_id is tenancy; user_id is the NOT NULL audit FK — the
  // config owner, same convention the webhook uses for inbound writes.
  // `category` and `status` fall back to their column defaults unless
  // the event supplied them (status events do, quality events don't).
  const stub = {
    account_id: config.account_id,
    user_id: config.user_id,
    meta_template_id: metaTemplateId,
    name,
    language: p.language || DEFAULT_TEMPLATE_LANGUAGE,
    body_text: STUB_BODY_TEXT,
    ...p.fields,
  }

  let inserted: boolean
  try {
    // ON CONFLICT DO NOTHING: a unique-index conflict comes back as
    // `false` instead of an aborted statement.
    inserted = await asService((db) => insertTemplateStub(db, stub))
  } catch (err) {
    console.error(
      `[template-webhook] ${kind} for unknown template ${where} — stub insert failed:`,
      errorMessage(err),
    )
    return
  }

  if (inserted) {
    console.info(
      `[template-webhook] ${kind} for unknown template ${where} — created stub row for account ${config.account_id}; run "Sync from Meta" to backfill components.`,
    )
    return
  }

  // Conflict: either a concurrent sync/webhook just created the row, or
  // the account already has a local (user_id, name, language) row that
  // isn't linked to this meta_template_id. Retry the original UPDATE
  // once — it covers the first case; the second still needs a sync and
  // is logged as such.
  let ids: string[]
  try {
    ids = await asService((db) =>
      updateTemplatesByMetaId(db, metaTemplateId, p.fields),
    )
  } catch (err) {
    console.error(
      `[template-webhook] ${kind} for unknown template ${where} — retry after unique violation failed:`,
      errorMessage(err),
    )
    return
  }
  if (ids.length === 0) {
    console.warn(
      `[template-webhook] ${kind} for unknown template ${where} — a local row with the same name/language exists but is not linked to this meta_template_id; run "Sync from Meta" to link it.`,
    )
  }
}

/**
 * Meta auto-modified the template (typically a category reclassification
 * — e.g. Marketing → Utility after content review).
 *
 * For v1 we just log and let the user pull updated components via the
 * existing "Sync from Meta" button — persisting Meta's modified
 * components without showing the user would silently change what they
 * thought they submitted. A future PR could mark the row with a
 * "Meta modified this template" banner.
 */
function handleComponentsUpdate(value: TemplateComponentsUpdateValue): void {
  console.info(
    '[template-webhook] components updated by Meta for template',
    value.message_template_id,
    value.message_template_name,
    '— run "Sync from Meta" in Settings to pull the new components.',
  )
}
