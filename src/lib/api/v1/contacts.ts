// ============================================================
// Shared contact logic for the public API (v1) contact endpoints.
//
// Kept out of the route files so `GET/POST /api/v1/contacts` and
// `GET/PATCH /api/v1/contacts/{id}` share one serializer, one
// find-or-create (built on the same `findExistingContact` dedupe the
// webhook and send path use), and one tag-sync routine.
// ============================================================

import type { Db, Runner } from '@/server/db';

import { findExistingContact } from '@/lib/contacts/dedupe';
import { getContactWithTags } from '@/server/repos/contacts';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';

export interface ApiContact {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  avatar_url: string | null;
  tags: { id: string; name: string; color: string }[];
  created_at: string;
  updated_at: string;
}

/** Thrown by the helpers below; routes map `.status`/`.message`. */
export class ContactError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ContactError';
    this.status = status;
  }
}

type RawTagJoin = { tags: { id: string; name: string; color: string } | null };

/** Flatten a contact row with its `contact_tags` embed into the public contact shape. */
export function serializeContact(row: Record<string, unknown>): ApiContact {
  const joins = (row.contact_tags as RawTagJoin[] | undefined) ?? [];
  return {
    id: row.id as string,
    phone: row.phone as string,
    name: (row.name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    company: (row.company as string | null) ?? null,
    avatar_url: (row.avatar_url as string | null) ?? null,
    tags: joins
      .map((j) => j.tags)
      .filter((t): t is NonNullable<RawTagJoin['tags']> => t != null)
      .map((t) => ({ id: t.id, name: t.name, color: t.color })),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Resolve the audit `user_id` for API-created rows — the SINGLE source
 * of truth used by every public-API write (contacts, messages,
 * broadcasts, resolve-conversation), so the same key's writes are
 * always attributed to the same human. API callers have no logged-in
 * user, so — like the inbound webhook — we attribute writes to the
 * **WhatsApp config owner** (the webhook's own convention). Contacts
 * can be created before WhatsApp is connected, so we fall back to the
 * account owner when there's no config yet.
 */
export async function resolveAuditUserId(
  db: Db,
  accountId: string
): Promise<string> {
  const config = await db
    .selectFrom('whatsapp_config')
    .select('user_id')
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  if (config?.user_id) return config.user_id;

  const account = await db
    .selectFrom('accounts')
    .select('owner_user_id')
    .where('id', '=', accountId)
    .executeTakeFirst();
  const owner = account?.owner_user_id;
  if (!owner) {
    throw new ContactError('Account owner could not be resolved', 500);
  }
  return owner;
}

export interface ContactInput {
  phone: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
}

/**
 * Find (by fuzzy phone match) or create a contact in `accountId`.
 * Returns the contact id and whether it was created. Reuses the shared
 * `findExistingContact` dedupe + unique-violation race backstop so an
 * API-created contact is indistinguishable from a webhook-created one.
 */
export async function findOrCreateContact(
  db: Db,
  accountId: string,
  auditUserId: string,
  input: ContactInput
): Promise<{ id: string; created: boolean }> {
  // Raw integrator input: the leading `+` is required so the country
  // code is explicit. A national-format number ("4155551212") would
  // otherwise be persisted and then misdelivered on every later send
  // (issue #586).
  const sanitized = parseInternationalPhone(input.phone);
  if (!sanitized) {
    throw new ContactError(
      "'phone' must be an international phone number with a leading + and country code (e.g. +14155550123)",
      400
    );
  }

  const existing = await findExistingContact(db, accountId, sanitized);
  if (existing) return { id: existing.id, created: false };

  const created = await db
    .insertInto('contacts')
    .values({
      account_id: accountId,
      user_id: auditUserId,
      phone: sanitized,
      name: input.name ?? sanitized,
      email: input.email ?? null,
      company: input.company ?? null,
    })
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst();

  if (!created) {
    // Lost a race against a concurrent create — the unique index
    // held the number. Re-resolve to the winner.
    const raced = await findExistingContact(db, accountId, sanitized);
    if (raced) return { id: raced.id, created: false };
    throw new ContactError('Failed to create contact', 500);
  }

  return { id: created.id, created: true };
}

/**
 * Replace a contact's tags to exactly match `tagNames` (case-
 * insensitive; missing tags are created). Pass `[]` to clear all tags.
 * Reuses `resolveImportTagIds` so API and CSV-import tag handling stay
 * consistent — but note its `tagIdByKey` map holds EVERY tag in the
 * account (it loads them all for case-insensitive matching), so the
 * desired set must be derived from the *requested* names only, never
 * from the map's values (#560).
 */
export async function setContactTags(
  run: Runner,
  accountId: string,
  auditUserId: string,
  contactId: string,
  tagNames: string[]
): Promise<void> {
  const { tagIdByKey } = await run((db) =>
    resolveImportTagIds(db, {
      accountId,
      userId: auditUserId,
      tagNames,
      canCreateTags: true,
    })
  );
  // Same normalization `resolveImportTagIds` applies to `tagNames`
  // (trim, lowercase, skip empty) so every requested name resolves.
  const desired = new Set<string>();
  for (const raw of tagNames) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const tagId = tagIdByKey.get(key);
    if (tagId) desired.add(tagId);
  }

  // Diff against the current joins rather than delete-all-then-insert:
  // a diff only touches tags that actually change, so a mid-operation
  // failure can never wipe tags that were meant to stay. Every write
  // is error-checked and surfaced as a ContactError (→ 500) instead of
  // being swallowed behind a misleading 200.
  const current = await run((db) =>
    db.selectFrom('contact_tags').select('tag_id').where('contact_id', '=', contactId).execute()
  );
  const existing = new Set(current.map((r) => r.tag_id));

  const toAdd = [...desired].filter((id) => !existing.has(id));
  const toRemove = [...existing].filter((id) => !desired.has(id));

  if (toRemove.length > 0) {
    await run((db) =>
      db
        .deleteFrom('contact_tags')
        .where('contact_id', '=', contactId)
        .where('tag_id', 'in', toRemove)
        .execute()
    );
  }
  if (toAdd.length > 0) {
    for (const tagId of toAdd) {
      try {
        await addContactTagAndDispatch({
          run,
          accountId,
          contactId,
          tagId,
        });
      } catch (error) {
        console.error('[api/v1/contacts] tag add failed:', error);
        throw new ContactError('Failed to update contact tags', 500);
      }
    }
  }
}

/** Fetch + serialize a single contact scoped to the account, or null. */
export async function getContactById(
  db: Db,
  accountId: string,
  contactId: string
): Promise<ApiContact | null> {
  const row = await getContactWithTags(db, accountId, contactId);
  return row ? serializeContact(row as unknown as Record<string, unknown>) : null;
}
