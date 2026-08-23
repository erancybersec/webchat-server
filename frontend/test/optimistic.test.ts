import { describe, expect, it } from 'vitest';
import { applyLocalDeletes, buildOptimistic, matchReconciled, mergePending, reconcilePending, type PendingSend } from '../src/lib/optimistic';
import type { ChatMsg } from '../src/lib/chatModel';

const JID = '972500000000@s.whatsapp.net';
const NOW = 1_726_000_000_000; // fixed ms epoch
const SEC = Math.round(NOW / 1000);

const real = (over: Partial<ChatMsg> = {}): ChatMsg => ({
  id: 'R1',
  remoteJid: JID,
  fromMe: true,
  timestamp: SEC,
  type: 'text',
  text: '',
  caption: '',
  mimetype: '',
  fileName: '',
  hasMedia: false,
  quoted: null,
  status: 'SERVER_ACK',
  edited: false,
  pushName: '',
  senderJid: '',
  reactionTargetId: '',
  editTargetId: '',
  editHistory: [],
  deletedBySender: false,
  ...over,
});

describe('buildOptimistic', () => {
  it('populates every required ChatMsg field for a text temp', () => {
    const t = buildOptimistic({ tmpId: 'tmp-1', type: 'text', text: 'hi', remoteJid: JID, item: { type: 'text', data: { text: 'hi' } }, now: NOW });
    expect(t.id).toBe('tmp-1');
    expect(t.id.startsWith('tmp-')).toBe(true);
    expect(t.fromMe).toBe(true);
    expect(t.optimistic).toBe(true);
    expect(t.status).toBe('PENDING');
    expect(t.timestamp).toBe(SEC); // seconds, not ms
    expect(t.editHistory).toEqual([]);
    expect(t.serverId).toBeUndefined();
    expect(t.item).toEqual({ type: 'text', data: { text: 'hi' } });
    expect(t.createdAt).toBe(NOW);
  });

  it('carries quoted + media fields through', () => {
    const q = { id: 'Q', text: 'orig', fromMe: false, participant: 'a@s.whatsapp.net' };
    const t = buildOptimistic({ tmpId: 'tmp-2', type: 'image', caption: 'cap', mimetype: 'image/png', hasMedia: true, localPreviewUrl: 'blob:x', remoteJid: JID, quoted: q, item: { type: 'media', data: {} }, now: NOW });
    expect(t.type).toBe('image');
    expect(t.caption).toBe('cap');
    expect(t.hasMedia).toBe(true);
    expect(t.localPreviewUrl).toBe('blob:x');
    expect(t.quoted).toEqual(q);
  });
});

describe('mergePending', () => {
  it('returns the same reference when no pending', () => {
    const server = [real()];
    expect(mergePending(server, [])).toBe(server);
  });

  it('appends temps and sorts ascending by timestamp', () => {
    const server = [real({ id: 'A', timestamp: SEC - 10 })];
    const t = buildOptimistic({ tmpId: 'tmp-1', type: 'text', text: 'hi', remoteJid: JID, item: { type: 'text', data: {} }, now: NOW });
    const out = mergePending(server, [t]);
    expect(out.map((m) => m.id)).toEqual(['A', 'tmp-1']);
  });

  it('places an in-flight temp at the bottom even when the device clock is behind', () => {
    // Device clock is 60s BEHIND the server: the just-sent temp is stamped SEC
    // but a recent server row reads SEC+60. A plain timestamp sort would drop the
    // temp ABOVE that server row (the "not good from the start" bug); appending
    // pending keeps it at the bottom regardless.
    const recent = real({ id: 'recent', timestamp: SEC + 60 });
    const t = buildOptimistic({ tmpId: 'tmp-1', type: 'text', text: 'hi', remoteJid: JID, item: { type: 'text', data: {} }, now: NOW });
    expect(mergePending([recent], [t]).map((m) => m.id)).toEqual(['recent', 'tmp-1']);
  });

  it('keeps multiple temps in send order, all after the server rows', () => {
    const s = [real({ id: 'A', timestamp: SEC - 5 }), real({ id: 'B', timestamp: SEC + 99 })];
    const t1 = buildOptimistic({ tmpId: 'tmp-1', type: 'text', text: '1', remoteJid: JID, item: { type: 'text', data: {} }, now: NOW });
    const t2 = buildOptimistic({ tmpId: 'tmp-2', type: 'text', text: '2', remoteJid: JID, item: { type: 'text', data: {} }, now: NOW + 1000 });
    expect(mergePending(s, [t2, t1]).map((m) => m.id)).toEqual(['A', 'B', 'tmp-1', 'tmp-2']);
  });
});

