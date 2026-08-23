import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { EventRelay } from '../src/services/events.js';
import { attachChatUnread, ChatUnreadStore } from '../src/services/chatunread.js';
import { enrichChats, type ChatUnreadGateway } from '../src/routes/gateway.js';

describe('ChatUnreadStore', () => {
  let db: Db;
  let s: ChatUnreadStore;
  beforeEach(() => {
    db = openDb(':memory:');
    s = new ChatUnreadStore(db);
  });
  afterEach(() => db.close());

  it('returns null for a chat never tracked (caller falls back to Evolution)', () => {
    expect(s.unreadFor('I', 'a@x')).toBeNull();
  });

  it('marks unread on an incoming message and reads it back', () => {
    s.recordIncoming('I', 'a@x', 1000);
    expect(s.unreadFor('I', 'a@x')).toBe(1);
  });

  it('clears unread for the whole team once read (shared)', () => {
    s.recordIncoming('I', 'a@x', 1000);
    s.markRead('I', 'a@x');
    expect(s.unreadFor('I', 'a@x')).toBe(0);
  });

  it('re-marks unread when a newer message arrives after a read', () => {
    s.recordIncoming('I', 'a@x', 1000);
    s.markRead('I', 'a@x');
    s.recordIncoming('I', 'a@x', 2000);
    expect(s.unreadFor('I', 'a@x')).toBe(1);
  });

  it('an older (already-read) re-delivery does not resurrect unread', () => {
    s.recordIncoming('I', 'a@x', 2000);
    s.markRead('I', 'a@x');
    s.recordIncoming('I', 'a@x', 1500); // late/replayed older message
    expect(s.unreadFor('I', 'a@x')).toBe(0);
  });

  it('markUnread forces a badge even with no prior incoming', () => {
    s.markUnread('I', 'a@x', 5000);
    expect(s.unreadFor('I', 'a@x')).toBe(1);
  });

  it('is scoped per instance', () => {
    s.recordIncoming('LineA', 'a@x', 1000);
    expect(s.unreadFor('LineA', 'a@x')).toBe(1);
    expect(s.unreadFor('LineB', 'a@x')).toBeNull();
  });

  it('ignores empty jid / zero ts', () => {
    s.recordIncoming('I', '', 1000);
    s.recordIncoming('I', 'a@x', 0);
    expect(s.unreadFor('I', 'a@x')).toBeNull();
  });
});

describe('attachChatUnread (relay listener)', () => {
  let db: Db;
  let relay: EventRelay;
  let store: ChatUnreadStore;
  beforeEach(() => {
    db = openDb(':memory:');
    relay = new EventRelay({ base: '', instance: '', apikey: '', enabled: false });
    store = new ChatUnreadStore(db);
    attachChatUnread(relay, store, (jid) => jid); // identity canon for the test
  });
  afterEach(() => db.close());

  const upsert = (key: Record<string, unknown>, message: unknown, ts = 1700) => ({
    event: 'messages.upsert',
    data: { event: 'messages.upsert', instance: 'I', data: { key, message, messageTimestamp: ts } },
  });

  it('bumps unread on an incoming text message', () => {
    relay.broadcast(upsert({ remoteJid: 'a@x', fromMe: false }, { conversation: 'hi' }));
    expect(store.unreadFor('I', 'a@x')).toBe(1);
  });

  it('ignores our own (fromMe) messages', () => {
    relay.broadcast(upsert({ remoteJid: 'a@x', fromMe: true }, { conversation: 'mine' }));
    expect(store.unreadFor('I', 'a@x')).toBeNull();
  });

  it('ignores reactions, edits and deletes (not new messages)', () => {
    relay.broadcast(upsert({ remoteJid: 'a@x', fromMe: false }, { reactionMessage: { text: '❤️' } }));
    relay.broadcast(
      upsert({ remoteJid: 'a@x', fromMe: false }, { protocolMessage: { editedMessage: { conversation: 'e' } } }),
    );
    relay.broadcast(upsert({ remoteJid: 'a@x', fromMe: false }, null));
    expect(store.unreadFor('I', 'a@x')).toBeNull();
  });
});

describe('enrichChats', () => {
  const res = (records: unknown) => ({
    ok: true,
    status: 200,
    contentType: 'application/json',
    text: JSON.stringify(records),
  });
  const gw = (map: Record<string, number | null>): ChatUnreadGateway => ({
    unreadFor: (_i, jid) => (jid in map ? map[jid]! : null),
    markRead: () => {},
    markUnread: () => {},
  });

  it('overrides unreadCount with the shared unread (badge ≥ 1)', () => {
    const r = enrichChats(res([{ remoteJid: 'a@x', unreadCount: null }]), gw({ 'a@x': 1 }), 'I');
    expect(JSON.parse(r.text)[0].unreadCount).toBe(1);
  });

  it('keeps Evolution’s larger count when the chat is unread', () => {
    const r = enrichChats(res([{ remoteJid: 'a@x', unreadCount: 5 }]), gw({ 'a@x': 1 }), 'I');
    expect(JSON.parse(r.text)[0].unreadCount).toBe(5);
  });

  it('flags unreadDot when unread but Evolution has no count (WhatsApp dot)', () => {
    const r = enrichChats(res([{ remoteJid: 'a@x', unreadCount: null }]), gw({ 'a@x': 1 }), 'I');
    const rec = JSON.parse(r.text)[0];
    expect(rec.unreadCount).toBe(1);
    expect(rec.unreadDot).toBe(true);
  });

  it('does NOT flag unreadDot when Evolution reports a real count', () => {
    const r = enrichChats(res([{ remoteJid: 'a@x', unreadCount: 5 }]), gw({ 'a@x': 1 }), 'I');
    // absent/false (the client coerces with !!) — never truthy when a count exists
    expect(JSON.parse(r.text)[0].unreadDot).toBeFalsy();
  });

  it('clears unreadDot when the chat is read', () => {
    const r = enrichChats(res([{ remoteJid: 'a@x', unreadCount: 9 }]), gw({ 'a@x': 0 }), 'I');
    expect(JSON.parse(r.text)[0].unreadDot).toBeFalsy();
  });

  it('clears the badge for everyone once read (shared)', () => {
    const r = enrichChats(res([{ remoteJid: 'a@x', unreadCount: 9 }]), gw({ 'a@x': 0 }), 'I');
    expect(JSON.parse(r.text)[0].unreadCount).toBe(0);
  });

  it('leaves an untracked chat’s Evolution count untouched', () => {
    const r = enrichChats(res([{ remoteJid: 'a@x', unreadCount: 3 }]), gw({}), 'I');
    expect(JSON.parse(r.text)[0].unreadCount).toBe(3);
  });

  it('matches via the lastMessage alt jid (@lid/phone split)', () => {
    const r = enrichChats(
      res([{ remoteJid: '123@lid', unreadCount: null, lastMessage: { key: { remoteJidAlt: '972@s.whatsapp.net' } } }]),
      gw({ '972@s.whatsapp.net': 1 }),
      'I',
    );
    expect(JSON.parse(r.text)[0].unreadCount).toBe(1);
  });
});
