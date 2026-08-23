import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { BlacklistStore } from '../src/services/blacklist.js';
import { JobStore } from '../src/services/jobs.js';
import { Scheduler } from '../src/services/scheduler.js';
import { Sender } from '../src/services/sender.js';
import { inQuietHours } from '../src/services/time.js';
import {
  isNotOnWhatsAppError,
  nextBatchPauseMs,
  nextChunkSize,
  verifyKey,
  VerificationService,
  VerificationStore,
} from '../src/services/verification.js';
import { FakeEvo, makeApp, testConfig, type TestApp } from './helpers.js';

const PAST = new Date(Date.now() - 60_000).toISOString();
const textItem = { type: 'text', data: { text: 'hello' } };
const r = (id: string) => ({ id });

/** The exact body Evolution returns when a number is not registered. */
const notOnWhatsApp = (number: string) =>
  JSON.stringify({
    status: 400,
    error: 'Bad Request',
    response: { message: [{ jid: `${number}@s.whatsapp.net`, exists: false, number }] },
  });

describe('verifyKey', () => {
  it('collapses every spelling of one subscriber onto a single cache key', () => {
    expect(verifyKey('0529876543')).toBe('972529876543');
    expect(verifyKey('972529876543')).toBe('972529876543');
    expect(verifyKey('+972 52-987-6543')).toBe('972529876543');
    expect(verifyKey('972529876543@s.whatsapp.net')).toBe('972529876543');
  });

  it('never verifies a group, and keeps digits our regex rejects', () => {
    expect(verifyKey('12036304@g.us')).toBeNull();
    expect(verifyKey('')).toBeNull();
    // phone.ts refuses to normalize this, but WhatsApp is the authority on
    // whether it is real — so it still gets a key and still gets asked about
    expect(verifyKey('12482308399')).toBe('12482308399');
  });
});

describe('isNotOnWhatsAppError', () => {
  it('recognizes the real rejection body', () => {
    expect(isNotOnWhatsAppError(notOnWhatsApp('12482308399'))).toBe(true);
  });

  it('leaves every other failure on the retry path', () => {
    expect(isNotOnWhatsAppError('simulated failure')).toBe(false);
    expect(isNotOnWhatsAppError(JSON.stringify({ status: 500, error: 'boom' }))).toBe(false);
    // a message array of plain strings is a validation error, not a dead number
    expect(
      isNotOnWhatsAppError(JSON.stringify({ response: { message: ['number is required'] } })),
    ).toBe(false);
    // a mixed batch is not proof THIS recipient is dead
    expect(
      isNotOnWhatsAppError(
        JSON.stringify({ response: { message: [{ exists: false }, { exists: true }] } }),
      ),
    ).toBe(false);
  });
});

describe('VerificationStore TTLs', () => {
  let db: Db;
  let store: VerificationStore;
  beforeEach(() => {
    db = openDb(':memory:');
    store = new VerificationStore(db);
  });
  afterEach(() => db.close());

  it('expires a verdict once its TTL runs out', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    store.put('972521111111', 'invalid', 90, {}, t0);

    const day89 = new Date(t0.getTime() + 89 * 86_400_000);
    expect(store.fresh('972521111111', day89)?.status).toBe('invalid');

    const day91 = new Date(t0.getTime() + 91 * 86_400_000);
    expect(store.fresh('972521111111', day91)).toBeUndefined();
  });

  it('lets a good verdict outlive a bad one, and counts only live rows', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    store.put('972521111111', 'valid', 180, {}, t0);
    store.put('972522222222', 'invalid', 90, {}, t0);

    const day120 = new Date(t0.getTime() + 120 * 86_400_000);
    expect(store.fresh('972521111111', day120)?.status).toBe('valid');
    expect(store.fresh('972522222222', day120)).toBeUndefined();
    expect(store.counts(day120)).toEqual({ valid: 1, invalid: 0 });
  });

  it('reads back under any spelling of the number', () => {
    store.put('972529876543', 'invalid', 90);
    expect(store.fresh('0529876543')?.status).toBe('invalid');
    expect(store.fresh('+972-52-987-6543')?.status).toBe('invalid');
  });
});

