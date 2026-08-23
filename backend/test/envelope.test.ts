import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrapEvent } from '../src/services/envelope.js';
import { makeApp, type TestApp } from './helpers.js';

const flush = () => new Promise((r) => setImmediate(r));

/**
 * Evolution's GLOBAL websocket wraps every payload in an envelope
 * ({ instance, data, server_url, ... }). The v2.8 listeners only handled the
 * bare-record shape the tests fed them — these tests replay the production
 * shape so the regression can never come back.
 */
// 'Test' = the configured default instance (helpers testConfig) — optout and
// the chat watcher only act on the default instance's traffic.
const envelope = (event: string, data: unknown, instance = 'Test') => ({
  event,
  data: {
    event,
    instance,
    data,
    server_url: 'https://evo.example',
    date_time: new Date().toISOString(),
    apikey: 'redacted',
  },
});

describe('unwrapEvent', () => {
  it('passes a bare record through', () => {
    const r = { key: { id: 'a' } };
    expect(unwrapEvent(r)).toEqual({ instance: undefined, records: [r] });
  });

  it('passes a bare array through', () => {
    const r = [{ key: { id: 'a' } }, { key: { id: 'b' } }];
    expect(unwrapEvent(r).records).toEqual(r);
  });

  it('unwraps {messages: [...]}', () => {
    const r = { messages: [{ key: { id: 'a' } }] };
    expect(unwrapEvent(r).records).toEqual(r.messages);
  });

  it('unwraps the global-mode envelope and reports the instance', () => {
    const rec = { key: { id: 'a' } };
    const u = unwrapEvent({ instance: 'Studio', data: rec, server_url: 'x' });
    expect(u).toEqual({ instance: 'Studio', records: [rec] });
  });

  it('unwraps an envelope whose data is an array or {messages}', () => {
    const recs = [{ key: { id: 'a' } }, { key: { id: 'b' } }];
    expect(unwrapEvent({ instance: 'S', data: recs }).records).toEqual(recs);
    expect(unwrapEvent({ instance: 'S', data: { messages: recs } }).records).toEqual(recs);
  });

  it('does not mistake a record carrying a data field for an envelope', () => {
    // only an `instance` string tag marks the envelope
    const odd = { data: { nested: true }, key: { id: 'a' } };
    expect(unwrapEvent(odd).records).toEqual([odd]);
  });

  it('returns no records for null/undefined payloads', () => {
    expect(unwrapEvent(null).records).toEqual([]);
    expect(unwrapEvent({ instance: 'S', data: null }).records).toEqual([]);
  });
});

describe('listeners against the production envelope shape', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('ack tracker marks delivered/read from enveloped MESSAGES_UPDATE', () => {
    const job = t.jobs.upsert({
      id: 'j1',
      scheduledAt: new Date().toISOString(),
      recipients: [{ id: '972521111111' }],
      items: [{ type: 'text', data: { text: 'x' } }],
    });
    t.jobs.ensureLedger(job);
    t.jobs.markSendDone(t.jobs.pendingSends('j1')[0]!, 'sent', 'msg-abc');

    t.relay.broadcast(envelope('messages.update', { keyId: 'msg-abc', status: 'DELIVERY_ACK' }));
    expect(t.jobs.allSends('j1')[0]!.deliveredAt).not.toBeNull();

    t.relay.broadcast(
      envelope('messages.update', { key: { id: 'msg-abc' }, update: { status: 'READ' } }),
    );
    expect(t.jobs.allSends('j1')[0]!.readAt).not.toBeNull();
  });

  it('opt-out blacklists from an enveloped MESSAGES_UPSERT', async () => {
    t.cfg.optoutEnabled = true;
    t.relay.broadcast(
      envelope('messages.upsert', {
        key: { remoteJid: '972521111111@s.whatsapp.net', fromMe: false, id: 'in-1' },
        pushName: 'Dana',
        message: { conversation: 'STOP' },
      }),
    );
    await flush();
    expect(t.blacklist.isBlacklisted('972521111111')).toBe(true);
  });

  it('opt-out and chat watcher ignore a FOREIGN instance (acks still apply)', async () => {
    t.cfg.optoutEnabled = true;
    const jid = '972529999999@s.whatsapp.net';
    await t.app.inject({
      method: 'POST',
      url: '/api/chats/status',
      payload: { jid, status: 'resolved' },
    });
    t.relay.broadcast(
      envelope(
        'messages.upsert',
        { key: { remoteJid: jid, fromMe: false, id: 'x1' }, message: { conversation: 'STOP' } },
        'OtherLine',
      ),
    );
    await flush();
    expect(t.blacklist.isBlacklisted('972529999999')).toBe(false);
    const meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
    expect(meta.statuses[jid]?.status).toBe('resolved');
  });

  it('chat watcher learns aliases and reopens from an enveloped upsert', async () => {
    const jid = '972521111111@s.whatsapp.net';
    await t.app.inject({
      method: 'POST',
      url: '/api/chats/status',
      payload: { jid, status: 'resolved' },
    });

    t.relay.broadcast(
      envelope('messages.upsert', {
        key: { remoteJid: '123456@lid', remoteJidAlt: jid, fromMe: false, id: 'in-2' },
        message: { conversation: 'hi again' },
      }),
    );
    await flush();

    const meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
    expect(meta.aliases['123456@lid']).toBe(jid);
    expect(meta.statuses[jid]?.status).toBe('open');
  });
});
