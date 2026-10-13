import { beforeEach, describe, expect, it, vi } from 'vitest';

// The repository is mocked; asService just runs the callback.
const repo = vi.hoisted(() => ({
  updateTemplatesByMetaId: vi.fn(),
  listConfigOwnersByWabaId: vi.fn(),
  insertTemplateStub: vi.fn(),
}));
vi.mock('@/server/repos/inbound-templates', () => repo);
vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule());

import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from './template-webhook';

// Records each repository call in order, in a shape close to the SQL it
// stands for:
//   update  → updateTemplatesByMetaId(meta_template_id, patch) → ids
//             (selectResult, then retrySelectResult for the 2nd call)
//   config  → listConfigOwnersByWabaId(waba_id)                → configRows
//   insert  → insertTemplateStub(stub)                         → inserted?
type SelectResult = { ids: string[] } | { error: string };

type Call =
  | { op: 'update'; metaTemplateId: string; update: Record<string, unknown> }
  | { op: 'config'; wabaId: string }
  | { op: 'insert'; insert: Record<string, unknown> };

function makeRepo(
  selectResult: SelectResult = { ids: ['row-1'] },
  opts: {
    configRows?: { account_id: string; user_id: string }[];
    /** false = the insert hit a unique index (ON CONFLICT DO NOTHING). */
    inserted?: boolean;
    retrySelectResult?: SelectResult;
  } = {},
) {
  const calls: Call[] = [];
  let updateCount = 0;
  const resolve = (r: SelectResult) =>
    'error' in r ? Promise.reject(new Error(r.error)) : Promise.resolve(r.ids);

  repo.updateTemplatesByMetaId.mockImplementation(
    (_db: unknown, metaTemplateId: string, update: Record<string, unknown>) => {
      calls.push({ op: 'update', metaTemplateId, update });
      updateCount++;
      return resolve(
        updateCount > 1 && opts.retrySelectResult
          ? opts.retrySelectResult
          : selectResult,
      );
    },
  );
  repo.listConfigOwnersByWabaId.mockImplementation(
    (_db: unknown, wabaId: string) => {
      calls.push({ op: 'config', wabaId });
      return Promise.resolve(opts.configRows ?? []);
    },
  );
  repo.insertTemplateStub.mockImplementation(
    (_db: unknown, insert: Record<string, unknown>) => {
      calls.push({ op: 'insert', insert });
      return Promise.resolve(opts.inserted ?? true);
    },
  );
  return calls;
}

const updates = (calls: Call[]) =>
  calls.filter((c): c is Extract<Call, { op: 'update' }> => c.op === 'update');
const inserts = (calls: Call[]) =>
  calls.filter((c): c is Extract<Call, { op: 'insert' }> => c.op === 'insert');

describe('isTemplateWebhookField', () => {
  it('recognises the three template fields', () => {
    expect(isTemplateWebhookField('message_template_status_update')).toBe(true);
    expect(isTemplateWebhookField('message_template_quality_update')).toBe(true);
    expect(isTemplateWebhookField('message_template_components_update')).toBe(
      true,
    );
  });
  it('rejects messaging fields', () => {
    expect(isTemplateWebhookField('messages')).toBe(false);
    expect(isTemplateWebhookField('message_status')).toBe(false);
  });
});

describe('handleTemplateWebhookChange — status update', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('flips status to APPROVED and clears any rejection_reason', async () => {
    const calls = makeRepo();
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'APPROVED',
        message_template_id: 12345,
        message_template_name: 'order_confirmation',
        message_template_language: 'en_US',
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      op: 'update',
      metaTemplateId: '12345', // coerced to string so it matches the TEXT column
      update: {
        status: 'APPROVED',
        rejection_reason: null,
        submission_error: null,
      },
    });
  });

  it('persists the reason field on REJECTED', async () => {
    const calls = makeRepo();
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'REJECTED',
        message_template_id: 'TMPL_99',
        reason: 'Template uses non-compliant language.',
      },
    });
    expect(updates(calls)[0].update.status).toBe('REJECTED');
    expect(updates(calls)[0].update.rejection_reason).toBe(
      'Template uses non-compliant language.',
    );
  });

  it('falls back to a generic reason when REJECTED has no `reason`', async () => {
    const calls = makeRepo();
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: { event: 'REJECTED', message_template_id: '7' },
    });
    expect(updates(calls)[0].update.rejection_reason).toBe('Rejected by Meta');
  });

  it('normalises PENDING_REVIEW → PENDING (via shared normalizeStatus)', async () => {
    const calls = makeRepo();
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: { event: 'PENDING_REVIEW', message_template_id: '1' },
    });
    expect(updates(calls)[0].update.status).toBe('PENDING');
  });

  it('logs and exits when meta_template_id is missing (no UPDATE issued)', async () => {
    const calls = makeRepo();
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: { event: 'APPROVED' },
    });
    expect(calls).toHaveLength(0);
  });

  it('logs and never throws when the UPDATE itself fails', async () => {
    const error = vi.spyOn(console, 'error');
    const calls = makeRepo({ error: 'connection reset' });
    await expect(
      handleTemplateWebhookChange({
        field: 'message_template_status_update',
        value: { event: 'APPROVED', message_template_id: '1' },
        wabaId: 'WABA-1',
      }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    // No stub attempt after a failed update.
    expect(calls).toHaveLength(1);
  });

  it('logs a warning when the row is unknown locally and no WABA id was passed', async () => {
    const warn = vi.spyOn(console, 'warn');
    const calls = makeRepo({ ids: [] });
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'APPROVED',
        message_template_id: 'NEVER_SEEN',
        message_template_name: 'mystery',
      },
    });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('no WABA id');
    // Without a WABA id there is nothing to resolve the account with —
    // no config lookup, no insert.
    expect(calls).toHaveLength(1);
    expect(inserts(calls)).toHaveLength(0);
  });
});

