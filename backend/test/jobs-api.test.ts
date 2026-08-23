import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const validJob = {
  scheduledAt: FUTURE,
  recipients: [{ id: '972529876543' }],
  items: [{ type: 'text', data: { text: 'hello' } }],
};

describe('/api/jobs', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('validates input', async () => {
    const cases = [
      {},
      { ...validJob, scheduledAt: 'not-a-date' },
      { ...validJob, items: [] },
      { ...validJob, recipients: [] },
      { ...validJob, recipients: ['972529876543'] }, // bare strings are not recipients
      { ...validJob, recipients: [{ isGroup: true }] }, // id is mandatory
    ];
    for (const payload of cases) {
      const res = await t.app.inject({ method: 'POST', url: '/api/jobs', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('rejects unknown statuses, and running (scheduler-owned)', async () => {
    for (const status of ['bogus', 'running']) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: { ...validJob, status },
      });
      expect(res.statusCode, status).toBe(400);
    }
  });

  it('rejects items the send pipeline cannot build', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { ...validJob, items: [{ type: 'poll', data: { question: 'q', options: ['one'] } }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('invalid item');
  });

  it('refuses to edit a job while it is running', async () => {
    const job = (await t.app.inject({ method: 'POST', url: '/api/jobs', payload: validJob })).json();
    t.jobs.setStatus(job.id, 'running');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { ...validJob, id: job.id },
    });
    expect(res.statusCode).toBe(409);
  });

  it('clears a stale ledger when an edit changes the items', async () => {
    const job = (await t.app.inject({ method: 'POST', url: '/api/jobs', payload: validJob })).json();
    t.jobs.ensureLedger(t.jobs.byId(job.id)!);
    expect(t.jobs.allSends(job.id)).toHaveLength(1);

    await t.app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { ...validJob, id: job.id, items: [{ type: 'text', data: { text: 'edited' } }] },
    });
    // old rows are gone — the next run rebuilds the ledger from the new shape
    expect(t.jobs.allSends(job.id)).toHaveLength(0);
  });

  it('editing a finished job does not silently re-queue it', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const job = (
      await t.app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: { ...validJob, scheduledAt: past, status: 'done' },
      })
    ).json();

    // edit without a status — must keep 'done', not flip back to 'pending'
    const edited = (
      await t.app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: { ...validJob, scheduledAt: past, id: job.id, items: [{ type: 'text', data: { text: 'edited' } }] },
      })
    ).json();
    expect(edited.status).toBe('done');
    expect(t.jobs.due()).toHaveLength(0);

    // re-running is an explicit act
    const requeued = (
      await t.app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: { ...validJob, scheduledAt: past, id: job.id, status: 'pending' },
      })
    ).json();
    expect(requeued.status).toBe('pending');
  });

  it('cancels a running job (scheduler stops between sends)', async () => {
    const job = (await t.app.inject({ method: 'POST', url: '/api/jobs', payload: validJob })).json();
    t.jobs.setStatus(job.id, 'running');
    const res = (await t.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` })).json();
    expect(res.status).toBe('cancelled');
  });

  it('creates with defaults and upserts preserving createdAt', async () => {
    const created = (
      await t.app.inject({ method: 'POST', url: '/api/jobs', payload: validJob })
    ).json();
    expect(created).toMatchObject({ status: 'pending', type: 'compose' });
    expect(created.recipients).toEqual([{ id: '972529876543', isGroup: false }]);
    expect(created.id).toBeTruthy();

    const updated = (
      await t.app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: { ...validJob, id: created.id, items: [{ type: 'text', data: { text: 'edited' } }] },
      })
    ).json();
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.items[0].data.text).toBe('edited');

    expect((await t.app.inject({ method: 'GET', url: '/api/jobs' })).json()).toHaveLength(1);
  });

  it('exposes the per-recipient send ledger', async () => {
    const job = (await t.app.inject({ method: 'POST', url: '/api/jobs', payload: validJob })).json();
    t.jobs.ensureLedger(t.jobs.byId(job.id)!);

    const sends = (await t.app.inject({ method: 'GET', url: `/api/jobs/${job.id}/sends` })).json();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      recipient: '972529876543',
      itemIndex: 0,
      status: 'pending',
      attempts: 0,
    });

    const missing = await t.app.inject({ method: 'GET', url: '/api/jobs/nope/sends' });
    expect(missing.statusCode).toBe(404);
  });

  it('cancels pending jobs and restores future ones', async () => {
    const job = (await t.app.inject({ method: 'POST', url: '/api/jobs', payload: validJob })).json();

    const cancelled = (
      await t.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` })
    ).json();
    expect(cancelled.status).toBe('cancelled');

    const restored = (
      await t.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/restore` })
    ).json();
    expect(restored.status).toBe('pending');
  });

  it('does not restore a cancelled job whose time has passed', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const job = (
      await t.app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: { ...validJob, scheduledAt: past, status: 'cancelled' },
      })
    ).json();
    const after = (
      await t.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/restore` })
    ).json();
    expect(after.status).toBe('cancelled');
  });

  it('clear-done removes finished jobs but keeps pending ones', async () => {
    await t.app.inject({ method: 'POST', url: '/api/jobs', payload: validJob });
    await t.app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { ...validJob, id: 'job_done', status: 'done' },
    });
    const res = (await t.app.inject({ method: 'POST', url: '/api/jobs/clear-done' })).json();
    expect(res.removed).toBe(1);
    const left = (await t.app.inject({ method: 'GET', url: '/api/jobs' })).json();
    expect(left).toHaveLength(1);
    expect(left[0].status).toBe('pending');
  });

  it('separates jobs by instance — blank maps to the default line', async () => {
    // one blank-instance job (legacy → default 'Test') and one pinned to 'Second'
    await t.app.inject({ method: 'POST', url: '/api/jobs', payload: validJob });
    await t.app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { ...validJob, instance: 'Second' },
    });

    // default view (no ?instance=): the blank/default job only
    const def = (await t.app.inject({ method: 'GET', url: '/api/jobs?scope=scheduled' })).json();
    expect(def.jobs).toHaveLength(1);
    expect(def.total).toBe(1);

    // the other line sees only its own
    const second = (
      await t.app.inject({ method: 'GET', url: '/api/jobs?scope=scheduled&instance=Second' })
    ).json();
    expect(second.jobs).toHaveLength(1);
    expect(second.jobs[0].instance).toBe('Second');

    // the bare (legacy full-array) list is scoped to the default too
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs' })).json()).toHaveLength(1);
  });

  it('deletes a job', async () => {
    const job = (await t.app.inject({ method: 'POST', url: '/api/jobs', payload: validJob })).json();
    await t.app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` });
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs' })).json()).toHaveLength(0);
  });
});
