import { beforeEach, describe, it, expect, vi } from 'vitest';

import type { Db, Runner } from '@/server/db';
import {
  createBroadcast,
  deliverBroadcast,
  finalizeBroadcastStatus,
  terminalBroadcastStatus,
  BroadcastError,
  type BroadcastPlan,
} from './broadcast-core';

// Contact resolution and token decryption are exercised elsewhere — stub
// them so these tests focus on the persistence boundary.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
}));

const meta = vi.hoisted(() => ({ sendTemplateMessage: vi.fn() }));
vi.mock('@/lib/whatsapp/meta-api', () => meta);

const repo = vi.hoisted(() => ({
  createBroadcastWithRecipients: vi.fn(),
  recipientStatusCounts: vi.fn(),
  setBroadcastTerminalStatus: vi.fn(),
  stampRecipient: vi.fn(),
}));
vi.mock('@/server/repos/broadcasts', () => repo);

const templatesRepo = vi.hoisted(() => ({
  getWhatsappConfig: vi.fn(),
  listTemplatesByName: vi.fn(),
}));
vi.mock('@/server/repos/templates', () => templatesRepo);

const fakeDb = { name: 'service-tx' } as unknown as Db;
const runner = vi.fn((fn: (db: Db) => Promise<unknown>) => fn(fakeDb));
const run = runner as unknown as Runner;

beforeEach(() => {
  runner.mockClear();
  meta.sendTemplateMessage.mockReset();
  for (const fn of [...Object.values(repo), ...Object.values(templatesRepo)]) fn.mockReset();
  templatesRepo.getWhatsappConfig.mockResolvedValue({
    phone_number_id: 'pn-1',
    access_token: 'enc',
    waba_id: null,
  });
  templatesRepo.listTemplatesByName.mockResolvedValue([]);
});

