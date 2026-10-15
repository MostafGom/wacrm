import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db, Runner } from '@/server/db';
import { BroadcastError } from './broadcast-core';
import {
  claimBroadcastDelivery,
  DELIVERY_LOCK_STALE_MS,
  planBroadcastResume,
  releaseBroadcastDelivery,
  RESUME_MAX_PER_REQUEST,
} from './broadcast-resume';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));

const repo = vi.hoisted(() => ({
  claimDeliveryLock: vi.fn(),
  releaseDeliveryLock: vi.fn(),
  getBroadcast: vi.fn(),
  loadRecipientsForResume: vi.fn(),
  failRecipients: vi.fn(),
  setBroadcastTerminalStatus: vi.fn(),
  // broadcast-core imports these; unused by the resume planner.
  createBroadcastWithRecipients: vi.fn(),
  recipientStatusCounts: vi.fn(),
  stampRecipient: vi.fn(),
}));
vi.mock('@/server/repos/broadcasts', () => repo);

const templatesRepo = vi.hoisted(() => ({
  getWhatsappConfig: vi.fn(),
  listTemplatesByName: vi.fn(),
}));
vi.mock('@/server/repos/templates', () => templatesRepo);

vi.mock('@/lib/api/v1/contacts', () => ({ findOrCreateContact: vi.fn() }));

const fakeDb = { name: 'tx' } as unknown as Db;
/** A Runner that hands every callback the same fake transaction. */
const run: Runner = (fn) => fn(fakeDb);

beforeEach(() => {
  for (const fn of [...Object.values(repo), ...Object.values(templatesRepo)]) fn.mockReset();
});

// ============================================================
// Claim / release — the mutex that stops a double-send.
// ============================================================

describe('claimBroadcastDelivery', () => {
  it('claims when the conditional UPDATE matched a row', async () => {
    repo.claimDeliveryLock.mockResolvedValue(true);
    const now = new Date('2026-08-11T12:00:00Z');
    const ok = await claimBroadcastDelivery(fakeDb, 'acct-1', 'bc-1', now);

    expect(ok).toBe(true);
    expect(repo.claimDeliveryLock).toHaveBeenCalledWith(
      fakeDb,
      'acct-1',
      'bc-1',
      now,
      expect.any(Date),
    );
  });

  it('refuses when another pass already holds the lock', async () => {
    // The UPDATE's WHERE didn't match — someone else got there first.
    repo.claimDeliveryLock.mockResolvedValue(false);
    expect(await claimBroadcastDelivery(fakeDb, 'acct-1', 'bc-1')).toBe(false);
  });

  it('treats a lock older than the staleness window as abandoned', async () => {
    repo.claimDeliveryLock.mockResolvedValue(true);
    await claimBroadcastDelivery(fakeDb, 'acct-1', 'bc-1', new Date('2026-08-11T12:00:00Z'));
    // 30 minutes before "now" — a pass whose process died is recoverable
    // without touching the database by hand.
    const cutoff = repo.claimDeliveryLock.mock.calls[0][4] as Date;
    expect(cutoff.toISOString()).toBe('2026-08-11T11:30:00.000Z');
    expect(DELIVERY_LOCK_STALE_MS).toBe(30 * 60 * 1000);
  });

  it('is scoped to the account, so another tenant cannot claim it', async () => {
    repo.claimDeliveryLock.mockResolvedValue(false);
    await claimBroadcastDelivery(fakeDb, 'acct-9', 'bc-1');
    expect(repo.claimDeliveryLock.mock.calls[0][1]).toBe('acct-9');
  });
});

