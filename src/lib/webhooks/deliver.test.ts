import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (s: string) => s,
  encrypt: (s: string) => s,
}));

// Control the SSRF guard per-test.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

// Repository calls run through asService; the repo module is mocked.
vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule());
vi.mock('@/server/repos/inbound-webhook-endpoints', () => ({
  listActiveEndpointsForEvent: vi.fn(),
  markEndpointDelivered: vi.fn(async () => undefined),
  recordWebhookFailure: vi.fn(async () => undefined),
}));

import { dispatchWebhookEvent, MAX_CONSECUTIVE_FAILURES } from './deliver';
import { isDeliverableUrl } from './ssrf';
import {
  listActiveEndpointsForEvent,
  markEndpointDelivered,
  recordWebhookFailure,
} from '@/server/repos/inbound-webhook-endpoints';

interface Row {
  id: string;
  url: string;
  secret: string;
}

function endpoints(rows: Row[]) {
  vi.mocked(listActiveEndpointsForEvent).mockResolvedValue(rows);
}

beforeEach(() => {
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('dispatchWebhookEvent', () => {
  it('signs + POSTs (no redirect follow) and resets failure_count on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    endpoints([{ id: 'a', url: 'https://a.test/hook', secret: 's1' }]);

    await dispatchWebhookEvent('acct-1', 'message.received', { x: 1 });

    // Endpoints are looked up for this account + event only.
    expect(listActiveEndpointsForEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'message.received'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://a.test/hook');
    expect(opts.redirect).toBe('manual');
    expect(opts.headers['X-Wacrm-Event']).toBe('message.received');
    expect(opts.headers['X-Wacrm-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    // Payload carries a dedupe id.
    expect(JSON.parse(opts.body).id).toMatch(/[0-9a-f-]{36}/);
    expect(markEndpointDelivered).toHaveBeenCalledWith(expect.anything(), 'acct-1', 'a');
    expect(recordWebhookFailure).not.toHaveBeenCalled();
  });

  it('records an atomic failure (RPC) when the endpoint errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));
    endpoints([{ id: 'b', url: 'https://b.test/hook', secret: 's2' }]);

    await dispatchWebhookEvent('acct-1', 'message.received', {});

    expect(recordWebhookFailure).toHaveBeenCalledWith(
      expect.anything(),
      'b',
      MAX_CONSECUTIVE_FAILURES
    );
    expect(markEndpointDelivered).not.toHaveBeenCalled();
  });

  it('blocks a non-public target (SSRF guard) without fetching', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    endpoints([{ id: 'c', url: 'https://127.0.0.1/hook', secret: 's3' }]);

    await dispatchWebhookEvent('acct-1', 'message.received', {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordWebhookFailure).toHaveBeenCalledWith(expect.anything(), 'c', MAX_CONSECUTIVE_FAILURES);
  });

  it('does nothing when no endpoints are subscribed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    endpoints([]);

    await dispatchWebhookEvent('acct-1', 'message.received', {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordWebhookFailure).not.toHaveBeenCalled();
    expect(markEndpointDelivered).not.toHaveBeenCalled();
  });

  it('never throws when the endpoint lookup fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(listActiveEndpointsForEvent).mockRejectedValue(new Error('db down'));

    await expect(dispatchWebhookEvent('acct-1', 'message.received', {})).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
