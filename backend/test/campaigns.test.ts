import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BlacklistStore } from '../src/services/blacklist.js';
import { estimatePendingMinutes, JobStore } from '../src/services/jobs.js';
import { Scheduler, type JobProgress } from '../src/services/scheduler.js';
import { Sender } from '../src/services/sender.js';
import { FakeEvo, makeApp, type TestApp } from './helpers.js';

/** CSV body as rows (the export is CRLF, like every other CSV here). */
const csvRows = (body: string) => body.trim().split(/\r?\n/);

const PAST = new Date(Date.now() - 60_000).toISOString();
const textItem = { type: 'text', data: { text: 'hello' } };
const r = (id: string) => ({ id });
const five = ['972521111111', '972522222222', '972523333333', '972524444444', '972525555555'].map(r);

/** 'HH:MM' of a moment, as the scheduler's clock knobs are written. */
const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('campaign control (batching, pause, continue)', () => {
  let db: Db;
  let jobs: JobStore;
  let evo: FakeEvo;
  let scheduler: Scheduler;
  let events: JobProgress[];

  beforeEach(() => {
    db = openDb(':memory:');
    jobs = new JobStore(db);
    evo = new FakeEvo();
    events = [];
    scheduler = new Scheduler(
      jobs,
      new Sender(evo, new BlacklistStore(db)),
      { pollMs: 60_000, delayMinMs: 0, delayMaxMs: 0, maxOverdueMin: 0, sendMaxAttempts: 3 },
      () => {},
      (event, data) => {
        if (event === 'JOB_PROGRESS') events.push(data as JobProgress);
      },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('sends one batch, re-queues itself for later, and finishes the rest on the next run', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: five,
      items: [textItem],
      batch: { size: 2, pauseMin: 30 },
    });

    await scheduler.tick();
    let job = jobs.byId('j1')!;
    expect(evo.sentTo()).toHaveLength(2);
    // out of 'running' without finalizing: still queued, due after the pause
    expect(job.status).toBe('pending');
    expect(job.result).toContain('2 of 5 done');
    const gap = new Date(job.scheduledAt).getTime() - Date.now();
    expect(gap).toBeGreaterThan(25 * 60_000);
    expect(gap).toBeLessThan(31 * 60_000);
    expect(jobs.allSends('j1').filter((s) => s.status === 'pending')).toHaveLength(3);
    // the browser is told where it stopped, and that it is NOT done
    const last = events.at(-1)!;
    expect(last.done).toBe(false);
    expect(last.pending).toBe(3);
    expect(last.nextRunAt).toBeTruthy();

    // the pause elapses (whatever moves it: the clock, or a manual Continue)
    jobs.resume('j1');
    await scheduler.tick();
  });

  it('picks a randomized wait within [pauseMin, pauseMinMax] at a batch boundary', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: five,
      items: [textItem],
      batch: { size: 2, pauseMin: 20, pauseMinMax: 40 },
    });

    await scheduler.tick();
    const job = jobs.byId('j1')!;
    const gap = new Date(job.scheduledAt).getTime() - Date.now();
    expect(gap).toBeGreaterThanOrEqual(20 * 60_000 - 1000);
    expect(gap).toBeLessThanOrEqual(40 * 60_000 + 1000);
    expect(job.status).toBe('pending');
    expect(evo.sentTo()).toHaveLength(2);
  });

  it('waits for a human when the batch pause is 0 ("send X, then wait for me")', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: five,
      items: [textItem],
      batch: { size: 2, pauseMin: 0 },
    });

    await scheduler.tick();
    expect(jobs.byId('j1')!.status).toBe('paused');
    expect(jobs.byId('j1')!.result).toContain('waiting for Continue');
    expect(evo.sentTo()).toHaveLength(2);

    // a paused campaign stays put across as many ticks as it likes
    await scheduler.tick();
    expect(evo.sentTo()).toHaveLength(2);

    expect(jobs.resume('j1')).toBe(true);
    await scheduler.tick();
    expect(jobs.byId('j1')!.status).toBe('paused');
    expect(evo.sentTo()).toHaveLength(4);
  });

  it('a batch boundary on the last recipient finishes the job instead of pausing it', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: five,
      items: [textItem],
      batch: { size: 5, pauseMin: 0 },
    });
    await scheduler.tick();
    expect(jobs.byId('j1')!.status).toBe('done');
    expect(evo.sentTo()).toHaveLength(5);
  });

  it('honors a pause that lands mid-run, leaving the rest of the ledger pending', async () => {
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: five, items: [textItem] });
    // pause arrives while the first send is on the wire
    const call = evo.call.bind(evo);
    vi.spyOn(evo, 'call').mockImplementation(async (endpoint, body, method) => {
      const res = await call(endpoint, body, method);
      jobs.pause('j1');
      return res;
    });

    await scheduler.tick();
    const job = jobs.byId('j1')!;
    expect(evo.sentTo()).toHaveLength(1);
    expect(job.status).toBe('paused');
    expect(job.result).toContain('4 waiting for Continue');
    expect(jobs.allSends('j1').filter((s) => s.status === 'pending')).toHaveLength(4);
    // nothing was marked failed just because we stopped
    expect(jobs.allSends('j1').some((s) => s.status === 'failed')).toBe(false);
  });

  it('a blacklist skip does not spend the batch', async () => {
    new BlacklistStore(db).addMany([{ phone_number: '972521111111' }]);
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: five,
      items: [textItem],
      batch: { size: 1, pauseMin: 30 },
    });
    await scheduler.tick();
    // the skip cost nothing, so one real message still went out
    expect(evo.sentTo()).toEqual(['972522222222']);
    const sends = jobs.allSends('j1');
    expect(sends.filter((s) => s.status === 'skipped')).toHaveLength(1);
    expect(sends.filter((s) => s.status === 'pending')).toHaveLength(3);
  });

  it('stops at "pause at HH:MM" and picks up at the continue-time', async () => {
    // only Date is faked — the pacing sleep still uses real timers
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date(2026, 7, 19, 20, 59, 30);
    vi.setSystemTime(start);
    jobs.upsert({
      id: 'j1',
      scheduledAt: new Date(start.getTime() - 60_000).toISOString(),
      recipients: five,
      items: [textItem],
      batch: { size: 1000, pauseMin: 0, pauseAt: '21:00', resumeAt: '09:00' },
    });
    // the clock crosses 21:00 after the first send
    const call = evo.call.bind(evo);
    vi.spyOn(evo, 'call').mockImplementation(async (endpoint, body, method) => {
      const res = await call(endpoint, body, method);
      vi.setSystemTime(new Date(2026, 7, 19, 21, 0, 5));
      return res;
    });

    await scheduler.tick();
    const job = jobs.byId('j1')!;
    expect(evo.sentTo()).toHaveLength(1);
    expect(job.status).toBe('pending');
    expect(job.result).toContain('reached 21:00');
    // continues at the next 09:00, i.e. tomorrow morning
    const next = new Date(job.scheduledAt);
    expect(next.getHours()).toBe(9);
    expect(next.getDate()).toBe(20);
  });

  it('without a continue-time, the clock cutoff waits for a human', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date(2026, 7, 19, 20, 59, 30);
    vi.setSystemTime(start);
    jobs.upsert({
      id: 'j1',
      scheduledAt: new Date(start.getTime() - 60_000).toISOString(),
      recipients: five,
      items: [textItem],
      batch: { size: 1000, pauseMin: 0, pauseAt: '21:00' },
    });
    const call = evo.call.bind(evo);
    vi.spyOn(evo, 'call').mockImplementation(async (endpoint, body, method) => {
      const res = await call(endpoint, body, method);
      vi.setSystemTime(new Date(2026, 7, 19, 21, 0, 5));
      return res;
    });

    await scheduler.tick();
    expect(jobs.byId('j1')!.status).toBe('paused');
    // and a Continue right after the cutoff is not instantly re-stopped: the
    // next run fixes a fresh cutoff (tomorrow's 21:00)
    vi.setSystemTime(new Date(2026, 7, 19, 21, 5, 0));
    vi.spyOn(evo, 'call').mockImplementation(call);
    jobs.resume('j1');
    await scheduler.tick();
    expect(jobs.byId('j1')!.status).toBe('done');
    expect(evo.sentTo()).toHaveLength(5);
  });

  it('runs until an hour and continues at another, with no batching at all', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date(2026, 7, 19, 20, 59, 30);
    vi.setSystemTime(start);
    jobs.upsert({
      id: 'j1',
      scheduledAt: new Date(start.getTime() - 60_000).toISOString(),
      recipients: five,
      items: [textItem],
      // no size: the sending window is the whole rule
      batch: { pauseMin: 0, pauseAt: '21:00', resumeAt: '09:00' },
    });
    const call = evo.call.bind(evo);
    let sends = 0;
    vi.spyOn(evo, 'call').mockImplementation(async (endpoint, body, method) => {
      const res = await call(endpoint, body, method);
      // the clock crosses 21:00 in the middle of the run
      if (++sends === 2) vi.setSystemTime(new Date(2026, 7, 19, 21, 0, 5));
      return res;
    });

    await scheduler.tick();
    const job = jobs.byId('j1')!;
    expect(evo.sentTo()).toHaveLength(2);
    expect(job.status).toBe('pending');
    expect(job.result).toContain('reached 21:00');
    expect(new Date(job.scheduledAt).getHours()).toBe(9);
    expect(jobs.allSends('j1').filter((s) => s.status === 'pending')).toHaveLength(3);

    // 09:00 comes round and it finishes in one go — no batch boundaries
    vi.setSystemTime(new Date(2026, 7, 20, 9, 0, 1));
    vi.spyOn(evo, 'call').mockImplementation(call);
    await scheduler.tick();
    expect(jobs.byId('j1')!.status).toBe('done');
    expect(new Set(evo.sentTo()).size).toBe(5);
  });

  it('a campaign already under way respects quiet hours, even an immediate one', async () => {
    const now = new Date();
    const quiet = new Scheduler(
      jobs,
      new Sender(evo, new BlacklistStore(db)),
      {
        pollMs: 60_000,
        delayMinMs: 0,
        delayMaxMs: 0,
        maxOverdueMin: 0,
        sendMaxAttempts: 3,
        quietEnabled: true,
        quietStart: hhmm(new Date(now.getTime() - 60 * 60_000)),
        quietEnd: hhmm(new Date(now.getTime() + 60 * 60_000)),
      },
      () => {},
    );

    // an untouched immediate send still bypasses quiet hours (someone is at
    // the keyboard), but the same job mid-campaign waits for the window
    jobs.upsert({ id: 'fresh', scheduledAt: PAST, type: 'immediate', recipients: [r('972521111111')], items: [textItem] });
    jobs.upsert({
      id: 'midway',
      scheduledAt: PAST,
      type: 'immediate',
      recipients: [r('972522222222')],
      items: [textItem],
      batch: { size: 1, pauseMin: 5 },
    });
    db.prepare(`UPDATE jobs SET started_at=? WHERE id='midway'`).run(PAST);

    await quiet.tick();
    expect(evo.sentTo()).toEqual(['972521111111']);
    const held = jobs.byId('midway')!;
    expect(held.status).toBe('pending');
    expect(new Date(held.scheduledAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('progress is computed from the ledger, so it survives a restart', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: five,
      items: [textItem],
      batch: { size: 2, pauseMin: 30 },
    });
    await scheduler.tick();

    // a fresh store on the same DB = what a restarted server sees
    const p = new JobStore(db).progress('j1', 2000)!;
    expect(p.total).toBe(5);
    expect(p.sent).toBe(2);
    expect(p.pending).toBe(3);
    expect(p.status).toBe('pending');
    expect(p.startedAt).toBeTruthy();
    expect(p.nextRunAt).toBe(jobs.byId('j1')!.scheduledAt);
    expect(p.batch).toEqual({ size: 2, pauseMin: 30 });
    // 3 left at the assumed 30/min, plus the one batch pause still ahead
    expect(p.etaMinutes).toBeCloseTo(3 / 30 + 30, 5);
  });

  it('gives no ETA when the pacing ahead depends on a human, instead of a falsely-early one', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: five,
      items: [textItem],
      batch: { size: 2, pauseMin: 0 }, // "send X, then wait for me"
    });
    await scheduler.tick();
    expect(jobs.progress('j1', 2000)!.etaMinutes).toBeNull();
  });

  it('gives no ETA past a sending window with no auto-resume', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date(2026, 7, 19, 20, 59, 30);
    vi.setSystemTime(start);
    jobs.upsert({
      id: 'j1',
      scheduledAt: new Date(start.getTime() - 60_000).toISOString(),
      recipients: five,
      items: [textItem],
      batch: { size: 1000, pauseMin: 0, pauseAt: '21:00' },
    });
    const call = evo.call.bind(evo);
    vi.spyOn(evo, 'call').mockImplementation(async (endpoint, body, method) => {
      const res = await call(endpoint, body, method);
      vi.setSystemTime(new Date(2026, 7, 19, 21, 0, 5));
      return res;
    });

    await scheduler.tick();
    const p = jobs.progress('j1', 2000)!;
    expect(p.pending).toBeGreaterThan(0);
    expect(p.etaMinutes).toBeNull();
  });

  it("the window's overnight gap is counted, not silently dropped", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date(2026, 7, 19, 20, 59, 30);
    vi.setSystemTime(start);
    jobs.upsert({
      id: 'j1',
      scheduledAt: new Date(start.getTime() - 60_000).toISOString(),
      recipients: five,
      items: [textItem],
      // no size: the sending window is the whole rule, same as the
      // "no batching at all" scheduler test above
      batch: { pauseMin: 0, pauseAt: '21:00', resumeAt: '09:00' },
    });
    const call = evo.call.bind(evo);
    let sends = 0;
    vi.spyOn(evo, 'call').mockImplementation(async (endpoint, body, method) => {
      const res = await call(endpoint, body, method);
      if (++sends === 2) vi.setSystemTime(new Date(2026, 7, 19, 21, 0, 5));
      return res;
    });

    await scheduler.tick();
    const p = jobs.progress('j1', 2000)!;
    expect(p.pending).toBe(3);
    const naive = p.pending / 30; // what the old (buggy) formula would have said
    expect(p.etaMinutes).not.toBeNull();
    // the real gap is ~12 hours (21:00 → 09:00) — nowhere near the naive figure
    expect(p.etaMinutes!).toBeGreaterThan(naive + 11 * 60);
  });

  it('a randomized batch wait is estimated at its midpoint', () => {
    const withRange = estimatePendingMinutes(3, 30, { size: 2, pauseMin: 20, pauseMinMax: 40 });
    const withMidpoint = estimatePendingMinutes(3, 30, { size: 2, pauseMin: 30 });
    expect(withRange).toBeCloseTo(withMidpoint!, 5);
  });

  it('keeps a multi-message sequence whole at a batch boundary', async () => {
    // batch of 1 with a 2-message sequence: the boundary must not leave anyone
    // holding half a conversation until the pause ends
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: five,
      items: [textItem, { type: 'text', data: { text: 'and one more' } }],
      batch: { size: 1, pauseMin: 0 },
    });
    await scheduler.tick();
    expect(jobs.byId('j1')!.status).toBe('paused');
    // one recipient, BOTH of their messages
    const sent = jobs.allSends('j1').filter((s) => s.status === 'sent');
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((s) => s.recipient)).size).toBe(1);
    expect(sent.map((s) => s.itemIndex).sort()).toEqual([0, 1]);
  });

  it('measures the pace from real gaps, not across the pauses', async () => {
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: five, items: [textItem] });
    jobs.ensureLedger(jobs.byId('j1')!);
    // four sends 2s apart, then a 40-minute hole (a batch pause), then two more
    const base = Date.now() - 60 * 60_000;
    const stamps = [0, 2_000, 4_000, 6_000, 40 * 60_000, 40 * 60_000 + 2_000];
    const rows = jobs.allSends('j1');
    stamps.forEach((offset, i) => {
      const row = rows[i % rows.length]!;
      db.prepare(
        `UPDATE job_sends SET status='sent', sent_at=? WHERE job_id='j1' AND recipient=? AND item_index=?`,
      ).run(new Date(base + offset).toISOString(), row.recipient, row.itemIndex);
    });

    // ~2s between sends = ~30/min. Averaging across the whole span would say ~0.1
    const p = jobs.progress('j1', 2_000)!;
    expect(p.ratePerMin).toBeGreaterThan(20);
    expect(p.ratePerMin).toBeLessThan(40);
  });

  it('follows a send gap raised in Settings mid-campaign', async () => {
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: five, items: [textItem] });
    jobs.ensureLedger(jobs.byId('j1')!);
    // four sends 2s apart: the campaign HAS been running at ~30/min
    const base = Date.now() - 10 * 60_000;
    jobs.allSends('j1').slice(0, 5).forEach((row, i) => {
      db.prepare(
        `UPDATE job_sends SET status='sent', sent_at=? WHERE job_id='j1' AND recipient=? AND item_index=?`,
      ).run(new Date(base + i * 2_000).toISOString(), row.recipient, row.itemIndex);
    });

    // at the old 2s gap the measured pace stands
    expect(jobs.progress('j1', 2_000, 2_000)!.ratePerMin).toBeCloseTo(30, 0);

    // the operator raises the gap to 30-40s. The loop cannot beat 30s, so the
    // estimate must correct AT ONCE rather than coasting on the old average.
    const p = jobs.progress('j1', 35_000, 30_000)!;
    expect(p.ratePerMin).toBeCloseTo(2, 1);
  });

  it('a recurring campaign keeps its pacing on the next occurrence', async () => {
    const paced = new Scheduler(
      jobs,
      new Sender(evo, new BlacklistStore(db)),
      { pollMs: 60_000, delayMinMs: 0, delayMaxMs: 0, maxOverdueMin: 0, sendMaxAttempts: 3, recurringEnabled: true },
      () => {},
    );
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [r('972521111111')],
      items: [textItem],
      repeat: { freq: 'weekly' },
      batch: { size: 100, pauseMin: 0, pauseAt: '21:00', resumeAt: '09:00' },
    });
    await paced.tick();

    const next = jobs.all().find((j) => j.id !== 'j1')!;
    expect(next.repeat).toEqual({ freq: 'weekly' });
    // without this the second week would go out unpaced, at any hour
    expect(next.batch).toEqual({ size: 100, pauseMin: 0, pauseAt: '21:00', resumeAt: '09:00' });
  });

  it('pages and filters the ledger server-side', async () => {
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: five, items: [textItem] });
    jobs.ensureLedger(jobs.byId('j1')!);
    await scheduler.tick();

    expect(jobs.sendsPage('j1', { limit: 2, offset: 0 }).sends).toHaveLength(2);
    expect(jobs.sendsPage('j1', { limit: 2, offset: 4 }).total).toBe(5);
    expect(jobs.sendsPage('j1', { status: 'sent', limit: 100, offset: 0 }).total).toBe(5);
    expect(jobs.sendsPage('j1', { status: 'failed', limit: 100, offset: 0 }).sends).toEqual([]);
    const hit = jobs.sendsPage('j1', { q: '3333', limit: 100, offset: 0 });
    expect(hit.total).toBe(1);
    expect(hit.sends[0]!.recipient).toBe('972523333333');
  });

  it('editing a paused campaign keeps who already got it', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: five,
      items: [textItem],
      batch: { size: 2, pauseMin: 0 },
    });
    await scheduler.tick();
    const sentFirst = evo.sentTo();
    expect(jobs.byId('j1')!.status).toBe('paused');

    // rewrite the message, drop one un-sent recipient, add a new one
    const kept = five.filter((x) => x.id !== '972525555555');
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [...kept, r('972526666666')],
      items: [{ type: 'text', data: { text: 'rewritten' } }],
    });

    const after = jobs.allSends('j1');
    // the record of the first batch is untouched...
    for (const done of sentFirst) expect(after.find((s) => s.recipient === done)!.status).toBe('sent');
    // ...the dropped recipient's unsent row is gone, and the edit left the
    // campaign paused rather than re-queueing it
    expect(after.some((s) => s.recipient === '972525555555')).toBe(false);
    expect(jobs.byId('j1')!.status).toBe('paused');
    expect(jobs.byId('j1')!.result).toContain('waiting for Continue');

    // it keeps its pacing, so continuing walks it batch by batch to the end
    for (let i = 0; i < 5 && jobs.byId('j1')!.status === 'paused'; i++) {
      jobs.resume('j1');
      await scheduler.tick();
    }
    expect(jobs.byId('j1')!.status).toBe('done');
    const texts = evo.calls.filter((c) => c.body?.text).map((c) => c.body.text as string);
    // no one was sent to twice, the remainder got the new text, and the
    // recipient added while paused is included
    expect(new Set(evo.sentTo()).size).toBe(evo.sentTo().length);
    expect(texts.filter((x) => x === 'rewritten')).toHaveLength(3);
    expect(evo.sentTo()).toContain('972526666666');
  });
});

