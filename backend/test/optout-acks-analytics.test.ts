import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseKeywords } from '../src/services/optout.js';
import { makeApp, type TestApp } from './helpers.js';

const flush = () => new Promise((r) => setImmediate(r));

const incoming = (from: string, text: string, pushName = '') => ({
  event: 'MESSAGES_UPSERT',
  data: {
    key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false, id: 'in-1' },
    pushName,
    message: { conversation: text },
  },
});

describe('auto opt-out listener', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('parseKeywords splits on commas/newlines, trims, lowercases', () => {
    expect(parseKeywords('STOP, הסר\n Unsubscribe ,')).toEqual(['stop', 'הסר', 'unsubscribe']);
  });

  it('does nothing while disabled (the default)', async () => {
    t.relay.broadcast(incoming('972521111111', 'STOP'));
    await flush();
    expect(t.blacklist.list()).toHaveLength(0);
  });

  it('blacklists an exact keyword match, case-insensitively, with the sender name', async () => {
    t.cfg.optoutEnabled = true;
    t.relay.broadcast(incoming('972521111111', '  stop ', 'Dana'));
    await flush();
    const entries = t.blacklist.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      phone_number: '972521111111',
      name: 'Dana',
      why_blacklisted: 'opt-out (auto)',
    });
    expect(t.evo.calls).toHaveLength(0); // no reply configured
  });

  it('sends the confirmation BEFORE blacklisting so it is not skipped', async () => {
    t.cfg.optoutEnabled = true;
    t.cfg.optoutReply = 'You are unsubscribed.';
    t.relay.broadcast(incoming('972521111111', 'STOP'));
    await flush();
    expect(t.evo.calls).toHaveLength(1);
    expect(t.evo.calls[0]!.body).toMatchObject({
      number: '972521111111',
      text: 'You are unsubscribed.',
    });
    expect(t.blacklist.isBlacklisted('972521111111')).toBe(true);
  });

  it('ignores non-matching texts, own messages, and groups', async () => {
    t.cfg.optoutEnabled = true;
    t.relay.broadcast(incoming('972521111111', 'please STOP sending'));
    t.relay.broadcast({
      event: 'MESSAGES_UPSERT',
      data: {
        key: { remoteJid: '972521111111@s.whatsapp.net', fromMe: true },
        message: { conversation: 'STOP' },
      },
    });
    t.relay.broadcast({
      event: 'MESSAGES_UPSERT',
      data: { key: { remoteJid: '123@g.us', fromMe: false }, message: { conversation: 'STOP' } },
    });
    await flush();
    expect(t.blacklist.list()).toHaveLength(0);
  });
});

describe('ack tracker', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('MESSAGES_UPDATE acks upgrade sent rows to delivered/read', async () => {
    const job = t.jobs.upsert({
      id: 'j1',
      scheduledAt: new Date().toISOString(),
      recipients: [{ id: '972521111111' }],
      items: [{ type: 'text', data: { text: 'x' } }],
    });
    t.jobs.ensureLedger(job);
    t.jobs.markSendDone(t.jobs.pendingSends('j1')[0]!, 'sent', 'msg-abc');

    t.relay.broadcast({
      event: 'MESSAGES_UPDATE',
      data: { keyId: 'msg-abc', status: 'DELIVERY_ACK' },
    });
    expect(t.jobs.allSends('j1')[0]!.deliveredAt).not.toBeNull();
    expect(t.jobs.allSends('j1')[0]!.readAt).toBeNull();

    t.relay.broadcast({
      event: 'messages.update',
      data: [{ key: { id: 'msg-abc' }, update: { status: 'READ' } }],
    });
    expect(t.jobs.allSends('j1')[0]!.readAt).not.toBeNull();
  });

  it('READ backfills delivered_at when the delivery ack was missed', async () => {
    const job = t.jobs.upsert({
      id: 'j1',
      scheduledAt: new Date().toISOString(),
      recipients: [{ id: '972521111111' }],
      items: [{ type: 'text', data: { text: 'x' } }],
    });
    t.jobs.ensureLedger(job);
    t.jobs.markSendDone(t.jobs.pendingSends('j1')[0]!, 'sent', 'msg-abc');
    t.relay.broadcast({ event: 'MESSAGES_UPDATE', data: { keyId: 'msg-abc', status: 'READ' } });
    const s = t.jobs.allSends('j1')[0]!;
    expect(s.deliveredAt).not.toBeNull();
    expect(s.readAt).not.toBeNull();
  });

  it('a READ ack also stamps the read time in message_reads (for the chat "Seen at")', () => {
    t.relay.broadcast({ event: 'MESSAGES_UPDATE', data: { keyId: 'chat-msg-1', status: 'READ' } });
    const row = t.db
      .prepare(`SELECT read_at FROM message_reads WHERE message_id = ?`)
      .get('chat-msg-1') as { read_at?: string } | undefined;
    expect(row?.read_at).toBeTruthy();
  });

  it('a delivery-only ack does NOT stamp message_reads (not seen yet)', () => {
    t.relay.broadcast({ event: 'MESSAGES_UPDATE', data: { keyId: 'chat-msg-2', status: 'DELIVERY_ACK' } });
    const row = t.db
      .prepare(`SELECT read_at FROM message_reads WHERE message_id = ?`)
      .get('chat-msg-2');
    expect(row).toBeUndefined();
  });
});