describe('sweep pacing', () => {
  const draws = (n: number, f: () => number) => Array.from({ length: n }, f);

  it('jitters the gap around the configured pause, or takes a long break', () => {
    const base = 60_000;
    const gaps = draws(400, () => nextBatchPauseMs(base));
    const normal = gaps.filter((g) => g < base * 2);
    const long = gaps.filter((g) => g >= base * 2);

    expect(Math.min(...normal)).toBeGreaterThanOrEqual(base * 0.65);
    expect(Math.max(...normal)).toBeLessThanOrEqual(base * 1.35);
    // roughly one in eight — loose bounds, this is a coin flip not a schedule
    expect(long.length).toBeGreaterThan(10);
    expect(long.length).toBeLessThan(150);
    // and the gaps are actually spread out, not the same number 400 times
    expect(new Set(normal).size).toBeGreaterThan(100);
  });

  it('never sleeps when the operator set no pause at all', () => {
    expect(draws(50, () => nextBatchPauseMs(0)).every((g) => g === 0)).toBe(true);
  });

  it('varies the chunk size around the configured one, never below 1', () => {
    const sizes = draws(400, () => nextChunkSize(10));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(7);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(13);
    expect(draws(50, () => nextChunkSize(1)).every((s) => s >= 1)).toBe(true);
  });
});

describe('VerificationService sweep', () => {
  let db: Db;
  let evo: FakeEvo;
  let cfg: Config;
  let svc: VerificationService;

  beforeEach(() => {
    db = openDb(':memory:');
    evo = new FakeEvo();
    cfg = testConfig({ verifyBatchSize: 10, verifyBatchPauseMs: 0, verifyBreakerRun: 5 });
    svc = new VerificationService(evo, new VerificationStore(db), cfg);
  });
  afterEach(() => db.close());

  it('caches both verdicts and never re-asks about a fresh one', async () => {
    evo.notOnWhatsApp.add('972522222222');
    const first = await svc.ensure(['972521111111', '972522222222']);
    expect(first).toMatchObject({ requested: 2, checked: 2, valid: 1, invalid: 1, cached: 0 });

    const lookups = () => evo.calls.filter((c) => c.endpoint.startsWith('/chat/whatsappNumbers')).length;
    expect(lookups()).toBe(1);

    const second = await svc.ensure(['972521111111', '972522222222']);
    expect(second).toMatchObject({ requested: 2, cached: 2, checked: 0 });
    expect(lookups()).toBe(1); // no second round-trip
  });

  it('dedupes spellings of the same number into one lookup', async () => {
    await svc.ensure(['0529876543', '972529876543', '+972 52 987 6543']);
    const call = evo.calls.find((c) => c.endpoint.startsWith('/chat/whatsappNumbers'));
    expect(call?.body.numbers).toEqual(['972529876543']);
  });

  it('trusts dead numbers that are scattered among live ones', async () => {
    // 8 dead in a list of 12, but never more than 2 in a row — the shape of a
    // genuinely stale list, well past the breaker's threshold of 5 in total
    const numbers = Array.from({ length: 12 }, (_, i) => `9725200000${String(i).padStart(2, '0')}`);
    numbers.forEach((n, i) => {
      if (i % 3 !== 0) evo.notOnWhatsApp.add(n);
    });
    const res = await svc.ensure(numbers);
    expect(res.tripped).toBe(false);
    expect(res.invalid).toBe(8);
    expect(res.valid).toBe(4);
    expect(res.discarded).toBe(0);
  });

  it('trips on a consecutive run and caches NOTHING from it', async () => {
    const numbers = Array.from({ length: 12 }, (_, i) => `9725210000${String(i).padStart(2, '0')}`);
    numbers.forEach((n) => evo.notOnWhatsApp.add(n)); // every one "dead" — throttle shape
    const res = await svc.ensure(numbers);

    expect(res.tripped).toBe(true);
    expect(res.discarded).toBe(5); // the breaker threshold
    expect(res.invalid).toBe(0); // nothing written
    const store = new VerificationStore(db);
    expect(store.counts()).toEqual({ valid: 0, invalid: 0 });
  });

  it('keeps the trustworthy prefix when the breaker trips later on', async () => {
    // one live number, then a long dead run: the live one flushes the invalids
    // before it, so those are kept and only the suspect tail is discarded
    const numbers = ['972521111111', '972522222222', ...Array.from({ length: 6 }, (_, i) => `97252300000${i}`)];
    numbers.slice(1).forEach((n) => evo.notOnWhatsApp.add(n));
    const res = await svc.ensure(numbers);

    expect(res.valid).toBe(1);
    expect(res.tripped).toBe(true);
    expect(res.discarded).toBe(5);
    // the single dead number that sat before the live one was never flushed,
    // because no live number followed it — it is in the discarded run
    expect(new VerificationStore(db).counts().valid).toBe(1);
  });

  it('does not ask WhatsApp anything during quiet hours', async () => {
    // a window that is open right now, built the way the scheduler tests do
    const now = new Date();
    const fmt = (d: Date) =>
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const quiet = testConfig({
      verifyBatchSize: 10,
      verifyBatchPauseMs: 0,
      quietEnabled: true,
      quietStart: fmt(new Date(now.getTime() - 3_600_000)),
      quietEnd: fmt(new Date(now.getTime() + 3_600_000)),
    });
    const svc2 = new VerificationService(evo, new VerificationStore(db), quiet);
    const res = await svc2.ensure(['972521111111', '972522222222']);

    expect(res.checked).toBe(0);
    expect(res.aborted).toContain('quiet hours');
    expect(evo.calls.filter((c) => c.endpoint.startsWith('/chat/whatsappNumbers'))).toHaveLength(0);
    // nothing cached either — an unasked number is unknown, not dead
    expect(new VerificationStore(db).counts()).toEqual({ valid: 0, invalid: 0 });
  });

  it('sweeps normally once the quiet window has passed', async () => {
    const past = testConfig({
      verifyBatchPauseMs: 0,
      quietEnabled: true,
      quietStart: '03:00',
      quietEnd: '03:01',
    });
    const svc2 = new VerificationService(evo, new VerificationStore(db), past);
    const res = await svc2.ensure(['972521111111']);
    // unless the suite genuinely runs at 03:00, the window is shut
    if (!inQuietHours(new Date(), '03:00', '03:01')) expect(res.checked).toBe(1);
  });

  it('treats a lookup outage as unknown, not as dead', async () => {
    const broken = new FakeEvo();
    broken.call = async () => ({ status: 502, ok: false, text: 'upstream down', contentType: null });
    const svc2 = new VerificationService(broken, new VerificationStore(db), cfg);
    const res = await svc2.ensure(['972521111111', '972522222222']);

    expect(res.aborted).toContain('502');
    expect(res.invalid).toBe(0);
    expect(new VerificationStore(db).counts()).toEqual({ valid: 0, invalid: 0 });
  });
});

