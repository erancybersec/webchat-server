import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

describe('/api/blacklist', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('adds a single entry, normalizing the phone', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/blacklist',
      payload: { phone_number: '052-987-6543', name: 'Test', why_blacklisted: 'spam' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, added: 1, invalid: [] });

    const list = (await t.app.inject({ method: 'GET', url: '/api/blacklist' })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ phone_number: '972529876543', name: 'Test', why_blacklisted: 'spam' });
  });

  it('adds bulk rows and bare numbers, reporting invalid ones', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/blacklist',
      payload: { rows: [{ phone_number: '0529876543' }, { phone_number: 'garbage' }] },
    });
    expect(res.json()).toMatchObject({ added: 1, invalid: ['garbage'] });

    const res2 = await t.app.inject({
      method: 'POST',
      url: '/api/blacklist',
      payload: { numbers: ['0521111111', '0522222222'] },
    });
    expect(res2.json()).toMatchObject({ added: 2 });
  });

  it('re-adding refreshes name/reason but keeps added_date', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/blacklist',
      payload: { phone_number: '0529876543', name: 'Old', added_date: '2020-01-01' },
    });
    await t.app.inject({
      method: 'POST',
      url: '/api/blacklist',
      payload: { phone_number: '0529876543', name: 'New' },
    });
    const [entry] = (await t.app.inject({ method: 'GET', url: '/api/blacklist' })).json();
    expect(entry).toMatchObject({ name: 'New', added_date: '2020-01-01' });
  });

  it('updates an entry and detects conflicts', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/blacklist',
      payload: { numbers: ['0521111111', '0522222222'] },
    });
    const ok = await t.app.inject({
      method: 'PUT',
      url: '/api/blacklist/972521111111',
      payload: { name: 'Renamed' },
    });
    expect(ok.json()).toMatchObject({ phone_number: '972521111111', name: 'Renamed' });

    const conflict = await t.app.inject({
      method: 'PUT',
      url: '/api/blacklist/972521111111',
      payload: { phone_number: '0522222222' },
    });
    expect(conflict.statusCode).toBe(409);

    const missing = await t.app.inject({
      method: 'PUT',
      url: '/api/blacklist/972529999999',
      payload: { name: 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('deletes single and bulk', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/blacklist',
      payload: { numbers: ['0521111111', '0522222222', '0523333333'] },
    });
    await t.app.inject({ method: 'DELETE', url: '/api/blacklist/972521111111' });
    const bulk = await t.app.inject({
      method: 'POST',
      url: '/api/blacklist/delete',
      payload: { phones: ['972522222222', '972523333333'] },
    });
    expect(bulk.json()).toMatchObject({ removed: 2 });
    expect((await t.app.inject({ method: 'GET', url: '/api/blacklist' })).json()).toHaveLength(0);
  });

  it('deletes and updates accept any input form of a stored number', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/blacklist',
      payload: { numbers: ['0521111111', '0522222222'] }, // stored as 972…
    });
    // local 05X form must find the normalized entry
    await t.app.inject({ method: 'DELETE', url: '/api/blacklist/052-111-1111' });
    expect((await t.app.inject({ method: 'GET', url: '/api/blacklist' })).json()).toHaveLength(1);

    const renamed = await t.app.inject({
      method: 'PUT',
      url: '/api/blacklist/0522222222',
      payload: { name: 'Renamed' },
    });
    expect(renamed.json()).toMatchObject({ phone_number: '972522222222', name: 'Renamed' });
  });

  it('isBlacklisted matches raw and normalized forms, never groups', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/blacklist',
      payload: { phone_number: '0529876543' },
    });
    expect(t.blacklist.isBlacklisted('972529876543')).toBe(true);
    expect(t.blacklist.isBlacklisted('0529876543')).toBe(true);
    expect(t.blacklist.isBlacklisted('+972 52 987 6543')).toBe(true);
    expect(t.blacklist.isBlacklisted('972529876543@g.us')).toBe(false);
    expect(t.blacklist.isBlacklisted('972529999999')).toBe(false);
  });
});
