import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BlacklistStore } from '../src/services/blacklist.js';
import {
  attachContactFamiliarity,
  ContactFamiliarityStore,
  seedFamiliarityFromChats,
} from '../src/services/familiarity.js';
import { JobStore } from '../src/services/jobs.js';
import { ColdSendQuota } from '../src/services/quota.js';
import { EventRelay } from '../src/services/events.js';
import { Scheduler, type SendGuards } from '../src/services/scheduler.js';
import { Sender } from '../src/services/sender.js';
import { FakeEvo, makeApp, type TestApp } from './helpers.js';

const PAST = new Date(Date.now() - 60_000).toISOString();
const textItem = { type: 'text', data: { text: 'hello' } };
const voiceItem = { type: 'text', data: { text: 'second' } };
const r = (id: string) => ({ id });
const INST = 'Test';

const nums = (n: number, prefix = '97252') =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(7, '0')}`);

describe('contact familiarity', () => {
  let db: Db;
  let store: ContactFamiliarityStore;

  beforeEach(() => {
    db = openDb(':memory:');
    store = new ContactFamiliarityStore(db);
  });
  afterEach(() => db.close());

  it('treats an unseen number as cold and a group as neither', () => {
    expect(store.classify('972521111111', INST)).toBe('cold');
    expect(store.classify('12036304@g.us', INST)).toBe('group');
  });

  it('an inbound message makes someone known; our own message does not', () => {
    store.record(INST, '972521111111@s.whatsapp.net', true); // we messaged them
    expect(store.classify('972521111111', INST)).toBe('cold');

    store.record(INST, '972521111111@s.whatsapp.net', false); // they replied
    expect(store.classify('972521111111', INST)).toBe('known');
  });

  it('is scoped per line — a contact one number knows is a stranger to another', () => {
    store.record(INST, '972521111111', false);
    expect(store.classify('972521111111', INST)).toBe('known');
    expect(store.classify('972521111111', 'OtherLine')).toBe('cold');
  });

  it('collapses every spelling of one subscriber onto the same verdict', () => {
    store.record(INST, '0521111111', false);
    expect(store.classify('972521111111@s.whatsapp.net', INST)).toBe('known');
    expect(store.classify('+972 52-111-1111', INST)).toBe('known');
  });

  it('splits a recipient list into known / cold / groups', () => {
    store.record(INST, '972521111111', false);
    const split = store.split(
      ['972521111111', '972522222222', '972523333333', '12036304@g.us'],
      INST,
    );
    expect(split.known).toEqual(['972521111111']);
    expect(split.cold).toEqual(['972522222222', '972523333333']);
    expect(split.groups).toEqual(['12036304@g.us']);
  });

  it('seeds existing threads from the chat list, once', async () => {
    const evo = new FakeEvo();
    evo.call = async (endpoint: string) => {
      if (endpoint.startsWith('/chat/findChats'))
        return {
          status: 200,
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify([
            { id: '972521111111@s.whatsapp.net' },
            { id: '8891@lid', remoteJidAlt: '972522222222@s.whatsapp.net' },
            { id: '12036304@g.us' }, // groups carry no subscriber key
          ]),
        };
      throw new Error(`unexpected ${endpoint}`);
    };
    expect(await seedFamiliarityFromChats(evo, store, INST)).toBe(2);
    expect(store.classify('972521111111', INST)).toBe('known');
    expect(store.classify('972522222222', INST)).toBe('known');
    // a second boot must not re-fetch — the line is already seeded
    expect(await seedFamiliarityFromChats(evo, store, INST)).toBe(0);
  });

  it('learns from live inbound traffic over the relay', () => {
    const relay = new EventRelay({ base: '', instance: INST, apikey: '', enabled: false });
    attachContactFamiliarity(relay, store, () => INST);
    relay.broadcast({
      event: 'messages.upsert',
      data: {
        instance: INST,
        data: [{ key: { remoteJid: '972529999999@s.whatsapp.net', fromMe: false } }],
      },
    });
    expect(store.classify('972529999999', INST)).toBe('known');
  });

  it('resolves the @lid every inbound message arrives under, and drops one it cannot', () => {
    const relay = new EventRelay({ base: '', instance: INST, apikey: '', enabled: false });
    const aliases: Record<string, string> = { '8891@lid': '972521111111@s.whatsapp.net' };
    attachContactFamiliarity(relay, store, () => INST, (j) => aliases[j] ?? j);
    relay.broadcast({
      event: 'messages.upsert',
      data: {
        instance: INST,
        data: [
          { key: { remoteJid: '8891@lid', fromMe: false } },
          { key: { remoteJid: '7777@lid', fromMe: false } }, // unknown alias
        ],
      },
    });
    expect(store.classify('972521111111', INST)).toBe('known');
    // the unresolved one invented nothing — 7777 is not a subscriber number
    expect(store.count(INST)).toBe(1);
  });
});

describe('cold-send quota', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  const quota = (over: Partial<{ coldDailyCap: number; coldWarmupStart: number; coldCapEnabled: boolean }> = {}) =>
    new ColdSendQuota(db, {
      coldCapEnabled: true,
      coldDailyCap: 50,
      coldWarmupStart: 10,
      ...over,
    });

  it('starts at the warm-up floor for a line with no history', () => {
    expect(quota().capFor(INST)).toBe(10);
  });

  it('doubles the ceiling per earlier day of cold sends, up to the cap', () => {
    const q = quota();
    const day = (n: number) => new Date(Date.now() - n * 86_400_000);
    q.record(INST, '972521111111', day(1));
    expect(q.capFor(INST)).toBe(20);
    q.record(INST, '972522222222', day(2));
    expect(q.capFor(INST)).toBe(40);
    q.record(INST, '972523333333', day(3));
    expect(q.capFor(INST)).toBe(50); // clamped by coldDailyCap
  });

  it('counts distinct people, not messages, in the trailing 24h', () => {
    const q = quota();
    q.record(INST, '972521111111');
    q.record(INST, '972521111111'); // same person, second item
    expect(q.spent(INST)).toBe(1);
    expect(q.remaining(INST)).toBe(9);
  });

  it('forgets yesterday — the window rolls', () => {
    const q = quota();
    q.record(INST, '972521111111', new Date(Date.now() - 25 * 3_600_000));
    expect(q.spent(INST)).toBe(0);
  });

  it('is unlimited when capping is switched off', () => {
    expect(quota({ coldCapEnabled: false }).remaining(INST)).toBe(Number.POSITIVE_INFINITY);
  });

  it('a quiet month resets the ramp instead of inheriting an unearned ceiling', () => {
    const q = quota();
    q.record(INST, '972521111111', new Date(Date.now() - 40 * 86_400_000));
    expect(q.capFor(INST)).toBe(10);
  });

  it('the ramp window is configurable — a shorter window forgets sooner', () => {
    const q = new ColdSendQuota(db, {
      coldCapEnabled: true,
      coldDailyCap: 50,
      coldWarmupStart: 10,
      coldRampWindowDays: 7,
    });
    // 10 days back is inside the default 30-day window but outside a 7-day one
    q.record(INST, '972521111111', new Date(Date.now() - 10 * 86_400_000));
    expect(q.capFor(INST)).toBe(10);
    expect(q.activeDays(INST)).toBe(0);
  });

  it('a per-compose override replaces the ramp with a flat ceiling', () => {
    const q = quota();
    const day = (n: number) => new Date(Date.now() - n * 86_400_000);
    // three active days would normally ramp the ceiling to 50 (clamped) —
    // the override ignores that entirely and uses its own flat number
    q.record(INST, '972521111111', day(1));
    q.record(INST, '972522222222', day(2));
    q.record(INST, '972523333333', day(3));
    expect(q.capFor(INST, new Date(), { dailyCap: 5 })).toBe(5);
    expect(q.remaining(INST, new Date(), { dailyCap: 5 })).toBe(5);
  });

  it('an override applies even while the site-wide cap toggle is off', () => {
    const q = quota({ coldCapEnabled: false });
    expect(q.remaining(INST, new Date(), { dailyCap: 5 })).toBe(5);
    expect(q.state(INST, new Date(), { dailyCap: 5 }).enabled).toBe(true);
  });

  it('an override\'s remaining still subtracts what is already spent today', () => {
    const q = quota();
    q.record(INST, '972521111111');
    expect(q.remaining(INST, new Date(), { dailyCap: 5 })).toBe(4);
  });
});

describe('campaign sending under the cold-contact cap', () => {
  let db: Db;
  let jobs: JobStore;
  let evo: FakeEvo;
  let familiarity: ContactFamiliarityStore;
  let coldQuota: ColdSendQuota;

  const build = (guards: SendGuards) =>
    new Scheduler(
      jobs,
      new Sender(evo, new BlacklistStore(db)),
      { pollMs: 60_000, delayMinMs: 0, delayMaxMs: 0, maxOverdueMin: 0, sendMaxAttempts: 3 },
      () => {},
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      guards,
    );

  beforeEach(() => {
    db = openDb(':memory:');
    jobs = new JobStore(db);
    evo = new FakeEvo();
    familiarity = new ContactFamiliarityStore(db);
    coldQuota = new ColdSendQuota(db, {
      coldCapEnabled: true,
      coldDailyCap: 3,
      coldWarmupStart: 3,
    });
  });
  afterEach(() => db.close());

  const guards = (): SendGuards => ({
    familiarity: { classify: (rec, inst) => familiarity.classify(rec, inst || INST) },
    quota: {
      remaining: (inst, override) => coldQuota.remaining(inst || INST, new Date(), override),
      record: (inst, rec) => coldQuota.record(inst || INST, rec),
    },
  });

  it('rations strangers and holds the rest for the next run', async () => {
    const scheduler = build(guards());
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: nums(5).map(r), items: [textItem] });
    await scheduler.tick();

    expect(evo.sentTo()).toHaveLength(3);
    const job = jobs.byId('j1')!;
    expect(job.status).toBe('pending'); // re-queued, not failed
    expect(job.result).toContain('cold-contact cap');
    expect(jobs.pendingSends('j1')).toHaveLength(2); // ledger intact
    // and the reason survives to the UI's polling path, whole — the result
    // line cannot be split back into it (the reason has its own em dash)
    expect(jobs.progress('j1')!.holdReason).toBe(
      'daily cold-contact cap reached — 2 first-time recipients held back',
    );
  });

  it('never rations people the line already talks to', async () => {
    for (const n of nums(5)) familiarity.record(INST, n, false);
    const scheduler = build(guards());
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: nums(5).map(r), items: [textItem] });
    await scheduler.tick();

    expect(evo.sentTo()).toHaveLength(5);
    expect(jobs.byId('j1')!.status).toBe('done');
    expect(coldQuota.spent(INST)).toBe(0); // nothing was charged
  });

  it('never rations groups', async () => {
    const scheduler = build(guards());
    const groups = ['1@g.us', '2@g.us', '3@g.us', '4@g.us', '5@g.us'];
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: groups.map((id) => ({ id, isGroup: true })),
      items: [textItem],
    });
    await scheduler.tick();

    expect(evo.sentTo()).toHaveLength(5);
    expect(jobs.byId('j1')!.status).toBe('done');
  });

  it('sends every warm recipient even when the cold budget is already spent', async () => {
    // budget of 3, but the warm ones must not be held up behind it
    for (const n of nums(2, '97253')) familiarity.record(INST, n, false);
    const scheduler = build(guards());
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: [...nums(5), ...nums(2, '97253')].map(r),
      items: [textItem],
    });
    await scheduler.tick();

    // 3 cold (the ration) + both warm
    expect(evo.sentTo()).toHaveLength(5);
    expect(evo.sentTo()).toEqual(expect.arrayContaining(nums(2, '97253')));
    expect(jobs.pendingSends('j1')).toHaveLength(2); // the two rationed strangers
  });

  it('keeps a multi-item sequence whole rather than splitting it across the cap', async () => {
    const scheduler = build(guards());
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: nums(5).map(r),
      items: [textItem, voiceItem],
    });
    await scheduler.tick();

    // 3 strangers × both items — nobody gets half a conversation overnight
    expect(evo.sentTo()).toHaveLength(6);
    const sent = jobs.allSends('j1').filter((s) => s.status === 'sent');
    const byRecipient = new Map<string, number>();
    for (const s of sent) byRecipient.set(s.recipient, (byRecipient.get(s.recipient) ?? 0) + 1);
    expect([...byRecipient.values()]).toEqual([2, 2, 2]);
  });

  it('charges the budget only for strangers actually reached', async () => {
    evo.failuresLeft.set('972520000000', 99); // never gets through
    const scheduler = build(guards());
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: nums(2).map(r), items: [textItem] });
    await scheduler.tick();

    expect(coldQuota.spent(INST)).toBe(1); // only the one that landed
  });

  it('resumes the next day and finishes what was held back', async () => {
    const scheduler = build(guards());
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: nums(5).map(r), items: [textItem] });
    await scheduler.tick();
    expect(evo.sentTo()).toHaveLength(3);

    // a day passes: the ledger rows are still pending and the budget is fresh
    coldQuota.purge(new Date(Date.now() + 40 * 86_400_000));
    jobs.reschedule('j1', PAST);
    await scheduler.tick();

    expect(evo.sentTo()).toHaveLength(5);
    expect(jobs.byId('j1')!.status).toBe('done');
    // the hold is over — a finished campaign is not waiting for anything
    expect(jobs.progress('j1')!.holdReason).toBeNull();
  });

  it('a per-compose cold-cap override governs instead of the configured global cap', async () => {
    // global cap is 3 (from beforeEach) — the job's own override raises it to 4
    const scheduler = build(guards());
    jobs.upsert({
      id: 'j1',
      scheduledAt: PAST,
      recipients: nums(5).map(r),
      items: [textItem],
      batch: { pauseMin: 0, coldCap: { dailyCap: 4 } },
    });
    await scheduler.tick();

    expect(evo.sentTo()).toHaveLength(4);
    expect(jobs.pendingSends('j1')).toHaveLength(1);
  });

  it('is inert when no guards are wired at all', async () => {
    const scheduler = build({});
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: nums(5).map(r), items: [textItem] });
    await scheduler.tick();

    expect(evo.sentTo()).toHaveLength(5);
    expect(jobs.byId('j1')!.status).toBe('done');
  });
});

describe('/api/sending-limits', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('reports the ration, what is left of it, and the known-contact count', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/sending-limits' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.coldContacts.enabled).toBe(true);
    expect(body.coldContacts.spent).toBe(0);
    // a line with no history starts at the warm-up floor, not the full cap
    expect(body.coldContacts.cap).toBe(body.coldContacts.warmupStart);
    expect(body.coldContacts.remaining).toBe(body.coldContacts.warmupStart);
    expect(body.knownContacts).toBe(0);
    expect(body.verification.dailyCap).toBeGreaterThan(0);
  });
});

describe('disconnect guard', () => {
  let db: Db;
  let jobs: JobStore;
  let evo: FakeEvo;

  beforeEach(() => {
    db = openDb(':memory:');
    jobs = new JobStore(db);
    evo = new FakeEvo();
  });
  afterEach(() => db.close());

  const build = (isOpen: () => Promise<boolean | null>) =>
    new Scheduler(
      jobs,
      new Sender(evo, new BlacklistStore(db)),
      { pollMs: 60_000, delayMinMs: 0, delayMaxMs: 0, maxOverdueMin: 0, sendMaxAttempts: 3 },
      () => {},
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { health: { isOpen } },
    );

  it('stops the campaign when the line is down instead of burning retries', async () => {
    const scheduler = build(async () => false);
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: nums(5).map(r), items: [textItem] });
    await scheduler.tick();

    expect(evo.sentTo()).toEqual([]);
    const job = jobs.byId('j1')!;
    expect(job.status).toBe('paused');
    expect(job.result).toContain('disconnected');
    expect(jobs.pendingSends('j1')).toHaveLength(5); // nothing marked failed
  });

  it('an unknown state never blocks a send', async () => {
    const scheduler = build(async () => null);
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: nums(3).map(r), items: [textItem] });
    await scheduler.tick();

    expect(evo.sentTo()).toHaveLength(3);
    expect(jobs.byId('j1')!.status).toBe('done');
  });

  it('a failing health check is not evidence of a problem', async () => {
    const scheduler = build(async () => {
      throw new Error('fetchInstances down');
    });
    jobs.upsert({ id: 'j1', scheduledAt: PAST, recipients: nums(3).map(r), items: [textItem] });
    await scheduler.tick();

    expect(evo.sentTo()).toHaveLength(3);
    expect(jobs.byId('j1')!.status).toBe('done');
  });
});