describe('campaign sending with verification', () => {
  let db: Db;
  let jobs: JobStore;
  let evo: FakeEvo;
  let cfg: Config;
  let store: VerificationStore;
  let scheduler: Scheduler;
  let verification: VerificationService;

  function build(overrides: Partial<Config> = {}) {
    cfg = testConfig({ verifyBatchPauseMs: 0, verifyBreakerRun: 5, ...overrides });
    store = new VerificationStore(db);
    verification = new VerificationService(evo, store, cfg);
    scheduler = new Scheduler(
      jobs,
      new Sender(evo, new BlacklistStore(db), verification),
      { ...cfg, pollMs: 60_000, delayMinMs: 0, delayMaxMs: 0 },
      () => {},
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      verification,
    );
  }

  beforeEach(() => {
    db = openDb(':memory:');
    jobs = new JobStore(db);
    evo = new FakeEvo();
    build();
  });
  afterEach(() => db.close());

  it('never sends to a number the cache already knows is dead', async () => {
    // the sweep runs in the BACKGROUND now, so the gate's guarantee is about
    // what is already known — a first campaign learns the hard way (one 400,
    // settled in one attempt) and every later one skips before the wire
    store.put('972522222222', 'invalid', 90);
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [r('972521111111'), r('972522222222')],
      items: [textItem],
    });
    await scheduler.tick();

    expect(evo.sentTo()).toEqual(['972521111111']);
    const dead = jobs.allSends('j1').find((s) => s.recipient === '972522222222')!;
    expect(dead.status).toBe('skipped');
    expect(dead.lastError).toContain('not on WhatsApp');
    // THE POINT: a permanent rejection costs one attempt, not sendMaxAttempts
    expect(dead.attempts).toBe(1);
  });

  it('does not make the campaign wait for the sweep, but still learns the list', async () => {
    evo.notOnWhatsApp.add('972522222222');
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [r('972521111111'), r('972522222222')],
      items: [textItem],
    });
    await scheduler.tick();
    // the campaign is already finished; the sweep may still be running
    expect(jobs.byId('j1')!.status).toBe('done');

    await verification.whenIdle();
    expect(store.fresh('972521111111')?.status).toBe('valid');
    expect(store.fresh('972522222222')?.status).toBe('invalid');
  });

  it('settles a send-time rejection instead of retrying it three times', async () => {
    // no pre-verification, so the 400 arrives at send time — the belt-and-braces
    // path for a number that slipped past the sweep
    build({ verifyEnabled: false });
    evo.call = async (endpoint: string, body?: unknown) => {
      evo.calls.push({ endpoint, body, method: 'POST' });
      return { status: 400, ok: false, text: notOnWhatsApp('12482308399'), contentType: null };
    };
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: [r('12482308399')], items: [textItem] });
    await scheduler.tick();

    const send = jobs.allSends('j1')[0]!;
    expect(send.status).toBe('skipped');
    expect(send.attempts).toBe(1);
    // and it was only ever put on the wire once
    expect(evo.calls.filter((c) => c.endpoint.startsWith('/message/send')).length).toBe(1);
    // …and remembered, so the next campaign skips it before sending
    expect(store.fresh('12482308399')?.status).toBe('invalid');
  });

  it('still retries a genuine transient failure', async () => {
    evo.failuresLeft.set('972521111111', 2);
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: [r('972521111111')], items: [textItem] });
    await scheduler.tick();

    const send = jobs.allSends('j1')[0]!;
    expect(send.status).toBe('sent');
    expect(send.attempts).toBe(3); // failed twice, then through
    expect(store.fresh('972521111111')?.status).toBe('valid'); // never marked dead
  });

  it('verifies a campaign of any size — the route cap does not apply here', async () => {
    // 250 recipients is past the ad-hoc endpoint's limit of 200; the scheduler
    // sweeps directly, so every one of them still gets checked
    const numbers = Array.from({ length: 250 }, (_, i) => `97253${String(i).padStart(7, '0')}`);
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: numbers.map(r), items: [textItem] });
    await scheduler.tick();
    await verification.whenIdle();

    expect(store.counts().valid).toBe(250);
    expect(evo.sentTo()).toHaveLength(250);
    // and it went out in batches, not one giant lookup. The batch size varies
    // around the configured one on purpose, so the count is a band, not a number.
    const lookups = evo.calls.filter((c) => c.endpoint.startsWith('/chat/whatsappNumbers'));
    expect(lookups.length).toBeGreaterThanOrEqual(Math.ceil(250 / (cfg.verifyBatchSize * 1.3)));
    expect(lookups.length).toBeLessThanOrEqual(Math.ceil(250 / (cfg.verifyBatchSize * 0.7)));
  });

  it('stops the sweep on a breaker trip without stopping the campaign', async () => {
    const numbers = Array.from({ length: 8 }, (_, i) => `9725210000${String(i).padStart(2, '0')}`);
    numbers.forEach((n) => evo.notOnWhatsApp.add(n));
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: numbers.map(r), items: [textItem] });
    await scheduler.tick();
    await verification.whenIdle();

    // the breaker is about what we may BELIEVE, not about whether we may send:
    // a run of consecutive "not on WhatsApp" answers is the shape of
    // rate-limiting, so nothing from it is cached...
    expect(store.counts()).toEqual({ valid: 0, invalid: 0 });
    // ...but the campaign is no longer held hostage to a lookup verdict it was
    // right not to trust. It runs exactly as it would have with no verification
    // at all, and each send stands or falls on its own answer from Evolution.
    expect(jobs.byId('j1')!.status).toBe('done');
    expect(evo.sentTo()).toHaveLength(8);
  });

  it('spends no more than the daily lookup budget', async () => {
    build({ verifyDailyCap: 12 });
    const numbers = Array.from({ length: 40 }, (_, i) => `97254${String(i).padStart(7, '0')}`);
    const res = await verification.ensure(numbers);

    expect(res.checked).toBe(12);
    expect(res.aborted).toContain('daily lookup cap');
    // a second sweep the same day gets nothing more
    const again = await verification.ensure(numbers);
    expect(again.checked).toBe(0);
    expect(again.aborted).toContain('already spent');
  });

  it('never verifies or gates a group recipient', async () => {
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [{ id: '12036304@g.us', isGroup: true }],
      items: [textItem],
    });
    await scheduler.tick();

    expect(evo.sentTo()).toEqual(['12036304@g.us']);
    const lookup = evo.calls.find((c) => c.endpoint.startsWith('/chat/whatsappNumbers'));
    expect(lookup).toBeUndefined();
  });

  it('sends unverified rather than blocking when the lookup is down', async () => {
    const realCall = evo.call.bind(evo);
    evo.call = async (endpoint: string, body?: unknown, method = 'POST') => {
      if (endpoint.startsWith('/chat/whatsappNumbers'))
        return { status: 502, ok: false, text: 'upstream down', contentType: null };
      return realCall(endpoint, body, method);
    };
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: [r('972521111111')], items: [textItem] });
    await scheduler.tick();

    expect(evo.sentTo()).toEqual(['972521111111']);
    expect(jobs.byId('j1')!.status).toBe('done');
  });
});

