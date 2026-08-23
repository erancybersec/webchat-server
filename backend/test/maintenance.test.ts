import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('maintenance: report + cleanup + retention', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  /** A finished job with one sent ledger row, finished `n` days ago. */
  const oldDoneJob = (id: string, n: number) => {
    const job = t.jobs.upsert({
      id,
      scheduledAt: daysAgo(n),
      recipients: [{ id: '972521111111' }],
      items: [{ type: 'text', data: { text: 'x' } }],
    });
    t.jobs.ensureLedger(job);
    t.jobs.markSendDone(t.jobs.pendingSends(id)[0]!, 'sent', `m-${id}`);
    t.db.prepare(`UPDATE jobs SET status='done', finished_at=? WHERE id=?`).run(daysAgo(n), id);
  };

  it('GET /api/maintenance reports disk, db, table counts and Evolution counts', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/maintenance' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.db.sizeBytes).toBeGreaterThan(0);
    expect(body.tables).toMatchObject({ jobs: 0, job_sends: 0, blacklist: 0 });
    expect(body.evolution).toHaveLength(2);
    expect(body.evolution[1]).toMatchObject({
      name: 'Second',
      connectionStatus: 'close',
      counts: { messages: 222531, contacts: 8070, chats: 5921 },
    });
    expect(JSON.stringify(body)).not.toContain('SECRET-TOKEN');
    expect(body.retentionDays).toBe(0);
  });

  it('cleanup purges old finished jobs + ledger + attribution, keeps live work', async () => {
    oldDoneJob('old', 90);
    oldDoneJob('fresh', 2);
    // an old but still-scheduled job must survive whatever its age
    t.jobs.upsert({
      id: 'queued',
      scheduledAt: daysAgo(90),
      recipients: [{ id: '972521111111' }],
      items: [{ type: 'text', data: { text: 'x' } }],
    });
    // user-cancelled long ago (no finished_at!) → purged via scheduled_at
    t.jobs.upsert({
      id: 'cancelled-old',
      scheduledAt: daysAgo(90),
      status: 'cancelled',
      recipients: [{ id: '972521111111' }],
      items: [{ type: 'text', data: { text: 'x' } }],
    });
    t.db
      .prepare(`INSERT INTO message_agents (message_id, agent_email, sent_at) VALUES (?, ?, ?)`)
      .run('m-ancient', 'a@x.com', daysAgo(90));

    const dry = (
      await t.app.inject({
        method: 'POST',
        url: '/api/maintenance/cleanup',
        payload: { olderThanDays: 30, dryRun: true },
      })
    ).json();
    expect(dry).toMatchObject({ dryRun: true, jobs: 2, sends: 1, messageAgents: 1 });
    expect(t.jobs.byId('old')).not.toBeNull(); // dry run touched nothing

    const real = (
      await t.app.inject({
        method: 'POST',
        url: '/api/maintenance/cleanup',
        payload: { olderThanDays: 30, vacuum: true },
      })
    ).json();
    expect(real).toMatchObject({ dryRun: false, jobs: 2, sends: 1, messageAgents: 1, vacuumed: true });
    expect(t.jobs.byId('old')).toBeNull();
    expect(t.jobs.byId('cancelled-old')).toBeNull();
    expect(t.jobs.byId('fresh')).not.toBeNull();
    expect(t.jobs.byId('queued')).not.toBeNull();
    expect(t.jobs.allSends('old')).toHaveLength(0); // cascade
  });

  it('rejects bad cutoffs', async () => {
    for (const olderThanDays of [0, -1, 'x', null]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/maintenance/cleanup',
        payload: { olderThanDays },
      });
      expect(res.statusCode, String(olderThanDays)).toBe(400);
    }
  });

  it('retention sweep runs once per day from the scheduler poll', async () => {
    oldDoneJob('ancient', 90);
    t.cfg.retentionDays = 30;
    await t.scheduler.tick();
    expect(t.jobs.byId('ancient')).toBeNull();

    // same-day second tick must not re-run the sweep (cheap guard check:
    // re-insert and verify it survives the next tick)
    oldDoneJob('ancient2', 90);
    await t.scheduler.tick();
    expect(t.jobs.byId('ancient2')).not.toBeNull();
  });

  it('retention 0 (default) never purges', async () => {
    oldDoneJob('ancient', 400);
    await t.scheduler.tick();
    expect(t.jobs.byId('ancient')).not.toBeNull();
  });

  it('settings round-trip: retentionDays', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { retentionDays: 45 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().retentionDays).toBe(45);
    expect(t.cfg.retentionDays).toBe(45);
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { retentionDays: -1 },
    });
    expect(bad.statusCode).toBe(400);
  });
});
