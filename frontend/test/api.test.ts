import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, TimeoutError } from '../src/lib/api';
import { setActiveInstance } from '../src/lib/instance';

// A fetch mock that rejects (like the browser) when its AbortSignal fires.
function hangingFetch(): typeof fetch {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const sig = init?.signal;
      if (sig) sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

const origFetch = globalThis.fetch;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

describe('http() client timeout', () => {
  it('rejects with TimeoutError when the request never resolves (text send: 25s)', async () => {
    globalThis.fetch = hangingFetch();
    const p = api.send(JID(), { type: 'text', data: { text: 'hi' } });
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;
  });

  it('does NOT reject before its budget; media/voice get 60s, text gets 25s', async () => {
    globalThis.fetch = hangingFetch();
    let mediaSettled = false;
    const media = api.send(JID(), { type: 'media', data: {} }).catch(() => (mediaSettled = true));
    // at 30s a text send would have timed out, but a media send (60s) must not
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mediaSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000); // now 60s total
    await media;
    expect(mediaSettled).toBe(true);
  });

  it('passes through a server error WITHOUT relabeling it a timeout', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'evo down' }, false, 502)) as unknown as typeof fetch;
    const p = api.send(JID(), { type: 'text', data: { text: 'hi' } });
    await expect(p).rejects.toThrow('evo down');
    await expect(p).rejects.not.toBeInstanceOf(TimeoutError);
  });

  it('a slow body parse of a 200 is never relabeled a timeout', async () => {
    // fetch resolves fast (timer cleared); json() resolves only after the would-be timeout
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => new Promise((res) => setTimeout(() => res({ ok: true, routed: 'evo' }), 40_000)),
    })) as unknown as typeof fetch;
    const p = api.send(JID(), { type: 'text', data: { text: 'hi' } });
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(p).resolves.toMatchObject({ ok: true });
  });
});

function JID() {
  return '972500000000@s.whatsapp.net';
}

describe('per-instance scoping', () => {
  afterEach(() => setActiveInstance(''));

  it('appends ?instance= to jobs, quick replies and analytics when a line is active', async () => {
    setActiveInstance('Second');
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    await api.jobs.list();
    await api.jobs.page('scheduled');
    await api.quickReplies.list();
    await api.quickReplies.create('hi', 'Hello');
    await api.analytics({ days: 7 });
    await api.agentInsights({ days: 7 });

    expect(urls).toHaveLength(6);
    for (const u of urls) expect(u).toContain('instance=Second');
    expect(api.analyticsCsvUrl({ days: 7 })).toContain('instance=Second');
  });

  it('omits instance for the default (empty) line', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    await api.jobs.list();
    expect(urls[0]).not.toContain('instance=');
  });
});

describe('ledger CSV url', () => {
  it('is the plain ledger with no filter, and carries one when there is', () => {
    expect(api.jobs.ledgerCsvUrl('job_1')).toBe('/api/jobs/job_1/ledger.csv');
    expect(api.jobs.ledgerCsvUrl('job_1', { status: 'failed' })).toBe(
      '/api/jobs/job_1/ledger.csv?status=failed',
    );
    // the search box's digits ride along, so the download matches the table
    expect(api.jobs.ledgerCsvUrl('job_1', { status: 'pending', q: ' 972521 ' })).toBe(
      '/api/jobs/job_1/ledger.csv?status=pending&q=972521',
    );
  });
});
