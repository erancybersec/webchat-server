import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import {
  countSince,
  createToolDispatcher,
  extractInboundText,
  fetchRecentContext,
  type ThreadPage,
  type ThreadReader,
} from '../src/services/aiagent.js';
import {
  MAX_HISTORY_MESSAGES,
  SUMMARY_LOOKBACK_CAP,
  sanitizeLeadContext,
} from '../src/services/aiLimits.js';
import { KnowledgeStore } from '../src/services/knowledge.js';
import { StudioDataStore } from '../src/services/studioData.js';

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

function stores(): { db: Db; studio: StudioDataStore; knowledge: KnowledgeStore } {
  const db = openDb(':memory:');
  return { db, studio: new StudioDataStore(db), knowledge: new KnowledgeStore(db) };
}

describe('StudioDataStore freshness rules', () => {
  it('returns a course/price with no validUntil, but never an offer without one', () => {
    const { studio } = stores();
    studio.create({ title: 'Ballet A', price: '120', validUntil: null });
    studio.create({ title: 'Open-ended discount', price: '90', isOffer: true, validUntil: null });
    studio.create({ title: 'Summer deal', price: '80', isOffer: true, validUntil: iso(Date.now() + 7 * DAY) });

    expect(studio.courses()).toMatchObject({ status: 'ok' });
    expect(studio.prices()).toMatchObject({ status: 'ok' });
    const offers = studio.offers();
    expect(offers.status).toBe('ok');
    const titles = (offers as { results: Array<{ title: string }> }).results.map((r) => r.title);
    // an open-ended discount is exactly the stale claim the rule prevents
    expect(titles).toEqual(['Summer deal']);
  });

  it('drops an expired course and an expired offer', () => {
    const { studio } = stores();
    const yesterday = iso(Date.now() - DAY);
    studio.create({ title: 'Ended course', price: '1', validUntil: yesterday });
    studio.create({ title: 'Ended offer', price: '1', isOffer: true, validUntil: yesterday });
    expect(studio.courses()).toEqual({ status: 'unknown' });
    expect(studio.offers()).toEqual({ status: 'unknown' });
  });

  it('keys availability off availability_updated_at, NOT the row updated_at', () => {
    const { studio } = stores();
    const weekAgo = new Date(Date.now() - 7 * DAY);
    const row = studio.create({ title: 'Hip hop', spotsLeft: 3 }, weekAgo);
    // a week-old count is not quotable
    expect(studio.availability()).toEqual({ status: 'unknown' });

    // editing an UNRELATED field must not make it look freshly checked
    studio.update(row.id, { notes: 'moved to studio 2', price: '150' });
    expect(studio.byId(row.id)!.updatedAt > weekAgo.toISOString()).toBe(true);
    expect(studio.availability()).toEqual({ status: 'unknown' });

    // only an actual recheck does
    studio.recheckAvailability(row.id, 3);
    const fresh = studio.availability();
    expect(fresh.status).toBe('ok');
    expect((fresh as { results: Array<{ spots_left: number }> }).results[0]!.spots_left).toBe(3);
  });

  it('a spotsLeft edit through update() also counts as a recheck', () => {
    const { studio } = stores();
    const row = studio.create({ title: 'Jazz', spotsLeft: 5 }, new Date(Date.now() - 7 * DAY));
    expect(studio.availability()).toEqual({ status: 'unknown' });
    studio.update(row.id, { spotsLeft: 4 });
    expect(studio.availability()).toMatchObject({ status: 'ok' });
  });

  it('recheckAvailability(null) stops tracking rather than reporting zero', () => {
    const { studio } = stores();
    const row = studio.create({ title: 'Jazz', spotsLeft: 5 });
    expect(studio.availability()).toMatchObject({ status: 'ok' });
    studio.recheckAvailability(row.id, null);
    expect(studio.byId(row.id)!.availabilityUpdatedAt).toBeNull();
    expect(studio.availability()).toEqual({ status: 'unknown' });
  });

  it('fails CLOSED on an invalid enum instead of broadening the query', () => {
    const { studio } = stores();
    studio.create({ title: 'Adults only', ageGroup: 'adult', price: '200' });
    studio.create({ title: 'Kids class', ageGroup: 'child', price: '100' });

    for (const bad of [
      studio.courses({ ageGroup: 'kids' }),
      studio.prices({ ageGroup: 'KIDS' }),
      studio.offers({ dayOfWeek: 'monday' }),
      studio.availability({ ageGroup: 'toddler' }),
    ]) {
      expect(bad.status).toBe('invalid_request');
      expect((bad as { error: string }).error).toBeTruthy();
      // crucially, NOT a result set the model would answer from
      expect(bad).not.toHaveProperty('results');
    }
  });

  it('matches a valid age_group exactly, and treats a blank row as all ages', () => {
    const { studio } = stores();
    studio.create({ title: 'Adults only', ageGroup: 'adult', price: '200' });
    studio.create({ title: 'Kids class', ageGroup: 'child', price: '100' });
    studio.create({ title: 'Everyone', ageGroup: '', price: '150' });
    const r = studio.prices({ ageGroup: 'child' }) as { results: Array<{ title: string }> };
    expect(r.results.map((x) => x.title).sort()).toEqual(['Everyone', 'Kids class']);
  });

  it('matches branch/level case-insensitively but exactly (no LIKE wildcards)', () => {
    const { studio } = stores();
    studio.create({ title: 'A', branch: 'Center', level: 'Beginner', price: '1' });
    expect(studio.prices({ branch: 'center' })).toMatchObject({ status: 'ok' });
    // a wildcard is a literal here, not a pattern
    expect(studio.prices({ branch: 'Cen%' })).toEqual({ status: 'unknown' });
    expect(studio.prices({ level: '_eginner' })).toEqual({ status: 'unknown' });
  });

  it('an inactive row is invisible to every tool', () => {
    const { studio } = stores();
    const row = studio.create({ title: 'Paused class', price: '1', spotsLeft: 2 });
    studio.update(row.id, { active: false });
    expect(studio.courses()).toEqual({ status: 'unknown' });
    expect(studio.prices()).toEqual({ status: 'unknown' });
    expect(studio.availability()).toEqual({ status: 'unknown' });
  });
});