describe('createBroadcast validation', () => {
  // These assertions all fire in the pure validation prologue, before
  // any database call.
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(run, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(run, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(run, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('fails fast when WhatsApp is not configured', async () => {
    templatesRepo.getWhatsappConfig.mockResolvedValue(undefined);
    await expect(
      createBroadcast(run, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'whatsapp_not_configured', status: 400 });
    expect(repo.createBroadcastWithRecipients).not.toHaveBeenCalled();
  });
});

describe('createBroadcast recipient validation (#586)', () => {
  it('counts a recipient without a leading + as rejected instead of sending it abroad', async () => {
    repo.createBroadcastWithRecipients.mockResolvedValue([
      { broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' },
    ]);

    const plan = await createBroadcast(run, 'acc', 'user', {
      templateName: 'promo',
      recipients: [
        { to: '4155551212' }, // US national → Meta would read +41 (Switzerland)
        { to: '14155550123' }, // country code but no + — indistinguishable
        { to: '+14155550123' },
      ],
    });

    expect(plan.rejected).toBe(2);
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '14155550123', params: [] },
    ]);
  });

  it('fails the whole request when no recipient carries a country code', async () => {
    await expect(
      createBroadcast(run, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '4155551212' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(repo.createBroadcastWithRecipients).not.toHaveBeenCalled();
  });
});

describe('createBroadcast atomicity (#370)', () => {
  it('creates parent + recipients through the atomic RPC, never a bare parent insert', async () => {
    repo.createBroadcastWithRecipients.mockResolvedValue([
      { broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' },
    ]);

    const plan = await createBroadcast(run, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123', params: ['Jane'] }],
    });

    // The repo exposes no separate parent insert to this module — the
    // RPC (one SQL function, one transaction) is the only write.
    expect(repo.createBroadcastWithRecipients).toHaveBeenCalledTimes(1);
    expect(repo.createBroadcastWithRecipients).toHaveBeenCalledWith(fakeDb, {
      accountId: 'acc',
      userId: 'user',
      name: 'API broadcast (promo)',
      templateName: 'promo',
      templateLanguage: 'en_US',
      contactIds: ['c1'],
      // Frozen per-recipient params (migration 038) for resume.
      templateParams: [['Jane']],
    });
    expect(plan.broadcastId).toBe('b-1');
    expect(plan.accountId).toBe('acc');
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '14155550123', params: ['Jane'] },
    ]);
  });

  it('throws and leaves no orphaned parent when the atomic create fails', async () => {
    repo.createBroadcastWithRecipients.mockRejectedValue(new Error('recipient insert failed'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      createBroadcast(run, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'internal', status: 500 });
    spy.mockRestore();

    // The RPC was the only persistence attempt; because it runs both
    // inserts in a single transaction, its failure rolls the parent back —
    // there is no separate parent insert that could survive as an orphan.
    expect(repo.createBroadcastWithRecipients).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Delivery — Meta calls happen between short per-recipient writes.
// ============================================================

function plan(overrides: Partial<BroadcastPlan> = {}): BroadcastPlan {
  return {
    accountId: 'acc',
    broadcastId: 'b-1',
    templateName: 'promo',
    templateLanguage: 'en_US',
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
    templateRow: null,
    planned: [
      { recipientRowId: 'r-1', phone: '14155550123', params: ['A'] },
      { recipientRowId: 'r-2', phone: '14155550124', params: [] },
    ],
    rejected: 0,
    ...overrides,
  };
}

describe('deliverBroadcast', () => {
  it('stamps each recipient in its own runner call, then finalizes', async () => {
    meta.sendTemplateMessage
      .mockResolvedValueOnce({ messageId: 'wamid-1' })
      .mockRejectedValueOnce(new Error('(#131026) Message undeliverable'));
    repo.stampRecipient.mockResolvedValue(true);
    repo.recipientStatusCounts.mockResolvedValue({ pending: 0, failed: 1, total: 2 });

    await deliverBroadcast(run, plan());

    expect(repo.stampRecipient).toHaveBeenNthCalledWith(1, fakeDb, 'acc', 'b-1', {
      id: 'r-1',
      status: 'sent',
      whatsapp_message_id: 'wamid-1',
    });
    expect(repo.stampRecipient).toHaveBeenNthCalledWith(2, fakeDb, 'acc', 'b-1', {
      id: 'r-2',
      status: 'failed',
      error_message: '(#131026) Message undeliverable',
    });
    // Two stamps + the finalize — never one long transaction around Meta.
    expect(runner).toHaveBeenCalledTimes(3);
    expect(repo.setBroadcastTerminalStatus).toHaveBeenCalledWith(fakeDb, 'acc', 'b-1', 'sent');
  });

  it('keeps going when one stamp fails', async () => {
    meta.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid' });
    repo.stampRecipient.mockRejectedValueOnce(new Error('db blip')).mockResolvedValue(true);
    repo.recipientStatusCounts.mockResolvedValue({ pending: 0, failed: 0, total: 2 });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await deliverBroadcast(run, plan());
    spy.mockRestore();

    expect(repo.stampRecipient).toHaveBeenCalledTimes(2);
    expect(repo.setBroadcastTerminalStatus).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Terminal status (#472). Derived from the recipient rows, not from a
// counter local to one delivery pass — a resume only sends the
// leftovers, so "nothing sent this pass" must not condemn a campaign
// that already delivered hundreds.
// ============================================================

describe('terminalBroadcastStatus', () => {
  it('leaves a capped pass in "sending" while recipients are still pending', () => {
    expect(terminalBroadcastStatus({ pending: 25, failed: 0, total: 1025 })).toBeNull();
  });

  it('marks a fully-failed broadcast failed', () => {
    expect(terminalBroadcastStatus({ pending: 0, failed: 10, total: 10 })).toBe('failed');
  });

  it('marks a partially-failed broadcast sent', () => {
    // 7 people got the message; failed_count carries the other 3.
    expect(terminalBroadcastStatus({ pending: 0, failed: 3, total: 10 })).toBe('sent');
  });

  it('does not condemn a campaign whose resume pass sent nothing new', () => {
    // 800 delivered on the original pass, the 200-recipient resume all
    // failed. Pre-fix this wrote 'failed' off a pass-local counter.
    expect(terminalBroadcastStatus({ pending: 0, failed: 200, total: 1000 })).toBe('sent');
  });
});

describe('finalizeBroadcastStatus', () => {
  it('writes nothing while recipients are still pending — the UI keeps offering Resume', async () => {
    repo.recipientStatusCounts.mockResolvedValue({ pending: 25, failed: 0, total: 1025 });
    await finalizeBroadcastStatus(run, 'acc', 'b-1');
    expect(repo.setBroadcastTerminalStatus).not.toHaveBeenCalled();
  });

  it('writes the derived terminal status, scoped to the account', async () => {
    repo.recipientStatusCounts.mockResolvedValue({ pending: 0, failed: 10, total: 10 });
    await finalizeBroadcastStatus(run, 'acc', 'b-1');
    expect(repo.recipientStatusCounts).toHaveBeenCalledWith(fakeDb, 'acc', 'b-1');
    expect(repo.setBroadcastTerminalStatus).toHaveBeenCalledWith(fakeDb, 'acc', 'b-1', 'failed');
  });
});
