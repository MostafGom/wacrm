import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from '@/server/db';

// ------------------------------------------------------------
// The resolver orchestrates repository calls through a Runner; each
// repo is faked here from a per-test script. The SQL itself (ON
// CONFLICT, oldest-first lookup, the unique-index race) is covered by
// src/server/repos/conversations.int.test.ts against real Postgres.
// ------------------------------------------------------------

type ContactRow = { id: string; phone: string; name?: string | null };

interface Script {
  config?: { id: string } | null;
  owner?: string | null;
  /** findExistingContact results per call (last one repeats). */
  existingByCall?: (ContactRow | null)[];
  /** insertContact result: the new id, or null for "ON CONFLICT kept another row". */
  insertedContactId?: string | null;
  insertContactThrows?: boolean;
  /** findOrCreateConversationId result, or null for "nothing". */
  conversationId?: string | null;
}

const h = vi.hoisted(() => ({
  script: {} as Script,
  findCalls: 0,
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  convArgs: [] as unknown[][],
}));

vi.mock('@/server/repos/messages', () => ({
  getWhatsAppSendConfig: async () => h.script.config ?? undefined,
}));

vi.mock('@/lib/api/v1/contacts', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api/v1/contacts')>();
  return {
    ...real,
    resolveAuditUserId: async () => {
      if (!h.script.owner) {
        throw new real.ContactError('Account owner could not be resolved', 500);
      }
      return h.script.owner;
    },
  };
});

vi.mock('@/lib/contacts/dedupe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contacts/dedupe')>()),
  findExistingContact: async () => {
    const list = h.script.existingByCall ?? [null];
    const row = list[Math.min(h.findCalls, list.length - 1)];
    h.findCalls++;
    return row;
  },
}));

vi.mock('@/server/repos/contacts', () => ({
  insertContact: async (_db: unknown, values: Record<string, unknown>) => {
    if (h.script.insertContactThrows) throw new Error('boom');
    h.inserts.push(values);
    return h.script.insertedContactId ? { id: h.script.insertedContactId } : undefined;
  },
  updateContact: async (
    _db: unknown,
    _accountId: string,
    id: string,
    patch: Record<string, unknown>
  ) => {
    h.updates.push({ id, ...patch });
  },
}));

vi.mock('@/server/repos/conversations', () => ({
  findOrCreateConversationId: async (...args: unknown[]) => {
    h.convArgs.push(args.slice(1));
    return h.script.conversationId ?? undefined;
  },
}));

import { resolveConversationByPhone } from './resolve-conversation';
import { SendMessageError } from './send-message';

const run: Runner = (fn) => fn({} as never);
const noDb: Runner = () => {
  throw new Error('should not query');
};

beforeEach(() => {
  h.script = {};
  h.findCalls = 0;
  h.inserts = [];
  h.updates = [];
  h.convArgs = [];
});

describe('resolveConversationByPhone', () => {
  it('rejects an invalid phone before any DB call', async () => {
    await expect(
      resolveConversationByPhone(noDb, 'acct', 'not-a-phone')
    ).rejects.toBeInstanceOf(SendMessageError);
  });

  it('rejects a national-format number (no leading +) before any DB call (#586)', async () => {
    // Would otherwise be sent to +41 55 555 12 12 (Switzerland) and
    // reported as a successful send.
    await expect(
      resolveConversationByPhone(noDb, 'acct', '4155551212')
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    // Digits with a country code but no `+` are indistinguishable from
    // the above, so they are refused as well.
    await expect(
      resolveConversationByPhone(noDb, 'acct', '14155550123')
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('fails with whatsapp_not_configured (and creates nothing) when the account has no config', async () => {
    h.script = { config: null, owner: 'owner-1' };
    await expect(
      resolveConversationByPhone(run, 'acct', '+14155550123')
    ).rejects.toMatchObject({ code: 'whatsapp_not_configured', status: 400 });
    expect(h.inserts).toHaveLength(0);
    expect(h.convArgs).toHaveLength(0);
  });

  it('maps an unresolvable audit owner to a db_error SendMessageError', async () => {
    h.script = { config: { id: 'cfg' }, owner: null };
    await expect(
      resolveConversationByPhone(run, 'acct', '+14155550123')
    ).rejects.toMatchObject({ code: 'db_error', status: 500 });
  });

  it('returns the existing contact + conversation without creating', async () => {
    h.script = {
      config: { id: 'cfg' },
      owner: 'owner-1',
      existingByCall: [{ id: 'c1', phone: '14155550123', name: 'Old' }],
      conversationId: 'cv1',
    };
    const res = await resolveConversationByPhone(run, 'acct', '+1 (415) 555-0123');
    expect(res).toEqual({ conversationId: 'cv1', contactId: 'c1', contactCreated: false });
    expect(h.inserts).toHaveLength(0);
    // No name given → the existing contact is left alone.
    expect(h.updates).toHaveLength(0);
    expect(h.convArgs[0]).toEqual(['acct', 'c1', 'owner-1']);
  });

  it('renames an existing contact when a different name is passed', async () => {
    h.script = {
      config: { id: 'cfg' },
      owner: 'owner-1',
      existingByCall: [{ id: 'c1', phone: '14155550123', name: 'Old' }],
      conversationId: 'cv1',
    };
    await resolveConversationByPhone(run, 'acct', '+14155550123', 'New');
    expect(h.updates).toEqual([{ id: 'c1', name: 'New' }]);
  });

  it('creates contact + conversation when none exist, attributed to the audit owner', async () => {
    h.script = {
      config: { id: 'cfg' },
      owner: 'owner-1',
      existingByCall: [null],
      insertedContactId: 'c2',
      conversationId: 'cv2',
    };
    const res = await resolveConversationByPhone(run, 'acct', '+14155550199', 'Jane');
    expect(res).toEqual({ conversationId: 'cv2', contactId: 'c2', contactCreated: true });
    expect(h.inserts[0]).toMatchObject({
      account_id: 'acct',
      user_id: 'owner-1',
      phone: '14155550199',
      name: 'Jane',
    });
    expect(h.convArgs[0]).toEqual(['acct', 'c2', 'owner-1']);
  });

  it('re-resolves an existing contact when the insert loses a unique race', async () => {
    // First lookup misses (→ we attempt an insert), the insert is a
    // no-op (ON CONFLICT DO NOTHING — a concurrent writer won), and the
    // post-race re-lookup returns the row the other writer created.
    h.script = {
      config: { id: 'cfg' },
      owner: 'owner-1',
      existingByCall: [null, { id: 'c-raced', phone: '14155550123' }],
      insertedContactId: null,
      conversationId: 'cv-raced',
    };
    const res = await resolveConversationByPhone(run, 'acct', '+14155550123');
    expect(res).toEqual({ conversationId: 'cv-raced', contactId: 'c-raced', contactCreated: false });
  });

  it('fails with db_error when the contact insert errors', async () => {
    h.script = { config: { id: 'cfg' }, owner: 'owner-1', existingByCall: [null], insertContactThrows: true };
    await expect(
      resolveConversationByPhone(run, 'acct', '+14155550123')
    ).rejects.toMatchObject({ code: 'db_error', message: 'Failed to create contact' });
  });

  it('fails with db_error when no conversation can be resolved', async () => {
    h.script = {
      config: { id: 'cfg' },
      owner: 'owner-1',
      existingByCall: [{ id: 'c1', phone: '14155550123' }],
      conversationId: null,
    };
    await expect(
      resolveConversationByPhone(run, 'acct', '+14155550123')
    ).rejects.toMatchObject({ code: 'db_error', message: 'Failed to create conversation' });
  });
});
