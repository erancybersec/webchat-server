import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BlacklistStore } from '../src/services/blacklist.js';
import { NO_FILTER, OutboundLog } from '../src/services/outbound.js';
import { Sender } from '../src/services/sender.js';
import { FakeEvo, makeApp, type TestApp } from './helpers.js';

describe('OutboundLog', () => {
  let db: Db;
  let log: OutboundLog;
  beforeEach(() => {
    db = openDb(':memory:');
    log = new OutboundLog(db);
  });
  afterEach(() => db.close());

  it('records a send and finds it within the window', () => {
    log.record('972521111111', 'Test');
    expect(log.recentlyContacted(['972521111111'], 7, { eff: 'Test', def: 'Test' })).toEqual([
      '972521111111',
    ]);
  });

  it('never counts a recipient with no send on record', () => {
    log.record('972521111111', 'Test');
    expect(log.recentlyContacted(['972529999999'], 7, { eff: 'Test', def: 'Test' })).toEqual([]);
  });

  it('drops group JIDs — no contact key means never "contacted"', () => {
    log.record('123-456@g.us', 'Test');
    expect(log.recentRoster(7, { eff: 'Test', def: 'Test' })).toEqual([]);
  });

  it('scopes by instance — a send on another line never counts here', () => {
    log.record('972521111111', 'Other');
    expect(log.recentlyContacted(['972521111111'], 7, { eff: 'Test', def: 'Test' })).toEqual([]);
  });

  it('roster dedupes and comes back name-less', () => {
    log.record('972521111111', 'Test');
    log.record('972521111111', 'Test');
    log.record('972522222222', 'Test');
    const roster = log.recentRoster(7, NO_FILTER);
    expect(roster).toHaveLength(2);
    expect(roster.every((m) => m.isGroup === false && m.name === '')).toBe(true);
  });
});

describe('Sender.sendOne — outbound logging must never turn a real send into a failure', () => {
  it('a real, successful send still reports "sent" even if OutboundLog.record() throws', async () => {
    const db = openDb(':memory:');
    const evo = new FakeEvo();
    const blacklist = new BlacklistStore(db);
    const brokenOutbound = { record: () => { throw new Error('simulated DB error'); } } as any;
    const sender = new Sender(evo, blacklist, undefined, brokenOutbound);

    const outcome = await sender.sendOne('972521111111', { type: 'text', data: { text: 'hi' } }, 'Test');

    // Evolution accepted it — a logging bug must not turn that into a thrown
    // error, which upstream callers would read as failed and could retry.
    expect(outcome.status).toBe('sent');
    expect(evo.sentTo()).toEqual(['972521111111']);
    db.close();
  });
});

describe('recently-contacted signal covers every send path', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('a manual chat reply (not a campaign) counts as "contacted"', async () => {
    // Exactly the gap reported: replying from the Chat tab never touched
    // job_sends, so this recipient never showed up as recently contacted.
    await t.app.inject({
      method: 'POST',
      url: '/api/send',
      payload: { recipient: '972523422216', item: { type: 'text', data: { text: 'hi' } } },
    });
    const recency = await t.app.inject({
      method: 'POST',
      url: '/api/sending-limits/recency',
      payload: { recipients: ['972523422216'], days: 30 },
    });
    expect(recency.json()).toMatchObject({ recent: ['972523422216'] });

    const roster = await t.app.inject({
      method: 'POST',
      url: '/api/sending-limits/recent-roster',
      payload: { days: 30 },
    });
    expect(roster.json().members).toMatchObject([{ recipient: '972523422216' }]);
  });

  it('a skipped (blacklisted) send is never logged as contacted', async () => {
    t.blacklist.addMany([{ phone_number: '972521111111' }]);
    await t.app.inject({
      method: 'POST',
      url: '/api/send',
      payload: { recipient: '972521111111', item: { type: 'text', data: { text: 'hi' } } },
    });
    const recency = await t.app.inject({
      method: 'POST',
      url: '/api/sending-limits/recency',
      payload: { recipients: ['972521111111'], days: 30 },
    });
    expect(recency.json()).toMatchObject({ recent: [] });
  });

  it('a group send never shows up in the roster', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/send',
      payload: { recipient: '123-456@g.us', item: { type: 'text', data: { text: 'hi' } } },
    });
    const roster = await t.app.inject({
      method: 'POST',
      url: '/api/sending-limits/recent-roster',
      payload: { days: 30 },
    });
    expect(roster.json().members).toEqual([]);
  });
});

describe('outbound log via the live relay (phone-sent messages)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  const upsert = (jid: string, fromMe: boolean, opts: { instance?: string; ts?: number } = {}) => ({
    event: 'messages.upsert',
    data: {
      event: 'messages.upsert',
      instance: opts.instance ?? 'Test',
      data: {
        key: { remoteJid: jid, fromMe, id: `m-${Math.floor(Math.random() * 1e9)}` },
        messageTimestamp: opts.ts != null ? Math.floor(opts.ts / 1000) : Math.floor(Date.now() / 1000),
      },
    },
  });

  it('a message sent from the phone (never via Sender.sendOne) counts as "contacted"', async () => {
    t.relay.broadcast(upsert('972529998888@s.whatsapp.net', true));
    const recency = await t.app.inject({
      method: 'POST',
      url: '/api/sending-limits/recency',
      payload: { recipients: ['972529998888'], days: 30 },
    });
    expect(recency.json()).toMatchObject({ recent: ['972529998888'] });
  });

  it('an inbound message (fromMe: false) never counts as "contacted"', async () => {
    t.relay.broadcast(upsert('972529998888@s.whatsapp.net', false));
    const recency = await t.app.inject({
      method: 'POST',
      url: '/api/sending-limits/recency',
      payload: { recipients: ['972529998888'], days: 30 },
    });
    expect(recency.json()).toMatchObject({ recent: [] });
  });

  it('ignores a stale replayed event (reconnect history sync)', async () => {
    t.relay.broadcast(upsert('972529998888@s.whatsapp.net', true, { ts: Date.now() - 10 * 86_400_000 }));
    const recency = await t.app.inject({
      method: 'POST',
      url: '/api/sending-limits/recency',
      payload: { recipients: ['972529998888'], days: 30 },
    });
    expect(recency.json()).toMatchObject({ recent: [] });
  });

  it('scopes phone-sent messages by instance like every other line-scoped signal', async () => {
    t.relay.broadcast(upsert('972529998888@s.whatsapp.net', true, { instance: 'Second' }));
    const recency = await t.app.inject({
      method: 'POST',
      url: '/api/sending-limits/recency?instance=Test',
      payload: { recipients: ['972529998888'], days: 30 },
    });
    expect(recency.json()).toMatchObject({ recent: [] });
  });
});
