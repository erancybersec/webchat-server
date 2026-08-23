import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { enrichMessages } from '../src/routes/gateway.js';
import { ReadReceiptStore } from '../src/services/readreceipts.js';

describe('ReadReceiptStore', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('stores and reads back the read time', () => {
    const s = new ReadReceiptStore(db);
    s.markRead('M1', '2026-06-13T10:00:00.000Z');
    expect(s.readAtFor('M1')).toBe('2026-06-13T10:00:00.000Z');
    expect(s.readAtFor('missing')).toBeNull();
    expect(s.readAtFor('')).toBeNull();
  });

  it('keeps the FIRST read time — a re-read must not bump "seen at"', () => {
    const s = new ReadReceiptStore(db);
    s.markRead('M1', '2026-06-13T10:00:00.000Z');
    s.markRead('M1', '2026-06-13T12:30:00.000Z'); // later re-open, ignored
    expect(s.readAtFor('M1')).toBe('2026-06-13T10:00:00.000Z');
  });

  it('ignores an empty id', () => {
    const s = new ReadReceiptStore(db);
    s.markRead('', '2026-06-13T10:00:00.000Z');
    expect(s.readAtFor('')).toBeNull();
  });
});

describe('enrichMessages — read receipts', () => {
  const cache = { originalFor: () => null, versionsFor: () => [] };
  const jsonResponse = (records: unknown[]) => ({
    status: 200,
    ok: true,
    contentType: 'application/json',
    text: JSON.stringify({ messages: { records } }),
  });
  const reads = (map: Record<string, string>) => ({ readAtFor: (id: string) => map[id] ?? null });

  it('attaches readAt to a sent message the recipient read', () => {
    const r = jsonResponse([
      { key: { id: 'M1', remoteJid: 'c@x', fromMe: true }, message: { conversation: 'hi' } },
    ]);
    const out = enrichMessages(r, cache, reads({ M1: '2026-06-13T10:00:00.000Z' }));
    const rec = JSON.parse(out.text).messages.records[0];
    expect(rec.readAt).toBe('2026-06-13T10:00:00.000Z');
  });

  it('does not attach readAt to incoming messages (they get no READ ack from us)', () => {
    const r = jsonResponse([
      { key: { id: 'M2', remoteJid: 'c@x', fromMe: false }, message: { conversation: 'yo' } },
    ]);
    const out = enrichMessages(r, cache, reads({ M2: '2026-06-13T10:00:00.000Z' }));
    const rec = JSON.parse(out.text).messages.records[0];
    expect(rec.readAt).toBeUndefined();
  });

  it('leaves a sent message unchanged when there is no recorded read', () => {
    const r = jsonResponse([
      { key: { id: 'M3', remoteJid: 'c@x', fromMe: true }, message: { conversation: 'hi' } },
    ]);
    const out = enrichMessages(r, cache, reads({}));
    const rec = JSON.parse(out.text).messages.records[0];
    expect(rec.readAt).toBeUndefined();
  });
});