describe('matchReconciled — links a temp to its real row by either path', () => {
  it('matches by serverId when present', () => {
    const t = temp({ status: 'SENT_SERVER', serverId: 'X' });
    expect(matchReconciled(t, [real({ id: 'X' }), real({ id: 'Y' })])?.id).toBe('X');
  });
  it('falls back to content+time when there is no serverId (messageId-less send)', () => {
    const t = temp({ status: 'SENT_SERVER', text: 'hi', serverId: undefined });
    expect(matchReconciled(t, [real({ id: 'R', text: 'hi', timestamp: SEC + 30 })])?.id).toBe('R');
  });
  it('returns undefined when nothing matches', () => {
    const t = temp({ status: 'SENT_SERVER', text: 'hi', serverId: undefined });
    expect(matchReconciled(t, [real({ id: 'R', text: 'different' })])).toBeUndefined();
  });
});

const temp = (over: Partial<PendingSend> = {}): PendingSend => ({
  ...buildOptimistic({ tmpId: over.id ?? 'tmp-1', type: 'text', text: 'hi', remoteJid: JID, item: { type: 'text', data: {} }, now: NOW }),
  ...over,
});

describe('reconcilePending — by serverId (primary path)', () => {
  it('drops a SENT_SERVER temp once a record with its serverId arrives', () => {
    const t = temp({ status: 'SENT_SERVER', serverId: 'X' });
    expect(reconcilePending([t], [real({ id: 'X' })], NOW)).toEqual([]);
  });

  it('keeps it when no matching id, regardless of clock skew / content', () => {
    const t = temp({ status: 'SENT_SERVER', serverId: 'X', text: 'hi' });
    // a real fromMe message with same text but DIFFERENT id and a far-future ts
    const out = reconcilePending([t], [real({ id: 'OTHER', text: 'hi', timestamp: SEC + 99999 })], NOW);
    expect(out).toEqual([t]); // id path ignores content/timestamp entirely
  });
});

describe('reconcilePending — content fallback (no serverId)', () => {
  it('drops on matching fromMe text within window', () => {
    const t = temp({ status: 'SENT_SERVER', text: 'hi' });
    expect(reconcilePending([t], [real({ id: 'R', text: 'hi', timestamp: SEC + 200 })], NOW)).toEqual([]);
  });

  it('does NOT drop on differing text / incoming / wrong type / out-of-window', () => {
    const base = { status: 'SENT_SERVER' as const, text: 'hi' };
    expect(reconcilePending([temp(base)], [real({ text: 'bye' })], NOW)).toHaveLength(1);
    expect(reconcilePending([temp(base)], [real({ text: 'hi', fromMe: false })], NOW)).toHaveLength(1);
    expect(reconcilePending([temp(base)], [real({ text: 'hi', type: 'image' })], NOW)).toHaveLength(1);
    expect(reconcilePending([temp(base)], [real({ text: 'hi', type: 'reaction' })], NOW)).toHaveLength(1);
    expect(reconcilePending([temp(base)], [real({ text: 'hi', timestamp: SEC + 9999 })], NOW)).toHaveLength(1);
  });

  it('trims whitespace when matching', () => {
    const t = temp({ status: 'SENT_SERVER', text: ' hi ' });
    expect(reconcilePending([t], [real({ id: 'R', text: 'hi' })], NOW)).toEqual([]);
  });

  it('matches media by caption', () => {
    const t = temp({ status: 'SENT_SERVER', type: 'image', text: '', caption: 'cap' });
    expect(reconcilePending([t], [real({ id: 'R', type: 'image', caption: 'cap' })], NOW)).toEqual([]);
  });

  it('FIFO: one real arrival drops the OLDER of two identical temps', () => {
    const t0 = temp({ id: 'tmp-0', status: 'SENT_SERVER', text: 'ok', createdAt: NOW - 1000 });
    const t1 = temp({ id: 'tmp-1', status: 'SENT_SERVER', text: 'ok', createdAt: NOW });
    const out = reconcilePending([t0, t1], [real({ id: 'R', text: 'ok' })], NOW);
    expect(out.map((p) => p.id)).toEqual(['tmp-1']); // older consumed, newer stays
  });
});

