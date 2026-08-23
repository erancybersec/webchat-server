import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

describe('/api/notify-prefs + /api/push/test', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('GET returns defaults; PUT round-trips and validates HH:MM', async () => {
    const def = (await t.app.inject({ method: 'GET', url: '/api/notify-prefs' })).json();
    expect(def).toEqual({
      groups: true,
      dms: true,
      jobsEnded: true,
      jobsFailuresOnly: false,
      quietEnabled: false,
      quietStart: '21:00',
      quietEnd: '08:00',
      keywords: '',
    });

    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/notify-prefs',
      payload: { groups: false, quietEnabled: true, quietStart: '22:00', keywords: '  urgent  ' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      groups: false,
      dms: true, // unspecified → kept
      quietEnabled: true,
      quietStart: '22:00',
      keywords: 'urgent', // trimmed
    });

    // persisted across requests
    const after = (await t.app.inject({ method: 'GET', url: '/api/notify-prefs' })).json();
    expect(after.groups).toBe(false);
    expect(after.quietStart).toBe('22:00');

    // a malformed time is rejected
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/notify-prefs',
      payload: { quietStart: '9am' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('POST /api/push/test reports devices reached (0 with none subscribed)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/push/test', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: 0 });
  });
});
