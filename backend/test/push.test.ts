import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { ChatMetaStore } from '../src/services/chatmeta.js';
import { EventRelay } from '../src/services/events.js';
import {
  DEFAULT_NOTIFY_PREFS,
  NotifyPrefsStore,
  shouldNotifyJob,
  shouldNotifyMessage,
} from '../src/services/notifyprefs.js';
import {
  attachJobNotifier,
  attachPushNotifier,
  messagePreview,
  messageText,
  PushService,
  type PushSub,
} from '../src/services/push.js';

const sub = (endpoint: string): PushSub => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

const upsert = (jid: string, text: string, fromMe = false, instance = 'Test') => ({
  event: 'messages.upsert',
  data: {
    event: 'messages.upsert',
    instance,
    data: { key: { remoteJid: jid, fromMe }, message: { conversation: text }, pushName: 'Dana' },
  },
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('web push', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  it('messagePreview summarizes each message kind', () => {
    expect(messagePreview({ conversation: 'hi' })).toBe('hi');
    expect(messagePreview({ extendedTextMessage: { text: 'yo' } })).toBe('yo');
    expect(messagePreview({ imageMessage: {} })).toBe('📷 Photo');
    expect(messagePreview({ imageMessage: { caption: 'cap' } })).toBe('📷 cap');
    expect(messagePreview({ audioMessage: {} })).toBe('🎤 Voice message');
    expect(messagePreview(undefined)).toBe('New message');
  });

  it('generates a persistent VAPID key and stores subscriptions', () => {
    const push = new PushService(db, { transport: async () => ({ statusCode: 201 }) });
    expect(push.publicKey()).toMatch(/.{20,}/); // a real base64url key
    // a second instance over the same db reuses the same key (persisted)
    const again = new PushService(db, { transport: async () => ({ statusCode: 201 }) });
    expect(again.publicKey()).toBe(push.publicKey());

    push.saveSubscription('a@x.com', sub('https://push/1'));
    const rows = db.prepare(`SELECT endpoint, agent_email FROM push_subscriptions`).all();
    expect(rows).toEqual([{ endpoint: 'https://push/1', agent_email: 'a@x.com' }]);
  });

  it('sends to the assignee for an assigned chat, everyone for an unassigned one', async () => {
    const calls: Array<{ endpoint: string; payload: any }> = [];
    const push = new PushService(db, {
      transport: async (s, payload) => {
        calls.push({ endpoint: s.endpoint, payload: JSON.parse(payload) });
        return { statusCode: 201 };
      },
    });
    const meta = new ChatMetaStore(db);
    const relay = new EventRelay({ base: 'x', instance: 'Test', apikey: 'k', enabled: false }, () => {});
    attachPushNotifier(relay, push, meta, () => 'Test', () => ['Test']);

    push.saveSubscription('alice@x.com', sub('https://push/alice'));
    push.saveSubscription('bob@x.com', sub('https://push/bob'));

    // assigned chat → only the assignee's device
    meta.assign('111@s.whatsapp.net', 'alice@x.com', 'admin');
    relay.broadcast(upsert('111@s.whatsapp.net', 'assigned hi'));
    await tick();
    expect(calls.map((c) => c.endpoint)).toEqual(['https://push/alice']);
    expect(calls[0]!.payload).toMatchObject({ title: 'Dana', body: 'assigned hi' });

    // unassigned chat → everyone
    calls.length = 0;
    relay.broadcast(upsert('222@s.whatsapp.net', 'open hi'));
    await tick();
    expect(calls.map((c) => c.endpoint).sort()).toEqual(['https://push/alice', 'https://push/bob']);
  });

  it('ignores own sends and reactions', async () => {
    const calls: string[] = [];
    const push = new PushService(db, {
      transport: async (s) => {
        calls.push(s.endpoint);
        return { statusCode: 201 };
      },
    });
    const meta = new ChatMetaStore(db);
    const relay = new EventRelay({ base: 'x', instance: 'Test', apikey: 'k', enabled: false }, () => {});
    attachPushNotifier(relay, push, meta, () => 'Test', () => ['Test']);
    push.saveSubscription('', sub('https://push/anyone'));

    relay.broadcast(upsert('111@s.whatsapp.net', 'mine', true)); // fromMe
    relay.broadcast({
      event: 'messages.upsert',
      data: {
        instance: 'Test',
        data: { key: { remoteJid: '111@s.whatsapp.net' }, message: { reactionMessage: { text: '👍' } } },
      },
    }); // reaction
    await tick();
    expect(calls).toEqual([]);
  });

  it('only the selected channels notify — empty list = nothing (default included)', async () => {
    const calls: string[] = [];
    const push = new PushService(db, {
      transport: async (s) => {
        calls.push(s.endpoint);
        return { statusCode: 201 };
      },
    });
    const meta = new ChatMetaStore(db);
    const relay = new EventRelay({ base: 'x', instance: 'Test', apikey: 'k', enabled: false }, () => {});
    // operator-chosen allowlist, read live each event
    let allow: string[] = [];
    attachPushNotifier(relay, push, meta, () => 'Test', () => allow);
    push.saveSubscription('', sub('https://push/anyone'));

    // nothing selected → even the default line ("Test") is silent
    relay.broadcast(upsert('111@s.whatsapp.net', 'home', false, 'Test'));
    relay.broadcast(upsert('222@s.whatsapp.net', 'other', false, 'Second'));
    await tick();
    expect(calls).toEqual([]);

    // select the default + second line → both notify
    calls.length = 0;
    allow = ['Test', 'Second'];
    relay.broadcast(upsert('333@s.whatsapp.net', 'home on', false, 'Test'));
    relay.broadcast(upsert('444@s.whatsapp.net', 'second on', false, 'Second'));
    await tick();
    expect(calls).toEqual(['https://push/anyone', 'https://push/anyone']);

    // a line NOT on the allowlist stays silent
    calls.length = 0;
    relay.broadcast(upsert('555@s.whatsapp.net', 'third line', false, 'Third'));
    await tick();
    expect(calls).toEqual([]);
  });

  it('skips replayed history (stale messageTimestamp) so a reconnect cannot flood', async () => {
    const calls: string[] = [];
    const push = new PushService(db, {
      transport: async (s) => {
        calls.push(s.endpoint);
        return { statusCode: 201 };
      },
    });
    const meta = new ChatMetaStore(db);
    const relay = new EventRelay({ base: 'x', instance: 'Test', apikey: 'k', enabled: false }, () => {});
    attachPushNotifier(relay, push, meta, () => 'Test', () => ['Test']);
    push.saveSubscription('', sub('https://push/anyone'));

    const oldTs = Math.floor((Date.now() - 60 * 60_000) / 1000); // an hour ago, in seconds
    relay.broadcast({
      event: 'messages.upsert',
      data: {
        instance: 'Test',
        data: {
          key: { remoteJid: '444@s.whatsapp.net' },
          message: { conversation: 'replayed' },
          pushName: 'Old',
          messageTimestamp: oldTs,
        },
      },
    });
    await tick();
    expect(calls).toEqual([]); // dropped as stale
  });

  it('prunes a subscription the push service reports gone (410)', async () => {
    const push = new PushService(db, {
      transport: async (s) => {
        if (s.endpoint === 'https://push/dead') throw { statusCode: 410 };
        return { statusCode: 201 };
      },
    });
    push.saveSubscription('', sub('https://push/live'));
    push.saveSubscription('', sub('https://push/dead'));

    const sent = await push.send(null, { title: 't', body: 'b', tag: 'c' });
    expect(sent).toBe(1); // only the live one
    const left = db.prepare(`SELECT endpoint FROM push_subscriptions`).all();
    expect(left).toEqual([{ endpoint: 'https://push/live' }]);
  });

  it('enforces per-person group/DM mutes and keyword alerts in the notifier', async () => {
    const calls: string[] = [];
    const push = new PushService(db, {
      transport: async (s) => {
        calls.push(s.endpoint);
        return { statusCode: 201 };
      },
    });
    const meta = new ChatMetaStore(db);
    const prefs = new NotifyPrefsStore(db);
    const relay = new EventRelay({ base: 'x', instance: 'Test', apikey: 'k', enabled: false }, () => {});
    attachPushNotifier(relay, push, meta, () => 'Test', () => ['Test'], prefs);
    push.saveSubscription('alice@x.com', sub('https://push/alice'));

    // alice mutes groups → a group message is dropped, a DM still notifies
    prefs.set('alice@x.com', { groups: false });
    relay.broadcast(upsert('120@g.us', 'group chatter'));
    await tick();
    expect(calls).toEqual([]);
    relay.broadcast(upsert('111@s.whatsapp.net', 'direct hi'));
    await tick();
    expect(calls).toEqual(['https://push/alice']);

    // mute DMs too, but a keyword pierces the mute
    calls.length = 0;
    prefs.set('alice@x.com', { dms: false, keywords: 'urgent' });
    relay.broadcast(upsert('111@s.whatsapp.net', 'just chatting'));
    await tick();
    expect(calls).toEqual([]); // muted, no keyword
    relay.broadcast(upsert('111@s.whatsapp.net', 'this is URGENT'));
    await tick();
    expect(calls).toEqual(['https://push/alice']); // keyword pierces the mute
  });

  it('pushes a job-ended summary to the creator, gated by prefs', async () => {
    const calls: Array<{ endpoint: string; payload: any }> = [];
    const push = new PushService(db, {
      transport: async (s, payload) => {
        calls.push({ endpoint: s.endpoint, payload: JSON.parse(payload) });
        return { statusCode: 201 };
      },
    });
    const prefs = new NotifyPrefsStore(db);
    const relay = new EventRelay({ base: 'x', instance: 'Test', apikey: 'k', enabled: false }, () => {});
    const jobs = { byId: (id: string) => (id === 'j1' ? { sentBy: 'alice@x.com' } : null) };
    attachJobNotifier(relay, push, jobs, prefs);
    push.saveSubscription('alice@x.com', sub('https://push/alice'));
    push.saveSubscription('bob@x.com', sub('https://push/bob'));

    // a finished job pings only its creator
    relay.broadcast({
      event: 'JOB_PROGRESS',
      data: { jobId: 'j1', done: true, total: 3, sent: 3, skipped: 0, failed: 0, status: 'done' },
    });
    await tick();
    expect(calls.map((c) => c.endpoint)).toEqual(['https://push/alice']);
    expect(calls[0]!.payload).toMatchObject({ title: 'Job finished', tag: 'job:j1' });

    // in-progress (done:false) events are ignored
    calls.length = 0;
    relay.broadcast({ event: 'JOB_PROGRESS', data: { jobId: 'j1', done: false, sent: 1 } });
    await tick();
    expect(calls).toEqual([]);

    // failures-only: a clean job is silent, a job with failures notifies
    prefs.set('alice@x.com', { jobsFailuresOnly: true });
    relay.broadcast({
      event: 'JOB_PROGRESS',
      data: { jobId: 'j1', done: true, total: 3, sent: 3, failed: 0, status: 'done' },
    });
    await tick();
    expect(calls).toEqual([]);
    relay.broadcast({
      event: 'JOB_PROGRESS',
      data: { jobId: 'j1', done: true, total: 3, sent: 1, failed: 2, status: 'failed' },
    });
    await tick();
    expect(calls.map((c) => c.endpoint)).toEqual(['https://push/alice']);
    expect(calls[0]!.payload).toMatchObject({ title: 'Job failed' });
  });

  it('sendToEndpoint targets a single known device (the test-notification path)', async () => {
    const calls: string[] = [];
    const push = new PushService(db, {
      transport: async (s) => {
        calls.push(s.endpoint);
        return { statusCode: 201 };
      },
    });
    push.saveSubscription('a@x.com', sub('https://push/one'));
    expect(await push.sendToEndpoint('https://push/one', { title: 't', body: 'b', tag: 'c' })).toBe(1);
    expect(await push.sendToEndpoint('https://push/missing', { title: 't', body: 'b', tag: 'c' })).toBe(0);
    expect(calls).toEqual(['https://push/one']);
  });
});

describe('notify gates (pure)', () => {
  it('message gate: category, keyword, quiet hours', () => {
    const base = { ...DEFAULT_NOTIFY_PREFS };
    expect(shouldNotifyMessage(base, { isGroup: true, text: 'x' })).toBe(true);
    expect(shouldNotifyMessage({ ...base, groups: false }, { isGroup: true, text: 'x' })).toBe(false);
    expect(shouldNotifyMessage({ ...base, dms: false }, { isGroup: false, text: 'x' })).toBe(false);
    // keyword pierces a category mute (case-insensitive, substring)
    expect(
      shouldNotifyMessage(
        { ...base, dms: false, keywords: 'urgent, refund' },
        { isGroup: false, text: 'please REFUND me' },
      ),
    ).toBe(true);
    // quiet hours mute everything in the (overnight) window…
    const night = new Date('2026-06-19T23:00:00');
    const quiet = { ...base, quietEnabled: true, quietStart: '21:00', quietEnd: '08:00' };
    expect(shouldNotifyMessage(quiet, { isGroup: false, text: 'x', now: night })).toBe(false);
    // …except a keyword, which still pierces quiet hours
    expect(
      shouldNotifyMessage({ ...quiet, keywords: 'urgent' }, { isGroup: false, text: 'urgent', now: night }),
    ).toBe(true);
  });

  it('job gate: enabled + failures-only', () => {
    const base = { ...DEFAULT_NOTIFY_PREFS };
    expect(shouldNotifyJob(base, { failed: 0 })).toBe(true);
    expect(shouldNotifyJob({ ...base, jobsEnded: false }, { failed: 5 })).toBe(false);
    expect(shouldNotifyJob({ ...base, jobsFailuresOnly: true }, { failed: 0 })).toBe(false);
    expect(shouldNotifyJob({ ...base, jobsFailuresOnly: true }, { failed: 2 })).toBe(true);
  });

  it('messageText extracts raw text/caption for keyword matching', () => {
    expect(messageText({ conversation: 'hi' })).toBe('hi');
    expect(messageText({ extendedTextMessage: { text: 'yo' } })).toBe('yo');
    expect(messageText({ imageMessage: { caption: 'cap' } })).toBe('cap');
    expect(messageText({ imageMessage: {} })).toBe(''); // no caption → empty (not "📷 Photo")
    expect(messageText(undefined)).toBe('');
  });

  it('store round-trips a partial update over defaults', () => {
    const db = openDb(':memory:');
    const prefs = new NotifyPrefsStore(db);
    expect(prefs.get('a@x.com')).toEqual(DEFAULT_NOTIFY_PREFS);
    prefs.set('a@x.com', { groups: false, keywords: 'hi' });
    expect(prefs.get('a@x.com')).toMatchObject({ groups: false, dms: true, keywords: 'hi' });
    db.close();
  });
});