describe('handleTemplateWebhookChange — unknown template stub (#534)', () => {
  const CONFIG = { account_id: 'acc-1', user_id: 'admin-1' };

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('inserts a stub row for a 0-row status update when exactly one config matches the WABA', async () => {
    const calls = makeRepo({ ids: [] }, { configRows: [CONFIG] });
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'APPROVED',
        message_template_id: 555,
        message_template_name: 'created_in_meta',
        message_template_language: 'de',
      },
      wabaId: 'WABA-1',
    });

    expect(calls.map((c) => c.op)).toEqual([
      'update', // the original UPDATE (0 rows)
      'config', // resolve the tenant
      'insert', // the stub INSERT
    ]);
    expect(calls[1]).toEqual({ op: 'config', wabaId: 'WABA-1' });
    expect(inserts(calls)[0].insert).toEqual({
      account_id: 'acc-1',
      user_id: 'admin-1',
      meta_template_id: '555',
      name: 'created_in_meta',
      language: 'de',
      body_text: '',
      status: 'APPROVED',
      rejection_reason: null,
      submission_error: null,
    });
  });

  it('carries the rejection reason into the stub on REJECTED and defaults language to en_US', async () => {
    const calls = makeRepo({ ids: [] }, { configRows: [CONFIG] });
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'REJECTED',
        message_template_id: '556',
        message_template_name: 'spammy',
        reason: 'INVALID_FORMAT',
      },
      wabaId: 'WABA-1',
    });
    expect(inserts(calls)[0].insert).toMatchObject({
      status: 'REJECTED',
      rejection_reason: 'INVALID_FORMAT',
      language: 'en_US',
    });
  });

  it('warns with the WABA id and inserts nothing when no config matches', async () => {
    const warn = vi.spyOn(console, 'warn');
    const calls = makeRepo({ ids: [] }, { configRows: [] });
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'APPROVED',
        message_template_id: '557',
        message_template_name: 'orphan',
      },
      wabaId: 'WABA-NOBODY',
    });
    expect(calls).toHaveLength(2); // update + config lookup, no insert
    expect(inserts(calls)).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('WABA WABA-NOBODY');
    expect(message).toContain('557');
    expect(message).toContain('no whatsapp_config rows');
  });

  it('refuses to guess the tenant when several configs share the WABA id', async () => {
    const warn = vi.spyOn(console, 'warn');
    const calls = makeRepo(
      { ids: [] },
      { configRows: [CONFIG, { account_id: 'acc-2', user_id: 'admin-2' }] },
    );
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'APPROVED',
        message_template_id: '558',
        message_template_name: 'shared',
      },
      wabaId: 'WABA-1',
    });
    expect(inserts(calls)).toHaveLength(0);
    expect(String(warn.mock.calls[0][0])).toContain('2 whatsapp_config rows');
  });

  it('inserts a stub with quality_score (and no status) for a 0-row quality update', async () => {
    const warn = vi.spyOn(console, 'warn');
    const calls = makeRepo({ ids: [] }, { configRows: [CONFIG] });
    await handleTemplateWebhookChange({
      field: 'message_template_quality_update',
      value: {
        message_template_id: '559',
        message_template_name: 'created_in_meta',
        message_template_language: 'en_US',
        previous_quality_score: 'UNKNOWN',
        new_quality_score: 'RED',
      },
      wabaId: 'WABA-1',
    });
    expect(updates(calls)[0].update).toEqual({ quality_score: 'RED' });
    expect(inserts(calls)[0].insert).toEqual({
      account_id: 'acc-1',
      user_id: 'admin-1',
      meta_template_id: '559',
      name: 'created_in_meta',
      language: 'en_US',
      body_text: '',
      quality_score: 'RED',
    });
    // `status` is deliberately absent — the column default applies.
    expect(inserts(calls)[0].insert).not.toHaveProperty('status');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns (with the WABA id) on a 0-row quality update when the tenant cannot be resolved', async () => {
    const warn = vi.spyOn(console, 'warn');
    const calls = makeRepo({ ids: [] }, { configRows: [] });
    await handleTemplateWebhookChange({
      field: 'message_template_quality_update',
      value: {
        message_template_id: '560',
        message_template_name: 'orphan',
        new_quality_score: 'GREEN',
      },
      wabaId: 'WABA-NOBODY',
    });
    expect(inserts(calls)).toHaveLength(0);
    expect(String(warn.mock.calls[0][0])).toContain('quality update');
    expect(String(warn.mock.calls[0][0])).toContain('WABA WABA-NOBODY');
  });

  it('retries the update once when the stub insert hits a unique index', async () => {
    const warn = vi.spyOn(console, 'warn');
    const calls = makeRepo(
      { ids: [] },
      {
        configRows: [CONFIG],
        inserted: false, // ON CONFLICT DO NOTHING
        retrySelectResult: { ids: ['row-raced'] },
      },
    );
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'PAUSED',
        message_template_id: '561',
        message_template_name: 'raced',
      },
      wabaId: 'WABA-1',
    });
    const u = updates(calls);
    expect(u).toHaveLength(2);
    expect(u[1].update).toEqual(u[0].update);
    expect(u[1].metaTemplateId).toBe('561');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when the retry still matches nothing (unlinked local row)', async () => {
    const warn = vi.spyOn(console, 'warn');
    makeRepo(
      { ids: [] },
      { configRows: [CONFIG], inserted: false, retrySelectResult: { ids: [] } },
    );
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'APPROVED',
        message_template_id: '563',
        message_template_name: 'unlinked',
      },
      wabaId: 'WABA-1',
    });
    expect(String(warn.mock.calls[0][0])).toContain('not linked');
  });

  it('does not create a stub when the event has no template name', async () => {
    const warn = vi.spyOn(console, 'warn');
    const calls = makeRepo({ ids: [] }, { configRows: [CONFIG] });
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: { event: 'APPROVED', message_template_id: '562' },
      wabaId: 'WABA-1',
    });
    expect(calls).toHaveLength(1);
    expect(String(warn.mock.calls[0][0])).toContain('no message_template_name');
  });
});