describe('/api/analytics/summary', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('aggregates sends, jobs, errors and blacklist counts', async () => {
    // one finished job: 2 sent (1 read), 1 failed
    const job = t.jobs.upsert({
      id: 'j1',
      scheduledAt: new Date().toISOString(),
      recipients: [{ id: '1111111111' }, { id: '2222222222' }, { id: '3333333333' }],
      items: [{ type: 'text', data: { text: 'x' } }],
    });
    t.jobs.ensureLedger(job);
    const [a, b, c] = t.jobs.pendingSends('j1');
    t.jobs.markSendDone(a!, 'sent', 'm1');
    t.jobs.markSendDone(b!, 'sent', 'm2');
    t.jobs.markSendFailedAttempt(c!, 'evolution 500: boom', 1);
    t.jobs.finish('j1', 'done', '2/3 sent');
    t.jobs.markAck('m1', 'read');
    t.blacklist.addMany([{ phone_number: '0521111111' }]);

    const res = (await t.app.inject({ method: 'GET', url: '/api/analytics/summary?days=7' })).json();
    expect(res.days).toBe(7);
    expect(res.totals).toEqual({ sent: 2, failed: 1, skipped: 0, delivered: 1, read: 1 });
    expect(res.jobs).toMatchObject({ done: 1 });
    expect(res.topErrors).toEqual([{ error: 'evolution 500: boom', count: 1 }]);
    expect(res.blacklist).toEqual({ total: 1, added: 1 });
    const today = new Date().toISOString().slice(0, 10);
    expect(res.perDay).toEqual([{ day: today, sent: 2, failed: 1, skipped: 0 }]);
  });
});

describe('settings: v2.4 keys', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('PUT toggles recurring/quiet/opt-out live and exposes them on GET', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        recurringEnabled: true,
        quietEnabled: true,
        quietStart: '22:30',
        quietEnd: '07:15',
        optoutEnabled: true,
        optoutKeywords: 'stop, הסר',
        optoutReply: 'bye',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      recurringEnabled: true,
      quietEnabled: true,
      quietStart: '22:30',
      quietEnd: '07:15',
      optoutEnabled: true,
      optoutKeywords: 'stop, הסר',
      optoutReply: 'bye',
    });
    // live by reference — the scheduler/opt-out listener see these instantly
    expect(t.cfg.recurringEnabled).toBe(true);
    expect(t.cfg.quietStart).toBe('22:30');
    expect(t.cfg.optoutReply).toBe('bye');
  });

  it('rejects malformed quiet-hours times', async () => {
    for (const payload of [{ quietStart: '25:00' }, { quietEnd: '8:0' }, { quietStart: 'noon' }]) {
      const res = await t.app.inject({ method: 'PUT', url: '/api/settings', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('gates job repeat rules on the recurring toggle', async () => {
    const job = {
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      recipients: [{ id: '972521111111' }],
      items: [{ type: 'text', data: { text: 'x' } }],
      repeat: { freq: 'daily' },
    };
    const denied = await t.app.inject({ method: 'POST', url: '/api/jobs', payload: job });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toContain('disabled');

    await t.app.inject({ method: 'PUT', url: '/api/settings', payload: { recurringEnabled: true } });
    const allowed = await t.app.inject({ method: 'POST', url: '/api/jobs', payload: job });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().repeat).toEqual({ freq: 'daily' });

    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { ...job, repeat: { freq: 'hourly' } },
    });
    expect(bad.statusCode).toBe(400);
  });
});
