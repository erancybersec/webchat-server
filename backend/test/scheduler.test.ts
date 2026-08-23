import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BlacklistStore } from '../src/services/blacklist.js';
import { JobStore } from '../src/services/jobs.js';
import { Scheduler } from '../src/services/scheduler.js';
import { Sender } from '../src/services/sender.js';
import { FakeEvo } from './helpers.js';

const PAST = new Date(Date.now() - 60_000).toISOString();
const textItem = { type: 'text', data: { text: 'hello' } };
const r = (id: string) => ({ id });

describe('Scheduler', () => {
  let db: Db;
  let jobs: JobStore;
  let blacklist: BlacklistStore;
  let evo: FakeEvo;
  let scheduler: Scheduler;

  beforeEach(() => {
    db = openDb(':memory:');
    jobs = new JobStore(db);
    blacklist = new BlacklistStore(db);
    evo = new FakeEvo();
    scheduler = new Scheduler(
      jobs,
      new Sender(evo, blacklist),
      { pollMs: 60_000, delayMinMs: 0, delayMaxMs: 0, maxOverdueMin: 0, sendMaxAttempts: 3 },
      () => {},
    );
  });
  afterEach(() => db.close());

  it('fires a due job and records every send in the ledger', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [r('972521111111'), r('972522222222')],
      items: [textItem],
    });
    await scheduler.tick();

    expect(evo.sentTo().sort()).toEqual(['972521111111', '972522222222']);
    const job = jobs.byId('j1')!;
    expect(job.status).toBe('done');
    expect(job.result).toBe('2/2 sent');
    expect(jobs.allSends('j1').every((s) => s.status === 'sent')).toBe(true);
  });

  it('skips blacklisted recipients without sending', async () => {
    blacklist.addMany([{ phone_number: '972521111111' }]);
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [r('972521111111'), r('972522222222')],
      items: [textItem],
    });
    await scheduler.tick();

    expect(evo.sentTo()).toEqual(['972522222222']);
    const job = jobs.byId('j1')!;
    expect(job.status).toBe('done');
    expect(job.result).toContain('1 skipped (blacklisted)');
  });

  it('never blacklist-blocks group recipients', async () => {
    blacklist.addMany([{ phone_number: '972521111111' }]);
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [{ id: '123-456@g.us', isGroup: true }],
      items: [textItem],
    });
    await scheduler.tick();
    expect(evo.sentTo()).toEqual(['123-456@g.us']);
  });

  it('retries transient failures within the run', async () => {
    evo.failuresLeft.set('972521111111', 2); // fails twice, then succeeds
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: [r('972521111111')], items: [textItem] });
    await scheduler.tick();

    expect(evo.calls).toHaveLength(3);
    expect(jobs.byId('j1')!.status).toBe('done');
    expect(jobs.allSends('j1')[0]).toMatchObject({ status: 'sent', attempts: 3 });
  });

  it('marks a job failed when every send exhausts its attempts', async () => {
    evo.failuresLeft.set('972521111111', 99);
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: [r('972521111111')], items: [textItem] });
    await scheduler.tick();

    const job = jobs.byId('j1')!;
    expect(job.status).toBe('failed');
    expect(job.result).toContain('0/1 sent');
    expect(job.result).toContain('simulated failure');
    expect(jobs.allSends('j1')[0]).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('resumes an interrupted job WITHOUT resending already-sent recipients', async () => {
    // Simulate: job started, first recipient was sent, then the process died.
    const job = jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [r('972521111111'), r('972522222222'), r('972523333333')],
      items: [textItem],
    });
    jobs.ensureLedger(job);
    const [first] = jobs.pendingSends('j1');
    jobs.markSendDone(first!, 'sent');
    jobs.setStatus('j1', 'running');

    // Boot-time recovery + next tick.
    expect(jobs.recoverInterrupted()).toBe(1);
    await scheduler.tick();

    // The crashed-but-sent recipient must NOT receive the message again.
    expect(evo.sentTo().sort()).toEqual(['972522222222', '972523333333']);
    expect(jobs.byId('j1')!.status).toBe('done');
    expect(jobs.byId('j1')!.result).toBe('3/3 sent');
  });

  it('honors a cancel that lands before the job is claimed', async () => {
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: [r('972521111111')], items: [textItem] });
    jobs.setStatus('j1', 'cancelled');
    await scheduler.tick();
    expect(evo.calls).toHaveLength(0);
    expect(jobs.byId('j1')!.status).toBe('cancelled');
  });

  it('marks heavily overdue jobs as missed when MAX_OVERDUE_MIN is set', async () => {
    const strictScheduler = new Scheduler(
      jobs,
      new Sender(evo, blacklist),
      { pollMs: 60_000, delayMinMs: 0, delayMaxMs: 0, maxOverdueMin: 5, sendMaxAttempts: 3 },
      () => {},
    );
    const wayPast = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    jobs.upsert({ id: 'j1', scheduledAt: wayPast, recipients: [r('972521111111')], items: [textItem] });
    await strictScheduler.tick();
    expect(evo.calls).toHaveLength(0);
    expect(jobs.byId('j1')!.status).toBe('missed');
  });

  it('stops mid-run when the job is cancelled, leaving unsent rows pending', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [r('972521111111'), r('972522222222'), r('972523333333')],
      items: [textItem],
    });
    // cancel lands right after the first send goes out
    const origCall = evo.call.bind(evo);
    evo.call = async (...args) => {
      const res = await origCall(...args);
      jobs.setStatus('j1', 'cancelled');
      return res;
    };
    await scheduler.tick();

    expect(evo.calls).toHaveLength(1);
    const job = jobs.byId('j1')!;
    expect(job.status).toBe('cancelled');
    expect(job.result).toContain('1/3 sent');
    expect(job.result).toContain('2 not sent (cancelled)');
    // unsent rows stay pending — a re-queued job resumes instead of resending
    expect(jobs.allSends('j1').filter((s) => s.status === 'pending')).toHaveLength(2);
  });

  it('finalizes the job as failed when the run crashes unexpectedly', async () => {
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: [r('972521111111')], items: [textItem] });
    const spy = vi.spyOn(jobs, 'ensureLedger').mockImplementation(() => {
      throw new Error('disk full');
    });
    await scheduler.tick();
    spy.mockRestore();

    const job = jobs.byId('j1')!;
    expect(job.status).toBe('failed'); // not stuck 'running' until restart
    expect(job.result).toContain('disk full');
  });

  it('shutdown mid-run leaves the job resumable without resending', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [r('972521111111'), r('972522222222'), r('972523333333')],
      items: [textItem],
    });
    // shutdown begins right after the first send goes out on the wire
    const origCall = evo.call.bind(evo);
    evo.call = async (...args) => {
      const res = await origCall(...args);
      void scheduler.stop();
      return res;
    };
    await scheduler.tick();

    // only one message went out, the job is NOT finalized — it stays
    // 'running' so boot recovery re-pends it with the ledger intact
    expect(evo.calls).toHaveLength(1);
    expect(jobs.byId('j1')!.status).toBe('running');
    expect(jobs.allSends('j1').filter((s) => s.status === 'sent')).toHaveLength(1);

    // next boot (fresh scheduler): recovery + tick resumes the remaining two
    evo.call = origCall;
    expect(jobs.recoverInterrupted()).toBe(1);
    const rebooted = new Scheduler(
      jobs,
      new Sender(evo, blacklist),
      { pollMs: 60_000, delayMinMs: 0, delayMaxMs: 0, maxOverdueMin: 0, sendMaxAttempts: 3 },
      () => {},
    );
    await rebooted.tick();
    expect(evo.sentTo().sort()).toEqual(['972521111111', '972522222222', '972523333333']);
    expect(jobs.byId('j1')!.status).toBe('done');
  });

  it('does not mark a crash-recovered started job as missed', async () => {
    const strictScheduler = new Scheduler(
      jobs,
      new Sender(evo, blacklist),
      { pollMs: 60_000, delayMinMs: 0, delayMaxMs: 0, maxOverdueMin: 5, sendMaxAttempts: 3 },
      () => {},
    );
    const wayPast = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const job = jobs.upsert({
      id: 'j1',
      scheduledAt: wayPast,
      recipients: [r('972521111111'), r('972522222222')],
      items: [textItem],
    });
    // job started (claim sets started_at), one recipient sent, then a crash
    expect(jobs.claim('j1')).toBe(true);
    jobs.ensureLedger(job);
    jobs.markSendDone(jobs.pendingSends('j1')[0]!, 'sent');
    expect(jobs.recoverInterrupted()).toBe(1);

    await strictScheduler.tick();

    // heavily overdue, but it already started — resume, don't abandon
    expect(jobs.byId('j1')!.status).toBe('done');
    expect(evo.sentTo()).toEqual(['972522222222']);
  });

  it('a ledger-write failure after a successful send never causes a resend', async () => {
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: [r('972521111111')], items: [textItem] });
    const spy = vi.spyOn(jobs, 'markSendDone').mockImplementation(() => {
      throw new Error('disk full');
    });
    await scheduler.tick();
    spy.mockRestore();

    // the message went out exactly once — the failed ledger write must not
    // be recorded as a retryable attempt (that would resend on pass 2)
    expect(evo.calls).toHaveLength(1);
    expect(jobs.byId('j1')!.status).toBe('failed');
    expect(jobs.byId('j1')!.result).toContain('disk full');
  });

  it('finalize never overwrites a cancel that landed after the last send', async () => {
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: [r('972521111111')], items: [textItem] });
    // cancel lands in the gap between the last send and finalize — runJob's
    // first allSends call is the progress seeding, the second is finalize
    const origAllSends = jobs.allSends.bind(jobs);
    let allSendsCalls = 0;
    const spy = vi.spyOn(jobs, 'allSends').mockImplementation((id) => {
      if (++allSendsCalls > 1) jobs.setStatus('j1', 'cancelled');
      return origAllSends(id);
    });
    await scheduler.tick();
    spy.mockRestore();

    expect(evo.calls).toHaveLength(1);
    expect(jobs.byId('j1')!.status).toBe('cancelled');
  });

  it('claim refuses a job that was rescheduled into the future', async () => {
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: [r('972521111111')], items: [textItem] });
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    jobs.upsert({ id: 'j1', scheduledAt: future, recipients: [r('972521111111')], items: [textItem] });
    expect(jobs.claim('j1')).toBe(false);
    expect(jobs.byId('j1')!.status).toBe('pending');
  });

  it('runs the fresh job state when an edit lands after the due snapshot', async () => {
    // two due jobs; while j1 sends, j2 gets edited — j2 must fire the new text
    jobs.upsert({
      id: 'j1',
      scheduledAt: new Date(Date.now() - 120_000).toISOString(),
      recipients: [r('972521111111')],
      items: [textItem],
    });
    jobs.upsert({ id: 'j2', scheduledAt: PAST, recipients: [r('972522222222')], items: [textItem] });
    const origCall = evo.call.bind(evo);
    evo.call = async (...args) => {
      const res = await origCall(...args);
      jobs.upsert({
        id: 'j2',
        scheduledAt: PAST,
        recipients: [r('972522222222')],
        items: [{ type: 'text', data: { text: 'edited' } }],
      });
      evo.call = origCall; // only intercept the first send
      return res;
    };
    await scheduler.tick();

    expect(evo.calls).toHaveLength(2);
    expect(evo.calls[1]!.body.text).toBe('edited');
  });

  it('broadcasts a status item once, not once per recipient', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [r('972521111111'), r('972522222222')],
      items: [textItem, { type: 'status', data: { content: 'story!' } }],
    });
    await scheduler.tick();

    // text → each recipient; status → exactly one broadcast
    const statusCalls = evo.calls.filter((c) => c.endpoint.startsWith('/message/sendStatus/'));
    expect(statusCalls).toHaveLength(1);
    expect(evo.calls).toHaveLength(3);
    expect(jobs.byId('j1')!.status).toBe('done');
    expect(jobs.byId('j1')!.result).toBe('3/3 sent');
  });

  it('sends every item to every recipient (multi-item jobs)', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [r('972521111111')],
      items: [textItem, { type: 'text', data: { text: 'second' } }],
    });
    await scheduler.tick();
    expect(evo.calls).toHaveLength(2);
    expect(evo.calls.map((c) => c.body.text).sort()).toEqual(['hello', 'second']);
  });
});