describe('handleTemplateWebhookChange — quality update', () => {
  it('sets quality_score from new_quality_score', async () => {
    const calls = makeRepo();
    await handleTemplateWebhookChange({
      field: 'message_template_quality_update',
      value: {
        message_template_id: '99',
        previous_quality_score: 'GREEN',
        new_quality_score: 'YELLOW',
      },
    });
    expect(calls[0]).toEqual({
      op: 'update',
      metaTemplateId: '99',
      update: { quality_score: 'YELLOW' },
    });
  });

  it('stores null for unrecognised quality scores', async () => {
    const calls = makeRepo();
    await handleTemplateWebhookChange({
      field: 'message_template_quality_update',
      value: {
        message_template_id: '99',
        new_quality_score: 'PURPLE', // not a real Meta value
      },
    });
    expect(updates(calls)[0].update).toEqual({ quality_score: null });
  });
});

describe('handleTemplateWebhookChange — components update', () => {
  it('is an info-log no-op (does not write to DB)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const calls = makeRepo();
    await handleTemplateWebhookChange({
      field: 'message_template_components_update',
      value: {
        message_template_id: '5',
        message_template_name: 'x',
      },
    });
    expect(calls).toHaveLength(0);
    expect(info).toHaveBeenCalled();
  });
});

describe('handleTemplateWebhookChange — unknown field', () => {
  it('is a defensive no-op', async () => {
    const calls = makeRepo();
    await handleTemplateWebhookChange(
      // Pretend Meta added a new template_* field we don't know about.
      // The route handler pre-filters via isTemplateWebhookField, but
      // the dispatch should still be safe if the filter is bypassed.
      { field: 'message_template_future_field', value: {} },
    );
    expect(calls).toHaveLength(0);
  });
});
