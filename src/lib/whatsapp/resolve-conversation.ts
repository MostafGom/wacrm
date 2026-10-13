// ============================================================
// Resolve (or create) the conversation for a phone number.
//
// The dashboard composer always has a `conversation_id` in hand. The
// public API doesn't — an external automation knows a *phone number*,
// not an internal UUID. This helper bridges that: given an E.164
// phone, it finds-or-creates the contact and its conversation so the
// shared `sendMessageToConversation` core can run unchanged.
//
// It deliberately reuses the exact find-or-create logic the inbound
// webhook uses (the `findExistingContact` dedupe helper, the
// one-conversation-per-(account, contact) convention, the
// account_id-tenancy / user_id-audit split) so a contact created via
// the API is indistinguishable from one created by an inbound message.
//
// Audit user: created rows need a NOT NULL `user_id`. As with the
// webhook (where there's no logged-in human either), we attribute
// them to the WhatsApp config owner — a stable account-level default.
// ============================================================

import type { Runner } from '@/server/db';
import { insertContact, updateContact } from '@/server/repos/contacts';
import { findOrCreateConversationId } from '@/server/repos/conversations';
import { getWhatsAppSendConfig } from '@/server/repos/messages';
import { findExistingContact } from '@/lib/contacts/dedupe';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';

export interface ResolvedConversation {
  conversationId: string;
  contactId: string;
  /** True if this call created the contact (vs matched an existing one). */
  contactCreated: boolean;
}

/**
 * Find or create the contact + conversation for `phone` within
 * `accountId`. Throws `SendMessageError` (shared with the send core,
 * so the route maps one error family) on a bad phone, a missing
 * WhatsApp config, or a DB failure.
 */
export async function resolveConversationByPhone(
  run: Runner,
  accountId: string,
  phone: string,
  name?: string | null
): Promise<ResolvedConversation> {
  // Raw integrator input: the leading `+` is required so the country
  // code is explicit — "4155551212" would otherwise be delivered to
  // Switzerland, not the US (issue #586).
  const sanitized = parseInternationalPhone(phone);
  if (!sanitized) {
    throw new SendMessageError(
      'bad_request',
      "'to' must be an international phone number with a leading + and country code (e.g. +14155550123)",
      400
    );
  }

  // Fail fast (and create nothing) when the account has no WhatsApp
  // connected — the same error the send would raise anyway.
  const config = await run((db) => getWhatsAppSendConfig(db, accountId));
  if (!config) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  // Audit user for created rows = the single account-wide default used
  // by every public-API write (see resolveAuditUserId), so a contact
  // created here is attributed identically to one created via
  // POST /api/v1/contacts. resolveAuditUserId throws ContactError only
  // if the owner can't be resolved — remap it to the send error family
  // the callers already handle.
  let ownerUserId: string;
  try {
    ownerUserId = await run((db) => resolveAuditUserId(db, accountId));
  } catch (err) {
    if (err instanceof ContactError) {
      throw new SendMessageError('db_error', err.message, err.status);
    }
    throw err;
  }

  // ---- contact -------------------------------------------------
  let contactId: string;
  let contactCreated = false;

  const existing = await run((db) => findExistingContact(db, accountId, sanitized));
  if (existing) {
    contactId = existing.id;
    if (name && name !== existing.name) {
      await run((db) => updateContact(db, accountId, existing.id, { name }));
    }
  } else {
    let created: { id: string } | undefined;
    try {
      created = await run((db) =>
        insertContact(db, {
          account_id: accountId,
          user_id: ownerUserId,
          phone: sanitized,
          name: name || sanitized,
        })
      );
    } catch (createErr) {
      console.error('[resolve-conversation] contact create error:', createErr);
      throw new SendMessageError('db_error', 'Failed to create contact', 500);
    }

    if (created) {
      contactId = created.id;
      contactCreated = true;
    } else {
      // Lost a race against a concurrent inbound/API create — the
      // unique index (migration 022) kept the other row (ON CONFLICT DO
      // NOTHING returned nothing). Re-resolve it.
      const raced = await run((db) => findExistingContact(db, accountId, sanitized));
      if (!raced) {
        throw new SendMessageError('db_error', 'Failed to create contact', 500);
      }
      contactId = raced.id;
    }
  }

  // ---- conversation -------------------------------------------
  // One conversation per (account, contact) — same convention as the
  // webhook. The lookup orders oldest-first and takes one row: if
  // duplicates predate the unique index (migration 036), we resolve to
  // the canonical survivor instead of creating yet another (issue #363).
  // A concurrent create is absorbed by ON CONFLICT DO NOTHING + re-read.
  let conversationId: string | undefined;
  try {
    conversationId = await run((db) =>
      findOrCreateConversationId(db, accountId, contactId, ownerUserId)
    );
  } catch (convErr) {
    console.error('[resolve-conversation] conversation resolve error:', convErr);
    throw new SendMessageError('db_error', 'Failed to create conversation', 500);
  }
  if (!conversationId) {
    throw new SendMessageError('db_error', 'Failed to create conversation', 500);
  }

  return { conversationId, contactId, contactCreated };
}
