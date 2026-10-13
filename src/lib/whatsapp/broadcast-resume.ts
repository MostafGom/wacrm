// ============================================================
// Broadcast resume / retry (issue #472).
//
// The dashboard wizard drives its own send loop from the browser tab
// that started the campaign, so closing the tab abandons the campaign
// mid-flight: the remaining recipients stay 'pending' and the
// broadcast sits in 'sending' forever. This module is the recovery —
// and the same machinery answers the reporter's other two asks,
// "reprocess pending" and "reprocess failed".
//
// It deliberately reuses `deliverBroadcast` rather than growing a
// second fan-out loop: same phone-variant retry, same per-recipient
// stamping, same trigger-owned counts.
//
// What it does NOT do is move the *initial* send server-side. The
// wizard still owns that; this makes an abandoned one recoverable.
// ============================================================

import { BroadcastError, type BroadcastPlan } from '@/lib/whatsapp/broadcast-core';
import { decrypt } from '@/lib/whatsapp/encryption';
import { pickTemplateRow } from '@/lib/whatsapp/template-body';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import type { Db, Runner } from '@/server/db';
import {
  claimDeliveryLock,
  failRecipients,
  getBroadcast,
  loadRecipientsForResume,
  releaseDeliveryLock,
  setBroadcastTerminalStatus,
} from '@/server/repos/broadcasts';
import { getWhatsappConfig, listTemplatesByName } from '@/server/repos/templates';

/** Which recipients a resume pass picks up. */
export type ResumeScope = 'pending' | 'failed' | 'all';

export const RESUME_SCOPES: readonly ResumeScope[] = [
  'pending',
  'failed',
  'all',
];

/**
 * Recipients delivered per resume request. One pass runs inside
 * `after()`, so it is bounded by the host's function timeout — the cap
 * keeps a 5 000-recipient backlog from being one un-completable unit
 * of work. Whatever is left stays 'pending' and the caller is told how
 * many, so the UI can offer Resume again. Matches the public API's
 * per-request recipient cap.
 */
export const RESUME_MAX_PER_REQUEST = 1000;

/**
 * How long a `delivery_locked_at` stamp is honoured before it is read
 * as abandoned. Long enough that a legitimately slow pass is never
 * stolen from, short enough that a crashed one doesn't wedge the
 * campaign until someone touches the database.
 */
export const DELIVERY_LOCK_STALE_MS = 30 * 60 * 1000;

function scopeStatuses(scope: ResumeScope): string[] {
  if (scope === 'pending') return ['pending'];
  if (scope === 'failed') return ['failed'];
  return ['pending', 'failed'];
}

/**
 * Take the delivery lock for a broadcast.
 *
 * One conditional UPDATE, so the claim is atomic: a concurrent caller's
 * WHERE no longer matches and it gets `false`. Returns false when the
 * broadcast doesn't exist on this account, too — the caller treats both
 * as "not yours to run".
 */
export async function claimBroadcastDelivery(
  db: Db,
  accountId: string,
  broadcastId: string,
  now: Date = new Date()
): Promise<boolean> {
  const staleCutoff = new Date(now.getTime() - DELIVERY_LOCK_STALE_MS);
  return claimDeliveryLock(db, accountId, broadcastId, now, staleCutoff);
}

/** Release the delivery lock. Best-effort; a stale lock self-expires. */
export async function releaseBroadcastDelivery(
  db: Db,
  accountId: string,
  broadcastId: string
): Promise<void> {
  try {
    await releaseDeliveryLock(db, accountId, broadcastId);
  } catch (err) {
    console.error(
      '[broadcast-resume] release failed:',
      err instanceof Error ? err.message : err
    );
  }
}

export interface ResumePlan {
  plan: BroadcastPlan;
  /** In-scope recipients left over after the per-request cap. */
  remaining: number;
  /**
   * In-scope rows that can never send because their contact has no
   * usable phone. Stamped 'failed' by {@link planBroadcastResume} so
   * they stop blocking the broadcast's terminal status.
   */
  unsendable: number;
}

/**
 * Build a {@link BroadcastPlan} for the recipients of an existing
 * broadcast that still need sending.
 *
 * Params come off the recipient rows (frozen at plan time by migration
 * 038) rather than being re-resolved from contact data, so a resume
 * sends what the original pass would have sent even if the contact has
 * been edited since.
 *
 * Throws {@link BroadcastError}; the route maps it.
 */
export async function planBroadcastResume(
  run: Runner,
  accountId: string,
  broadcastId: string,
  scope: ResumeScope
): Promise<ResumePlan> {
  const statuses = scopeStatuses(scope);
  const loaded = await run(async (db) => {
    const broadcast = await getBroadcast(db, accountId, broadcastId);
    if (!broadcast) return null;
    const recipients = await loadRecipientsForResume(
      db,
      accountId,
      broadcastId,
      statuses,
      RESUME_MAX_PER_REQUEST
    );
    return { broadcast, ...recipients };
  });

  if (!loaded) {
    throw new BroadcastError('not_found', 'Broadcast not found', 404);
  }
  const { broadcast, rows, inScope } = loaded;

  // A recipient whose contact has no usable phone can never send. Stamp
  // it failed now (its own transaction, so it sticks even when this
  // pass then finds nothing to send): leaving it 'pending' would keep
  // the broadcast in 'sending' forever, which is the very symptom
  // being fixed.
  const sendable: typeof rows = [];
  const unsendable: string[] = [];
  for (const row of rows) {
    const sanitized = sanitizePhoneForMeta(row.phone ?? '');
    if (isValidE164(sanitized)) sendable.push(row);
    else unsendable.push(row.id);
  }
  if (unsendable.length > 0) {
    await run((db) =>
      failRecipients(
        db,
        accountId,
        broadcastId,
        unsendable,
        'No valid phone number on contact'
      )
    );
  }

  const slice = sendable.slice(0, RESUME_MAX_PER_REQUEST);
  const unloaded = Math.max(0, inScope - rows.length);
  const remaining = sendable.length - slice.length + unloaded;

  if (slice.length === 0) {
    throw new BroadcastError(
      'nothing_to_resume',
      scope === 'failed'
        ? 'This broadcast has no failed recipients to retry'
        : 'This broadcast has no recipients left to send',
      400
    );
  }

  const { config, templateRows } = await run(async (db) => ({
    config: await getWhatsappConfig(db, accountId),
    templateRows: await listTemplatesByName(db, accountId, broadcast.template_name),
  }));
  if (!config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  const resolvedTemplate = pickTemplateRow(templateRows, broadcast.template_language);
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before resuming.',
      500
    );
  }

  const plan: BroadcastPlan = {
    accountId,
    broadcastId,
    templateName: broadcast.template_name,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
    templateRow: resolvedTemplate.row,
    planned: slice.map((row) => ({
      recipientRowId: row.id,
      phone: sanitizePhoneForMeta(row.phone ?? ''),
      params: Array.isArray(row.template_params)
        ? row.template_params.filter((p): p is string => typeof p === 'string')
        : [],
    })),
    rejected: 0,
  };

  return { plan, remaining, unsendable: unsendable.length };
}

/**
 * Put the broadcast back into `sending` for the duration of the pass,
 * so the detail page reads as in-flight rather than as a finished
 * campaign that is quietly still working.
 */
export async function markBroadcastSending(
  db: Db,
  accountId: string,
  broadcastId: string
): Promise<void> {
  await setBroadcastTerminalStatus(db, accountId, broadcastId, 'sending');
}