describe('releaseBroadcastDelivery', () => {
  it('clears the lock', async () => {
    repo.releaseDeliveryLock.mockResolvedValue(undefined);
    await releaseBroadcastDelivery(fakeDb, 'acct-1', 'bc-1');
    expect(repo.releaseDeliveryLock).toHaveBeenCalledWith(fakeDb, 'acct-1', 'bc-1');
  });

  it('is best-effort — a failed release does not throw', async () => {
    repo.releaseDeliveryLock.mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(releaseBroadcastDelivery(fakeDb, 'acct-1', 'bc-1')).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

// ============================================================
// Planning — which recipients a pass picks up, and with what params.
// ============================================================

interface PlanFixture {
  broadcast?: Record<string, unknown> | null;
  recipients?: { id: string; template_params: unknown; phone: string | null }[];
  inScope?: number;
  config?: Record<string, unknown> | null;
  templates?: Record<string, unknown>[];
}

function setup(fx: PlanFixture) {
  repo.getBroadcast.mockResolvedValue(fx.broadcast ?? undefined);
  repo.loadRecipientsForResume.mockImplementation(
    async (_db: unknown, _acct: string, _id: string, _statuses: string[], limit: number) => {
      const all = fx.recipients ?? [];
      return { rows: all.slice(0, limit), inScope: fx.inScope ?? all.length };
    },
  );
  repo.failRecipients.mockResolvedValue(undefined);
  templatesRepo.getWhatsappConfig.mockResolvedValue(fx.config ?? undefined);
  templatesRepo.listTemplatesByName.mockResolvedValue(fx.templates ?? []);
}

const BROADCAST = {
  id: 'bc-1',
  template_name: 'order_update',
  template_language: 'en_US',
};

const CONFIG = { phone_number_id: 'pn-1', access_token: 'tok', waba_id: null };

function recipient(id: string, phone: string | null, params: unknown = ['A123']) {
  return { id, template_params: params, phone };
}

function statusFilter(): unknown {
  return repo.loadRecipientsForResume.mock.calls[0][3];
}

describe('planBroadcastResume', () => {
  it('plans the outstanding recipients with their frozen params', async () => {
    setup({
      broadcast: BROADCAST,
      config: CONFIG,
      recipients: [
        recipient('r1', '+15551234567', ['A123', 'Friday']),
        recipient('r2', '+15559876543', ['B456', 'Monday']),
      ],
    });
    const { plan, remaining, unsendable } = await planBroadcastResume(run, 'acct-1', 'bc-1', 'pending');

    expect(statusFilter()).toEqual(['pending']);
    // Phones are stored sanitized (no leading '+'), same as the shape
    // createBroadcast plans — deliverBroadcast feeds them to
    // phoneVariants from here.
    expect(plan.planned).toEqual([
      { recipientRowId: 'r1', phone: '15551234567', params: ['A123', 'Friday'] },
      { recipientRowId: 'r2', phone: '15559876543', params: ['B456', 'Monday'] },
    ]);
    expect(plan.accountId).toBe('acct-1');
    expect(plan.accessToken).toBe('decrypted:tok');
    expect(remaining).toBe(0);
    expect(unsendable).toBe(0);
    expect(repo.failRecipients).not.toHaveBeenCalled();
  });

  it('carries the header media saved on the broadcast, so a resend keeps its image', async () => {
    setup({
      broadcast: { ...BROADCAST, header_media_url: 'https://cdn.example.com/promo.png' },
      config: CONFIG,
      recipients: [recipient('r1', '+15551234567')],
    });
    const { plan } = await planBroadcastResume(run, 'acct-1', 'bc-1', 'failed');
    expect(plan.headerMediaUrl).toBe('https://cdn.example.com/promo.png');
  });

  it('scopes to failed rows when retrying, and to both for "all"', async () => {
    setup({ broadcast: BROADCAST, config: CONFIG, recipients: [recipient('r1', '+15551234567')] });
    await planBroadcastResume(run, 'acct-1', 'bc-1', 'failed');
    expect(statusFilter()).toEqual(['failed']);

    repo.loadRecipientsForResume.mockClear();
    await planBroadcastResume(run, 'acct-1', 'bc-1', 'all');
    expect(statusFilter()).toEqual(['pending', 'failed']);
  });

  it('treats a missing or malformed params column as no params', async () => {
    setup({
      broadcast: BROADCAST,
      config: CONFIG,
      recipients: [
        // Rows created before migration 038 carry NULL.
        recipient('r1', '+15551234567', null),
        recipient('r2', '+15559876543', 'not-an-array'),
      ],
    });
    const { plan } = await planBroadcastResume(run, 'acct-1', 'bc-1', 'pending');
    expect(plan.planned.map((p) => p.params)).toEqual([[], []]);
  });

  it('fails unsendable rows up front so they stop blocking the status', async () => {
    setup({
      broadcast: BROADCAST,
      config: CONFIG,
      recipients: [recipient('r1', '+15551234567'), recipient('r2', null), recipient('r3', 'nonsense')],
    });
    const { plan, unsendable } = await planBroadcastResume(run, 'acct-1', 'bc-1', 'pending');

    // Left 'pending', these would keep the broadcast in 'sending'
    // forever — the exact symptom being fixed.
    expect(unsendable).toBe(2);
    expect(repo.failRecipients).toHaveBeenCalledWith(
      fakeDb,
      'acct-1',
      'bc-1',
      ['r2', 'r3'],
      'No valid phone number on contact',
    );
    expect(plan.planned).toHaveLength(1);
  });

  it('keeps the unsendable stamps even when nothing is left to send', async () => {
    setup({ broadcast: BROADCAST, config: CONFIG, recipients: [recipient('r1', null)] });
    await expect(planBroadcastResume(run, 'acct-1', 'bc-1', 'pending')).rejects.toMatchObject({
      code: 'nothing_to_resume',
    });
    // Written through its own runner call, so the throw that follows
    // doesn't roll it back.
    expect(repo.failRecipients).toHaveBeenCalledTimes(1);
  });

  it('caps one pass and reports the leftover', async () => {
    const many = Array.from({ length: RESUME_MAX_PER_REQUEST + 25 }, (_, i) =>
      recipient(`r${i}`, '+1555000' + String(i).padStart(4, '0')),
    );
    setup({ broadcast: BROADCAST, config: CONFIG, recipients: many });
    const { plan, remaining } = await planBroadcastResume(run, 'acct-1', 'bc-1', 'pending');
    expect(plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST);
    // Surfaced to the caller rather than silently dropped.
    expect(remaining).toBe(25);
  });

  it('counts the backlog the capped load did not return', async () => {
    const firstPage = Array.from({ length: RESUME_MAX_PER_REQUEST }, (_, i) =>
      recipient(`r${i}`, '+1555000' + String(i).padStart(4, '0')),
    );
    setup({ broadcast: BROADCAST, config: CONFIG, recipients: firstPage, inScope: 2812 });
    const { plan, remaining } = await planBroadcastResume(run, 'acct-1', 'bc-1', 'pending');
    expect(plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST);
    expect(remaining).toBe(2812 - RESUME_MAX_PER_REQUEST);
  });

  it('404s a broadcast that is not on this account', async () => {
    setup({ broadcast: null });
    await expect(planBroadcastResume(run, 'acct-1', 'bc-1', 'pending')).rejects.toMatchObject({
      status: 404,
    });
    expect(repo.loadRecipientsForResume).not.toHaveBeenCalled();
  });

  it('refuses when there is nothing outstanding', async () => {
    setup({ broadcast: BROADCAST, config: CONFIG, recipients: [] });
    await expect(planBroadcastResume(run, 'acct-1', 'bc-1', 'failed')).rejects.toBeInstanceOf(
      BroadcastError,
    );
  });

  it('400s when WhatsApp is not configured', async () => {
    setup({ broadcast: BROADCAST, config: null, recipients: [recipient('r1', '+15551234567')] });
    await expect(planBroadcastResume(run, 'acct-1', 'bc-1', 'pending')).rejects.toMatchObject({
      code: 'whatsapp_not_configured',
      status: 400,
    });
  });

  it('resolves the template row for header + button components', async () => {
    setup({
      broadcast: { ...BROADCAST, template_language: 'en_US' },
      config: CONFIG,
      recipients: [recipient('r1', '+15551234567')],
      templates: [
        {
          id: 'tpl-1',
          user_id: 'u-1',
          name: 'order_update',
          // Synced from Meta as bare 'en' — the resolver bridges it.
          language: 'en',
          body_text: 'Your order {{1}} ships on {{2}}',
        },
      ],
    });
    const { plan } = await planBroadcastResume(run, 'acct-1', 'bc-1', 'pending');
    expect(templatesRepo.listTemplatesByName).toHaveBeenCalledWith(fakeDb, 'acct-1', 'order_update');
    expect(plan.templateRow?.language).toBe('en');
  });
});
