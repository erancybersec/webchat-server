import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

// default instance matches the test app's EVOLUTION_INSTANCE ('Test'), so these
// counting checks run under the active line; the separation case overrides it.
const upsert = (jid: string, fromMe: boolean, instance = 'Test') => ({
  event: 'messages.upsert',
  data: {
    event: 'messages.upsert',
    instance,
    data: { key: { remoteJid: jid, fromMe, id: `m-${Math.floor(Math.random() * 1e9)}` } },
  },
});

describe('message activity stats', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('counts inbound/outbound per day and distinct active chats', async () => {
    t.relay.broadcast(upsert('111@s.whatsapp.net', false));
    t.relay.broadcast(upsert('111@s.whatsapp.net', false));
    t.relay.broadcast(upsert('111@s.whatsapp.net', true));
    t.relay.broadcast(upsert('222@s.whatsapp.net', true));
    t.relay.broadcast(upsert('status@broadcast', false)); // ignored

    const res = (await t.app.inject({ method: 'GET', url: '/api/analytics/summary?days=7' })).json();
    const today = new Date().toISOString().slice(0, 10);
    expect(res.activity.totals).toEqual({ inbound: 2, outbound: 2, chats: 2 });
    expect(res.activity.perDay).toEqual([{ day: today, inbound: 2, outbound: 2, chats: 2 }]);
    expect(res.activity.since).toBe(today);
  });

  it('reports an empty-but-present activity block when nothing was tracked', async () => {
    const res = (await t.app.inject({ method: 'GET', url: '/api/analytics/summary?days=7' })).json();
    expect(res.activity).toEqual({ perDay: [], totals: { inbound: 0, outbound: 0, chats: 0 }, since: null });
  });

  it('handles bare (test-shaped) records too', async () => {
    t.relay.broadcast({
      event: 'MESSAGES_UPSERT',
      data: { key: { remoteJid: '333@s.whatsapp.net', fromMe: false, id: 'x' } },
    });
    const res = (await t.app.inject({ method: 'GET', url: '/api/analytics/summary?days=7' })).json();
    expect(res.activity.totals.inbound).toBe(1);
  });

  it('honours an explicit from/to range (custom dates)', async () => {
    t.relay.broadcast(upsert('111@s.whatsapp.net', false));
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    // a window that ends before today excludes today's traffic
    const past = (
      await t.app.inject({
        method: 'GET',
        url: `/api/analytics/summary?from=2020-01-01&to=${yesterday}`,
      })
    ).json();
    expect(past.from).toBe('2020-01-01');
    expect(past.to).toBe(yesterday);
    expect(past.activity.totals.inbound).toBe(0);

    // a window that includes today counts it
    const now = (
      await t.app.inject({ method: 'GET', url: `/api/analytics/summary?from=${yesterday}&to=${today}` })
    ).json();
    expect(now.activity.totals.inbound).toBe(1);
    expect(now.days).toBe(2);
  });

  it('separates activity by instance — another line is hidden, blank maps to default', async () => {
    t.relay.broadcast(upsert('111@s.whatsapp.net', false));            // default 'Test'
    t.relay.broadcast(upsert('222@s.whatsapp.net', false, 'Second'));  // other line
    t.relay.broadcast({
      // a blank-instance (legacy) record reads as the default line
      event: 'MESSAGES_UPSERT',
      data: { key: { remoteJid: '333@s.whatsapp.net', fromMe: false, id: 'blank' } },
    });

    // default view: 'Test' + blank, but NOT 'Second'
    const def = (await t.app.inject({ method: 'GET', url: '/api/analytics/summary?days=7' })).json();
    expect(def.activity.totals.inbound).toBe(2);

    // the other line sees only its own
    const other = (
      await t.app.inject({ method: 'GET', url: '/api/analytics/summary?days=7&instance=Second' })
    ).json();
    expect(other.activity.totals.inbound).toBe(1);
  });

  it('falls back to the days preset on a malformed date (no NaN)', async () => {
    // "2026-13-01" matches the digit shape but is not a real day — must not
    // leak NaN into the response; falls back to the default 30-day preset.
    const res = (
      await t.app.inject({ method: 'GET', url: '/api/analytics/summary?from=2026-13-01&to=2026-06-13' })
    ).json();
    expect(res.days).toBe(30);
    expect(Number.isNaN(res.days)).toBe(false);
  });
});