describe('/api/verification', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp({ verifyBatchPauseMs: 0 });
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('checks numbers on demand and lists the verdicts', async () => {
    t.evo.notOnWhatsApp.add('972522222222');
    const check = await t.app.inject({
      method: 'POST',
      url: '/api/verification/check',
      payload: { numbers: ['972521111111', '972522222222'] },
    });
    expect(check.json()).toMatchObject({ ok: true, valid: 1, invalid: 1 });

    const list = await t.app.inject({ method: 'GET', url: '/api/verification?status=invalid' });
    expect(list.json().total).toBe(1);
    expect(list.json().rows[0]).toMatchObject({ phone_number: '972522222222', status: 'invalid' });
    expect(list.json().counts).toEqual({ valid: 1, invalid: 1 });
  });

  it('forgets one verdict, and clears just the invalid ones', async () => {
    t.evo.notOnWhatsApp.add('972522222222');
    await t.app.inject({
      method: 'POST',
      url: '/api/verification/check',
      payload: { numbers: ['972521111111', '972522222222'] },
    });

    const del = await t.app.inject({ method: 'DELETE', url: '/api/verification/972521111111' });
    expect(del.json()).toMatchObject({ removed: 1 });

    const cleared = await t.app.inject({
      method: 'POST',
      url: '/api/verification/clear',
      payload: { status: 'invalid' },
    });
    expect(cleared.json()).toMatchObject({ cleared: 1 });
    const list = await t.app.inject({ method: 'GET', url: '/api/verification' });
    expect(list.json().total).toBe(0);
  });

  it('refuses an oversized ad-hoc check, and says where the limit does not apply', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/verification/check',
      payload: { numbers: Array.from({ length: 201 }, (_, i) => `97252${String(i).padStart(7, '0')}`) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toContain('campaign');
    expect(t.evo.calls.filter((c) => c.endpoint.startsWith('/chat/whatsappNumbers'))).toHaveLength(0);
  });

  it('rejects an empty check', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/verification/check',
      payload: { numbers: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('1:1 chat is never gated by the cache', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp({ verifyBatchPauseMs: 0 });
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('replies to a number the cache calls dead', async () => {
    // whatever the cache believes, a person messaging us must be answerable —
    // a stale verdict or a throttled sweep cannot lock us out of a conversation
    new VerificationStore(t.db).put('972522222222', 'invalid', 90);

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/send',
      payload: { recipient: '972522222222', item: textItem },
    });
    expect(res.json()).toMatchObject({ ok: true, routed: 'evo', skipped: false });
    expect(t.evo.sentTo()).toEqual(['972522222222']);
  });

  it('still refuses a blacklisted number on the chat path', async () => {
    t.blacklist.addMany([{ phone_number: '972522222222' }]);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/send',
      payload: { recipient: '972522222222', item: textItem },
    });
    expect(res.json()).toMatchObject({ skipped: true });
    expect(t.evo.sentTo()).toEqual([]);
  });
});
