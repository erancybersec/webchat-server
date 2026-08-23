import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();
const textItem = { type: 'text', data: { text: 'hello' } };
const r = (id: string) => ({ id });

/** Poll until the wake-triggered scheduler run settles the job. */
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((res) => setTimeout(res, 20));
  }
}

describe('job history & pagination', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  function seed(n: number, status: string, opts: { type?: string; at?: string } = {}): void {
    const base = Date.now() - 10_000_000;
    for (let i = 0; i < n; i++) {
      t.jobs.upsert({
        id: `${status}_${opts.type ?? 'compose'}_${i}`,
        scheduledAt: opts.at ?? FUTURE,
        status: status as never,
        type: opts.type,
        recipients: [r('972521111111')],
        items: [textItem],
        createdAt: new Date(base + i * 1000).toISOString(),
      });
    }
  }

  it('pages history (120 done jobs) newest-first with scope counts', async () => {
    seed(120, 'done');
    const page1 = (
      await t.app.inject({ method: 'GET', url: '/api/jobs?scope=history&limit=50&offset=0' })
    ).json();
    expect(page1.jobs).toHaveLength(50);
    expect(page1.total).toBe(120);
    expect(page1.counts.done).toBe(120);
    expect(page1.jobs[0].id).toBe('done_compose_119'); // newest created first

    const page3 = (
      await t.app.inject({ method: 'GET', url: '/api/jobs?scope=history&limit=50&offset=100' })
    ).json();
    expect(page3.jobs).toHaveLength(20);

    // pages never overlap
    const ids = new Set([...page1.jobs, ...page3.jobs].map((j: { id: string }) => j.id));
    expect(ids.size).toBe(70);
  });

  it('pages the scheduled queue soonest-first and filters by status', async () => {
    for (let i = 0; i < 110; i++) {
      t.jobs.upsert({
        id: `p_${i}`,
        scheduledAt: new Date(Date.now() + (110 - i) * 60_000).toISOString(),
        recipients: [r('972521111111')],
        items: [textItem],
      });
    }
    seed(3, 'cancelled');
    const page = (
      await t.app.inject({ method: 'GET', url: '/api/jobs?scope=scheduled&limit=50' })
    ).json();
    expect(page.total).toBe(113);
    expect(page.counts).toEqual({ pending: 110, cancelled: 3 });
    expect(page.jobs[0].id).toBe('p_109'); // soonest scheduled first

    const cancelled = (
      await t.app.inject({ method: 'GET', url: '/api/jobs?scope=scheduled&status=cancelled' })
    ).json();
    expect(cancelled.jobs).toHaveLength(3);
    expect(cancelled.total).toBe(3);
  });

  it('splits scopes: immediate jobs live in history even while pending; finished leave scheduled', async () => {
    seed(1, 'pending'); // future scheduled job
    seed(1, 'done');
    seed(1, 'pending', { type: 'immediate', at: FUTURE }); // future => wake-less seed
    const scheduled = (
      await t.app.inject({ method: 'GET', url: '/api/jobs?scope=scheduled' })
    ).json();
    expect(scheduled.jobs.map((j: { id: string }) => j.id)).toEqual(['pending_compose_0']);
    const history = (await t.app.inject({ method: 'GET', url: '/api/jobs?scope=history' })).json();
    expect(history.jobs.map((j: { id: string }) => j.id).sort()).toEqual([
      'done_compose_0',
      'pending_immediate_0',
    ]);
  });

  it('rejects bad scope/status params; bare GET keeps the legacy array shape', async () => {
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/jobs?scope=bogus' })).statusCode,
    ).toBe(400);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/jobs?scope=history&status=bogus' })).statusCode,
    ).toBe(400);
    seed(2, 'done');
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs' })).json()).toHaveLength(2);
  });

  it('GET /api/jobs/:id returns the job or 404', async () => {
    seed(1, 'done');
    const ok = await t.app.inject({ method: 'GET', url: '/api/jobs/done_compose_0' });
    expect(ok.json().id).toBe('done_compose_0');
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs/nope' })).statusCode).toBe(404);
  });

  it('an immediate job (scheduledAt now) fires via wake without waiting for the poll', async () => {
    const res = (
      await t.app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          scheduledAt: new Date().toISOString(),
          type: 'immediate',
          recipients: [r('972521111111')],
          items: [textItem],
        },
      })
    ).json();
    expect(res.status).toBe('pending'); // snapshot taken before the wake runs
    await waitFor(() => t.jobs.byId(res.id)?.status === 'done');
    expect(t.evo.sentTo()).toEqual(['972521111111']);
    // and it lands in history, not the scheduled queue
    const history = (await t.app.inject({ method: 'GET', url: '/api/jobs?scope=history' })).json();
    expect(history.jobs[0].id).toBe(res.id);
  });

  it('rerun clones a finished job as an immediate send and fires it', async () => {
    seed(1, 'done', { at: PAST });
    const clone = (
      await t.app.inject({ method: 'POST', url: '/api/jobs/done_compose_0/rerun' })
    ).json();
    expect(clone.id).not.toBe('done_compose_0');
    expect(clone.type).toBe('immediate');
    await waitFor(() => t.jobs.byId(clone.id)?.status === 'done');
    expect(t.evo.sentTo()).toEqual(['972521111111']);
    // the original is untouched
    expect(t.jobs.byId('done_compose_0')!.status).toBe('done');
  });

  it('rerun refuses queued/running jobs and 404s on unknown ids', async () => {
    seed(1, 'pending');
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/jobs/pending_compose_0/rerun' })).statusCode,
    ).toBe(409);
    t.jobs.setStatus('pending_compose_0', 'running');
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/jobs/pending_compose_0/rerun' })).statusCode,
    ).toBe(409);
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/jobs/nope/rerun' })).statusCode,
    ).toBe(404);
  });

  it('scoped clear-done: history wipe keeps restorable cancelled scheduled jobs', async () => {
    seed(1, 'pending');
    seed(1, 'cancelled');
    seed(2, 'done');
    seed(1, 'failed', { type: 'immediate' });

    const hist = (
      await t.app.inject({ method: 'POST', url: '/api/jobs/clear-done', payload: { scope: 'history' } })
    ).json();
    expect(hist.removed).toBe(3); // 2 done + 1 immediate failed
    expect(t.jobs.byId('cancelled_compose_0')).not.toBeNull();

    const sched = (
      await t.app.inject({ method: 'POST', url: '/api/jobs/clear-done', payload: { scope: 'scheduled' } })
    ).json();
    expect(sched.removed).toBe(1); // the cancelled one; pending survives
    expect(t.jobs.byId('pending_compose_0')).not.toBeNull();

    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/jobs/clear-done',
      payload: { scope: 'bogus' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
