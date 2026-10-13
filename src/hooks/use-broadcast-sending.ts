'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import {
  BATCH_SEND_ATTEMPTS,
  batchRetryDelayMs,
} from '@/lib/broadcast-retry';
import type { AudienceConfig } from '@/lib/broadcast-audience';
import type { VariableMapping } from '@/lib/broadcast-variables';
import {
  createBroadcast,
  recordRecipientResults,
  setBroadcastStatus,
  type RecipientResultInput,
} from '@/lib/broadcasts/broadcasts-api';
import { MessageTemplate } from '@/types';
import { getT } from '@/lib/i18n/translate';

export type {
  AudienceConfig,
  CustomFieldFilter,
  CustomFieldOperator,
} from '@/lib/broadcast-audience';
export { resolveVariables, type VariableMapping } from '@/lib/broadcast-variables';

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Passed through as `messageParams.headerMediaUrl`; the builder
   * falls back to the template's stored URL only when this is empty.
   */
  headerMediaUrl?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Meta rate-limit buffer. 10 per batch + 1 s pause matches the spec
 * and keeps us comfortably under Meta's per-phone-number messaging
 * rate so a large broadcast never trips the upstream limiter.
 *
 * Note this shape when touching `RATE_LIMITS.broadcast`: a campaign is
 * many calls to `/api/whatsapp/broadcast`, not one. A 1 000-recipient
 * send is ~100 calls over several minutes, and a bucket sized for
 * "one call per campaign" throttles most of it away (issue #472).
 */
const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const t = getT('Broadcasts.sending');
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    try {
      if (!accountId) {
        throw new Error(t('notLinkedToAccount'));
      }

      // ── Steps 1–3: resolve audience, create broadcast + recipients ──
      // One server call (POST /api/broadcasts): it resolves the audience
      // (creating contacts for CSV numbers the account lacks), freezes
      // each recipient's template params on its row — what makes the
      // campaign resumable server-side if this tab goes away (issue
      // #472) — and inserts the broadcast + recipients atomically.
      setProgress(5);
      const { data: created, error: createError } = await createBroadcast({
        name: payload.name,
        template_name: payload.template.name,
        template_language: payload.template.language ?? 'en_US',
        template_variables: payload.variables,
        audience: {
          type: payload.audience.type,
          tagIds: payload.audience.tagIds,
          customField: payload.audience.customField,
          csvContacts: payload.audience.csvContacts,
          excludeTagIds: payload.audience.excludeTagIds,
        },
      });
      if (createError) {
        if (createError.code === 'no_contacts') {
          throw new Error(t('noContactsForAudience'));
        }
        throw new Error(
          t('createBroadcastFailed', {
            error: createError.message || t('unknownErrorLower'),
          }),
        );
      }
      const broadcast = created.broadcast;
      const recipients = created.recipients;

      // ── Step 4: send in rate-limited batches ──────────────────────
      setProgress(30);
      let failedCount = 0;
      const totalRecipients = recipients.length;

      // Media-header templates (image/video/document) require a media
      // URL on every send. Collected in the personalize step and applied
      // to all recipients; falls back to the template's stored URL on the
      // server when omitted.
      const headerType = payload.template.header_type;
      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType === 'document';
      const headerMediaUrl = payload.headerMediaUrl?.trim();
      const messageParams =
        isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.phone)
          .map((r) => ({
            phone: r.phone as string,
            // Read back off the row rather than re-resolved, so this
            // pass and any later resume send identical params.
            params: Array.isArray(r.template_params) ? r.template_params : [],
            ...(messageParams ? { messageParams } : {}),
          }));

        if (apiRecipients.length === 0) continue;

        try {
          // Send the batch, waiting out a 429 rather than writing the
          // whole batch off as failed. Only 429 is replayed — see
          // batchRetryDelayMs for why nothing else can be.
          let data: { error?: string; results?: BroadcastApiResult[] } = {};
          for (let attempt = 1; ; attempt++) {
            const res = await fetch('/api/whatsapp/broadcast', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                recipients: apiRecipients,
                template_name: payload.template.name,
                template_language: payload.template.language ?? 'en_US',
              }),
            });

            data = await res.json();
            if (res.ok) break;

            const retryIn =
              attempt < BATCH_SEND_ATTEMPTS
                ? batchRetryDelayMs(res.status, res.headers.get('Retry-After'))
                : null;
            if (retryIn === null) {
              throw new Error(data.error || t('apiRequestFailed'));
            }
            await sleep(retryIn);
          }

          const resultsByPhone = new Map<string, BroadcastApiResult>();
          for (const r of (data.results ?? []) as BroadcastApiResult[]) {
            resultsByPhone.set(r.phone, r);
          }

          const stamps: RecipientResultInput[] = [];
          for (const recipient of batch) {
            const phone = recipient.phone;
            const result = phone ? resultsByPhone.get(phone) : undefined;

            if (!result) {
              failedCount++;
              stamps.push({
                id: recipient.id,
                status: 'failed',
                error_message: t('noPhoneOnContact'),
              });
              continue;
            }

            if (result.status === 'sent') {
              stamps.push({
                id: recipient.id,
                status: 'sent',
                whatsapp_message_id: result.whatsapp_message_id ?? null,
              });
            } else {
              failedCount++;
              stamps.push({
                id: recipient.id,
                status: 'failed',
                error_message: result.error ?? t('unknownError'),
              });
            }
          }
          // Best-effort, like the per-row writes it replaces: a failed
          // stamp leaves the row 'pending', which Resume picks up.
          await recordRecipientResults(broadcast.id, stamps);
        } catch (err) {
          const message = err instanceof Error ? err.message : t('unknownError');
          failedCount += batch.length;
          await recordRecipientResults(
            broadcast.id,
            batch.map((recipient) => ({
              id: recipient.id,
              status: 'failed' as const,
              error_message: message,
            })),
          );
        }

        const progressPct =
          30 + Math.round(((i + batch.length) / totalRecipients) * 60);
        setProgress(progressPct);

        if (i + SEND_BATCH_SIZE < recipients.length) {
          await sleep(SEND_BATCH_DELAY_MS);
        }
      }

      // ── Step 5: Finalize status ───────────────────────────────────
      // Aggregate counts are maintained by the DB trigger (migration
      // 003); we only flip the final status here.
      setProgress(95);
      const finalStatus = failedCount === totalRecipients ? 'failed' : 'sent';
      await setBroadcastStatus(broadcast.id, finalStatus);

      setProgress(100);
      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