describe('tool dispatcher', () => {
  it('search_knowledge scores keyword hits and reports the ids used', () => {
    const { knowledge, studio } = stores();
    const trial = knowledge.create({
      title: 'Trial class',
      content: 'The first trial class is free.',
      keywords: 'trial, free, first',
    });
    knowledge.create({ title: 'Parking', content: 'Street parking only.', keywords: 'parking' });
    const d = createToolDispatcher(knowledge, studio);
    const hit = d.dispatch('search_knowledge', { query: 'is the trial free?' });
    expect(hit.knowledgeIds).toEqual([trial.id]);
    expect(hit.result).toMatchObject({ status: 'ok' });
    expect(d.dispatch('search_knowledge', { query: 'zzzz' }).result).toEqual({ status: 'unknown' });
    expect(d.dispatch('search_knowledge', { query: '  ' }).result).toMatchObject({
      status: 'invalid_request',
    });
    expect(d.dispatch('delete_everything', {}).result).toMatchObject({ status: 'invalid_request' });
  });
});

describe('LeadContext allowlist', () => {
  it('keeps only the closed shape, with the documented limits', () => {
    expect(
      sanitizeLeadContext({
        name: ' Dana '.padEnd(200, 'x'),
        age_group: 'teen',
        experience_level: 'expert',
        preferred_days: ['sun', 'sun', 'funday', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
        preferred_times: Array.from({ length: 20 }, (_, i) => `t${i}`),
        trial_interest: 'yes',
        favourite_colour: 'blue',
      }),
    ).toEqual({
      name: expect.stringMatching(/^Dana/),
      age_group: 'teen',
      experience_level: null, // out of enum → dropped, never stored raw
      preferred_days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
      preferred_times: expect.any(Array),
      trial_interest: null,
    });
    expect(sanitizeLeadContext({ name: 'x'.repeat(300) }).name).toHaveLength(100);
    expect(sanitizeLeadContext({ preferred_times: Array.from({ length: 20 }, (_, i) => `t${i}`) })
      .preferred_times).toHaveLength(10);
    expect(sanitizeLeadContext('nonsense')).toEqual({});
  });
});

// ---------------------------------------------------------------------------

const record = (id: string, ts: number, text: string, fromMe = false) => ({
  key: { id, remoteJid: '972500000000@s.whatsapp.net', fromMe },
  messageTimestamp: ts,
  message: { conversation: text },
});

/** Pages of 50, newest first — how chat/findMessages actually behaves. */
function pagedReader(all: Array<Record<string, any>>, perPage = 50): ThreadReader & { calls: number[] } {
  const desc = [...all].sort((a, b) => b.messageTimestamp - a.messageTimestamp);
  const pages = Math.max(1, Math.ceil(desc.length / perPage));
  const reader = {
    calls: [] as number[],
    async page(_i: string, _j: string, page: number): Promise<ThreadPage> {
      reader.calls.push(page);
      return { records: desc.slice((page - 1) * perPage, page * perPage), pages };
    },
  };
  return reader;
}

describe('context assembly', () => {
  it('extracts inbound text and flags anything non-text as media', () => {
    expect(extractInboundText({ message: { conversation: ' hi ' } })).toEqual({
      text: 'hi',
      kind: 'text',
    });
    expect(extractInboundText({ message: { extendedTextMessage: { text: 'yo' } } }).kind).toBe('text');
    expect(extractInboundText({ message: { imageMessage: { caption: 'look' } } }).kind).toBe('text');
    expect(extractInboundText({ message: { audioMessage: { seconds: 3 } } }).kind).toBe('media');
    expect(extractInboundText({ message: { imageMessage: {} } }).kind).toBe('media');
    expect(extractInboundText({}).kind).toBe('media');
  });

  it('the reply window is the last few messages, oldest first', async () => {
    const msgs = Array.from({ length: 20 }, (_, i) => record(`m${i}`, 1000 + i, `msg ${i}`));
    const reader = pagedReader(msgs);
    const ctx = await fetchRecentContext(reader, 'Test', 'jid');
    expect(reader.calls).toEqual([1]); // page 1 only — the newest slice
    expect(ctx.turns).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(ctx.turns.map((t) => t.text)).toEqual(['msg 14', 'msg 15', 'msg 16', 'msg 17', 'msg 18', 'msg 19']);
    expect(ctx.throughMessageId).toBe('m19');
  });

  it('countSince walks backwards to the cursor, over pages, and reports the newest id', async () => {
    const msgs = Array.from({ length: 120 }, (_, i) => record(`m${i}`, 1000 + i, `msg ${i}`));
    const reader = pagedReader(msgs);
    const since = await countSince(reader, 'Test', 'jid', 'm100');
    // 19 messages are newer than m100 (m101..m119)
    expect(since.count).toBe(19);
    expect(since.messages[0]!.text).toBe('msg 101');
    expect(since.newestMessageId).toBe('m119');
    expect(since.truncated).toBe(false);
    expect(reader.calls).toEqual([1]); // the cursor was on page 1; no needless fan-out

    // a cursor far back forces the walk across pages, capped
    const deep = pagedReader(msgs, 20);
    const far = await countSince(deep, 'Test', 'jid', 'm0');
    expect(far.count).toBe(SUMMARY_LOOKBACK_CAP);
    expect(far.truncated).toBe(true);
    expect(deep.calls.length).toBeGreaterThan(1);
  });

  it('countSince with no cursor counts the whole (capped) thread', async () => {
    const msgs = Array.from({ length: 8 }, (_, i) => record(`m${i}`, 1000 + i, `msg ${i}`));
    const since = await countSince(pagedReader(msgs), 'Test', 'jid', null);
    expect(since.count).toBe(8);
    expect(since.newestMessageId).toBe('m7');
  });
});