describe('reconcilePending — sticky + TTL + stability', () => {
  it('keeps a genuinely FAILED temp (no covering row) and SKIPPED, past TTL', () => {
    const failed = temp({ id: 'f', status: 'FAILED', serverId: 'X', text: 'nope', createdAt: NOW - 999_999 });
    const skipped = temp({ id: 's', status: 'SKIPPED', text: 'hi', createdAt: NOW - 999_999 });
    // no real row covers 'f' (no id X, different text); 'hi' would match but SKIPPED is sticky
    const out = reconcilePending([failed, skipped], [real({ id: 'R', text: 'hi' })], NOW);
    expect(out.map((p) => p.id).sort()).toEqual(['f', 's']);
  });

  it('drops a FAILED temp once a real row covers it — a timed-out send that actually went through', () => {
    // by serverId: the response arrived late, real row landed under that id
    const byId = temp({ id: 'f1', status: 'FAILED', serverId: 'X', createdAt: NOW - 999_999 });
    expect(reconcilePending([byId], [real({ id: 'X' })], NOW)).toEqual([]);
    // by content+timestamp: the timeout aborted before any id, but the text matches
    const byContent = temp({ id: 'f2', status: 'FAILED', text: 'sent anyway', createdAt: NOW });
    expect(reconcilePending([byContent], [real({ id: 'R', text: 'sent anyway' })], NOW)).toEqual([]);
  });

  it('keeps SKIPPED sticky even when content matches a real row', () => {
    const skipped = temp({ id: 's', status: 'SKIPPED', text: 'hi' });
    expect(reconcilePending([skipped], [real({ id: 'R', text: 'hi' })], NOW)).toHaveLength(1);
  });

  it('TTL-prunes a stale PENDING temp with no match', () => {
    const old = temp({ status: 'PENDING', createdAt: NOW - 121_000 });
    const fresh = temp({ id: 'tmp-2', status: 'PENDING', createdAt: NOW - 119_000 });
    expect(reconcilePending([old], [], NOW)).toEqual([]);
    expect(reconcilePending([fresh], [], NOW)).toHaveLength(1);
  });

  it('returns the identical array reference when nothing changes', () => {
    const t = temp({ status: 'PENDING', createdAt: NOW });
    const arr = [t];
    expect(reconcilePending(arr, [], NOW)).toBe(arr);
  });
});

describe('applyLocalDeletes — optimistic app-side delete', () => {
  const ld = (text: string, caption: string, type: string) => ({ text, caption, type, by: 'Eran' });

  it('flips a matching message to a deleted tombstone carrying its pre-delete text', () => {
    const records = [real({ id: 'R1', text: 'see you at 3' })];
    const out = applyLocalDeletes(records, new Map([['R1', ld('see you at 3', '', 'text')]]));
    expect(out[0]!.deletedBySender).toBe(true);
    expect(out[0]!.text).toBe(''); // content cleared, like the real nulled record
    expect(out[0]!.deletedOriginalText).toBe('see you at 3');
  });

  it('clears media + keeps a media type label for a deleted photo', () => {
    const records = [real({ id: 'R1', type: 'image', caption: 'pic', hasMedia: true })];
    const out = applyLocalDeletes(records, new Map([['R1', ld('', 'pic', 'image')]]));
    expect(out[0]!.hasMedia).toBe(false);
    expect(out[0]!.deletedOriginalType).toBe('image');
    expect(out[0]!.deletedOriginalCaption).toBe('pic');
  });

  it('is a no-op (same reference) with an empty map or no matching id', () => {
    const records = [real({ id: 'R1' })];
    expect(applyLocalDeletes(records, new Map())).toBe(records);
    expect(applyLocalDeletes(records, new Map([['OTHER', ld('x', '', 'text')]]))).toBe(records);
  });

  it('leaves a server-confirmed delete untouched (prefers the real deletedOriginal)', () => {
    const records = [real({ id: 'R1', deletedBySender: true, deletedOriginalText: 'from server' })];
    const out = applyLocalDeletes(records, new Map([['R1', ld('stale local', '', 'text')]]));
    expect(out[0]!.deletedOriginalText).toBe('from server');
  });
});