describe('campaign control API', () => {
  let t: TestApp;
  const base = {
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    recipients: [{ id: '972521111111' }, { id: '972522222222' }],
    items: [{ type: 'text', data: { text: 'hello' } }],
  };
  const post = (url: string, payload?: unknown) => t.app.inject({ method: 'POST', url, payload });
  /**
   * Save a job for later, make it due behind the scheduler's back, then run
   * exactly one tick. Saving a job that is ALREADY due pokes the scheduler, and
   * a tick() racing that in-flight run returns immediately (it is re-entrant by
   * design) — which would make anything asserted after it a coin flip.
   */
  async function runOneTick(payload: Record<string, unknown>) {
    const job = (await post('/api/jobs', payload)).json();
    t.db
      .prepare(`UPDATE jobs SET scheduled_at=? WHERE id=?`)
      .run(new Date(Date.now() - 1000).toISOString(), job.id);
    await t.scheduler.tick();
    return job;
  }

  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('round-trips a batch rule and rejects a nonsensical one', async () => {
    const ok = (await post('/api/jobs', { ...base, batch: { size: 50, pauseMin: 30, pauseAt: '21:00', resumeAt: '09:00' } })).json();
    expect(ok.batch).toEqual({ size: 50, pauseMin: 30, pauseAt: '21:00', resumeAt: '09:00' });
    // an edit that says nothing about pacing keeps it
    const edited = (await post('/api/jobs', { ...base, id: ok.id })).json();
    expect(edited.batch).toEqual(ok.batch);
    // ...and null clears it
    expect((await post('/api/jobs', { ...base, id: ok.id, batch: null })).json().batch).toBe(null);

    // a window with no batching at all is a perfectly good rule
    const windowOnly = (
      await post('/api/jobs', { ...base, batch: { pauseAt: '21:00', resumeAt: '09:00' } })
    ).json();
    expect(windowOnly.batch).toEqual({ pauseMin: 0, pauseAt: '21:00', resumeAt: '09:00' });

    // a randomized batch wait round-trips
    const ranged = (
      await post('/api/jobs', { ...base, batch: { size: 50, pauseMin: 20, pauseMinMax: 40 } })
    ).json();
    expect(ranged.batch).toEqual({ size: 50, pauseMin: 20, pauseMinMax: 40 });

    // a cold-cap override alone is a perfectly good rule too — no size or hour needed
    const coldCapOnly = (
      await post('/api/jobs', { ...base, batch: { pauseMin: 0, coldCap: { dailyCap: 25 } } })
    ).json();
    expect(coldCapOnly.batch).toEqual({ pauseMin: 0, coldCap: { dailyCap: 25 } });

    for (const batch of [
      { size: 0 },
      {}, // paces nothing: no size, no hour, no cold-cap override
      { pauseMin: 30 }, // ditto — a wait with nothing to wait between
      { size: 1.5 },
      { size: 10, pauseMin: -1 },
      { size: 10, pauseMin: 99999 },
      { size: 10, pauseAt: '25:00' },
      { size: 10, resumeAt: '09:00' }, // a continue-time with nothing to continue from
      { size: 10, pauseMin: 0, pauseMinMax: 20 }, // a manual wait can't be randomized
      { size: 10, pauseMin: 20, pauseMinMax: 10 }, // max below min
      { size: 10, pauseMin: 20, pauseMinMax: 20 }, // not a real range
      { size: 10, pauseMin: 30, coldCap: { dailyCap: 0 } },
      { size: 10, pauseMin: 30, coldCap: { dailyCap: -1 } },
      'nope',
    ]) {
      const res = await post('/api/jobs', { ...base, batch });
      expect(res.statusCode, JSON.stringify(batch)).toBe(400);
    }
  });

  it('pauses, continues, and reports progress', async () => {
    const job = (await post('/api/jobs', base)).json();

    expect((await post(`/api/jobs/${job.id}/pause`)).json().status).toBe('paused');
    // pausing again is a no-op conflict, not a silent success
    expect((await post(`/api/jobs/${job.id}/pause`)).statusCode).toBe(409);

    const progress = (await t.app.inject({ url: `/api/jobs/${job.id}/progress` })).json();
    expect(progress).toMatchObject({ jobId: job.id, status: 'paused', total: 0, pending: 0 });

    const resumed = (await post(`/api/jobs/${job.id}/resume`)).json();
    expect(resumed.status).toBe('pending');
    // due now, so the scheduler picks it up on this tick rather than the old time
    expect(new Date(resumed.scheduledAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect((await post(`/api/jobs/${job.id}/resume`)).statusCode).toBe(409);

    for (const url of ['/api/jobs/nope/pause', '/api/jobs/nope/resume', '/api/jobs/nope/progress'])
      expect((await t.app.inject({ method: url.endsWith('progress') ? 'GET' : 'POST', url })).statusCode).toBe(404);
  });

  it('continues a campaign that was stopped after it had started', async () => {
    const job = (await post('/api/jobs', base)).json();
    t.db.prepare(`UPDATE jobs SET started_at=?, status='cancelled' WHERE id=?`).run(base.scheduledAt, job.id);
    expect((await post(`/api/jobs/${job.id}/resume`)).json().status).toBe('pending');
  });

  it('a stopped job that never started is not resumable (it is a Restore)', async () => {
    const job = (await post('/api/jobs', base)).json();
    await post(`/api/jobs/${job.id}/cancel`);
    expect((await post(`/api/jobs/${job.id}/resume`)).statusCode).toBe(409);
  });

  it('lets a paused campaign be edited, but not re-shaped', async () => {
    const job = await runOneTick({ ...base, batch: { size: 1, pauseMin: 0 } });
    expect(t.jobs.byId(job.id)!.status).toBe('paused');
    expect(t.jobs.byId(job.id)!.startedAt).toBeTruthy();

    // same number of items: allowed, and the sent row survives
    const edit = await post('/api/jobs', {
      ...base,
      id: job.id,
      items: [{ type: 'text', data: { text: 'rewritten' } }],
    });
    expect(edit.statusCode).toBe(200);
    expect(t.jobs.allSends(job.id).filter((s) => s.status === 'sent')).toHaveLength(1);

    // adding a message would shift every ledger row's item index
    const reshape = await post('/api/jobs', {
      ...base,
      id: job.id,
      items: [...base.items, { type: 'text', data: { text: 'second' } }],
    });
    expect(reshape.statusCode).toBe(409);
    expect(reshape.json().error).toContain('not add or remove');
  });

  it('editing a campaign leaves it in the list it was already in', async () => {
    const job = await runOneTick({ ...base, type: 'immediate', batch: { size: 1, pauseMin: 0 } });
    expect(t.jobs.byId(job.id)!.status).toBe('paused');
    // Compose does not send `type` when it saves an edit — the job must not
    // slide from History into the Scheduled queue because of that
    const edited = (await post('/api/jobs', { ...base, id: job.id })).json();
    expect(edited.type).toBe('immediate');
    expect(t.jobs.page('history', { limit: 50, offset: 0 }).counts.paused).toBe(1);
  });

  it('a paused campaign survives every bulk clear', async () => {
    const scheduled = (await post('/api/jobs', base)).json();
    const immediate = (await post('/api/jobs', { ...base, type: 'immediate' })).json();
    for (const id of [scheduled.id, immediate.id]) await post(`/api/jobs/${id}/pause`);

    for (const scope of ['history', 'scheduled', undefined])
      await post('/api/jobs/clear-done', scope ? { scope } : {});

    expect(t.jobs.byId(scheduled.id)!.status).toBe('paused');
    expect(t.jobs.byId(immediate.id)!.status).toBe('paused');
    // and it stays visible in a list: the queue for the scheduled one,
    // History for the immediate one (where its progress is watched)
    expect(t.jobs.page('scheduled', { limit: 50, offset: 0 }).counts.paused).toBe(1);
    expect(t.jobs.page('history', { limit: 50, offset: 0 }).counts.paused).toBe(1);
  });

  it('retries the ones that failed, and only those', async () => {
    // a dead recipient: every attempt fails, the rest go out
    t.evo.failuresLeft.set('972521111111', 99);
    const job = await runOneTick(base);
    // one of two failed, so the job itself reads 'done' — which is exactly the
    // state a "retry the failures" action has to work from
    expect(t.jobs.byId(job.id)!.status).toBe('done');
    expect(t.jobs.byId(job.id)!.result).toContain('1 failed');
    const failedFirst = t.jobs.allSends(job.id).filter((s) => s.status === 'failed');
    expect(failedFirst).toHaveLength(1);

    // the number is fixed (whatever it was), so retry just that row
    t.evo.failuresLeft.set('972521111111', 0);
    const res = await post(`/api/jobs/${job.id}/retry-failed`);
    expect(res.json().retried).toBe(1);
    await t.scheduler.tick();

    expect(t.jobs.allSends(job.id).every((s) => s.status === 'sent')).toBe(true);
    // the recipient who already got it was left alone: one message, ever
    expect(t.evo.sentTo().filter((n) => n === '972522222222')).toHaveLength(1);

    // nothing failing = nothing to retry
    expect((await post(`/api/jobs/${job.id}/retry-failed`)).statusCode).toBe(409);
    expect((await post('/api/jobs/nope/retry-failed')).statusCode).toBe(404);
  });

  it('keeps the ones that were not sent as a reusable list', async () => {
    t.evo.failuresLeft.set('972521111111', 99);
    const job = await runOneTick({
      ...base,
      recipients: [...base.recipients, { id: '972523333333', name: 'Third' }],
      batch: { size: 2, pauseMin: 0 },
    });
    // one sent, one that errored, one never reached (the batch stopped first).
    // The errored row is out of attempts here, so it reads 'failed' — "not sent"
    // has to cover both it and the recipient the run never got to.
    t.db
      .prepare(`UPDATE job_sends SET status='failed', last_error='no route' WHERE job_id=? AND recipient=?`)
      .run(job.id, '972521111111');
    const before = t.jobs.allSends(job.id);
    expect(before.filter((s) => s.status === 'sent')).toHaveLength(1);
    expect(before.filter((s) => s.status === 'failed')).toHaveLength(1);
    expect(before.filter((s) => s.status === 'pending')).toHaveLength(1);

    const res = await post(`/api/jobs/${job.id}/unsent-list`, { name: 'Round two' });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toBe(2);

    // it is an ordinary audience, pickable in Compose, with names intact
    const list = (await t.app.inject({ url: `/api/lists/${res.json().list.id}` })).json();
    expect(list.name).toBe('Round two');
    expect(list.members.map((m: { recipient: string }) => m.recipient).sort()).toEqual([
      '972521111111',
      '972523333333',
    ]);
    expect(list.members.find((m: { recipient: string }) => m.recipient === '972523333333').name).toBe('Third');

    // the campaign itself is untouched by the export
    expect(t.jobs.allSends(job.id)).toEqual(before);
  });

  it('refuses to build a list when everyone was reached', async () => {
    const job = await runOneTick(base);
    expect(t.jobs.byId(job.id)!.status).toBe('done');
    const res = await post(`/api/jobs/${job.id}/unsent-list`, {});
    expect(res.statusCode).toBe(409);
  });

  it('exports the ledger the table is showing, not always all of it', async () => {
    t.evo.failuresLeft.set('972521111111', 99);
    const job = await runOneTick(base);

    const all = await t.app.inject({ url: `/api/jobs/${job.id}/ledger.csv` });
    expect(csvRows(all.body)).toHaveLength(3); // header + 2 rows
    const failed = await t.app.inject({ url: `/api/jobs/${job.id}/ledger.csv?status=failed` });
    const lines = csvRows(failed.body);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('972521111111');
    expect(failed.headers['content-disposition']).toContain('-failed-ledger.csv');
    expect((await t.app.inject({ url: `/api/jobs/${job.id}/ledger.csv?status=bogus` })).statusCode).toBe(400);
  });

  it('serves one page of the ledger', async () => {
    const job = await runOneTick(base);

    const page = (await t.app.inject({ url: `/api/jobs/${job.id}/sends/page?limit=1` })).json();
    expect(page.total).toBe(2);
    expect(page.sends).toHaveLength(1);
    const filtered = (await t.app.inject({ url: `/api/jobs/${job.id}/sends/page?status=sent&q=%2B972-52-222-2222` })).json();
    expect(filtered.total).toBe(1);
    expect((await t.app.inject({ url: `/api/jobs/${job.id}/sends/page?status=bogus` })).statusCode).toBe(400);
  });
});
