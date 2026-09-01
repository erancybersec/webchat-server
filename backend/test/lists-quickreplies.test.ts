import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

describe('/api/lists', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('creates a list with normalized members and reports invalid ones', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/lists',
      payload: {
        name: 'VIP',
        members: [
          { recipient: '052-111-1111', name: 'Dana' },
          { recipient: '123@g.us', name: 'Team' },
          { recipient: 'not-a-phone' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ name: 'VIP', members: 2, invalid: ['not-a-phone'] });

    const detail = (
      await t.app.inject({ method: 'GET', url: `/api/lists/${body.id}` })
    ).json();
    expect(detail.members).toEqual([
      { recipient: '972521111111', isGroup: false, name: 'Dana' },
      { recipient: '123@g.us', isGroup: true, name: 'Team' },
    ]);
  });

  it('lists include member counts; rename and member replace work', async () => {
    const created = (
      await t.app.inject({
        method: 'POST',
        url: '/api/lists',
        payload: { name: 'A', members: [{ recipient: '0521111111' }] },
      })
    ).json();

    const updated = await t.app.inject({
      method: 'PUT',
      url: `/api/lists/${created.id}`,
      payload: { name: 'B', members: [{ recipient: '0522222222' }, { recipient: '0523333333' }] },
    });
    expect(updated.json()).toMatchObject({ name: 'B', members: 2 });

    const all = (await t.app.inject({ method: 'GET', url: '/api/lists' })).json();
    expect(all).toEqual([expect.objectContaining({ name: 'B', memberCount: 2 })]);
  });

  it('rejects empty names and 404s on unknown ids', async () => {
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/lists', payload: { name: ' ' } })).statusCode,
    ).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/lists/nope' })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/lists/nope' })).statusCode).toBe(404);
  });

  it('stores the recipe of a combined list next to the members it produced', async () => {
    const created = (
      await t.app.inject({
        method: 'POST',
        url: '/api/lists',
        payload: {
          name: 'Leads minus actives',
          members: [{ recipient: '0521111111', name: 'Dana' }],
          recipe: {
            v: 1,
            include: [{ id: 'list_a', name: 'Leads' }],
            exclude: [{ id: 'list_b', name: 'Actives' }],
          },
        },
      })
    ).json();
    expect(created).toMatchObject({ memberCount: 1 });
    expect(created.recipe).toEqual({
      v: 1,
      include: [{ id: 'list_a', name: 'Leads' }],
      exclude: [{ id: 'list_b', name: 'Actives' }],
    });

    // survives a round-trip through both read paths
    const all = (await t.app.inject({ method: 'GET', url: '/api/lists' })).json();
    expect(all[0].recipe.include).toEqual([{ id: 'list_a', name: 'Leads' }]);
    const detail = (
      await t.app.inject({ method: 'GET', url: `/api/lists/${created.id}` })
    ).json();
    expect(detail.recipe.exclude).toEqual([{ id: 'list_b', name: 'Actives' }]);

    // a rebuild replaces the members and keeps the recipe
    const rebuilt = (
      await t.app.inject({
        method: 'PUT',
        url: `/api/lists/${created.id}`,
        payload: { members: [{ recipient: '0522222222' }, { recipient: '0523333333' }], recipe: detail.recipe },
      })
    ).json();
    expect(rebuilt).toMatchObject({ memberCount: 2 });
    expect(rebuilt.recipe.include).toEqual([{ id: 'list_a', name: 'Leads' }]);

    // recipe: null freezes it into a plain hand-made list, members intact
    const frozen = (
      await t.app.inject({
        method: 'PUT',
        url: `/api/lists/${created.id}`,
        payload: { recipe: null },
      })
    ).json();
    expect(frozen).toMatchObject({ memberCount: 2, recipe: null });
  });

  it('drops an unusable recipe without touching the members', async () => {
    const bad = [
      { v: 1, include: [], exclude: [{ id: 'list_b', name: 'B' }] }, // nothing to subtract from
      { include: 'not-an-array' },
      'garbage',
      42,
    ];
    for (const recipe of bad) {
      const res = (
        await t.app.inject({
          method: 'POST',
          url: '/api/lists',
          payload: { name: `r-${JSON.stringify(recipe)}`, members: [{ recipient: '0521111111' }], recipe },
        })
      ).json();
      expect(res).toMatchObject({ memberCount: 1, recipe: null });
    }
  });

  it('refuses to let a list build on itself', async () => {
    const created = (
      await t.app.inject({ method: 'POST', url: '/api/lists', payload: { name: 'self' } })
    ).json();
    const updated = (
      await t.app.inject({
        method: 'PUT',
        url: `/api/lists/${created.id}`,
        payload: {
          recipe: {
            v: 1,
            include: [{ id: created.id, name: 'self' }, { id: 'list_a', name: 'A' }],
            exclude: [{ id: created.id, name: 'self' }],
          },
        },
      })
    ).json();
    expect(updated.recipe).toEqual({ v: 1, include: [{ id: 'list_a', name: 'A' }], exclude: [] });
  });

  it('a hand-made list reports no recipe', async () => {
    const created = (
      await t.app.inject({
        method: 'POST',
        url: '/api/lists',
        payload: { name: 'plain', members: [{ recipient: '0521111111' }] },
      })
    ).json();
    expect(created.recipe).toBeNull();
  });

  it('deleting a list removes its members with it', async () => {
    const created = (
      await t.app.inject({
        method: 'POST',
        url: '/api/lists',
        payload: { name: 'gone', members: [{ recipient: '0521111111' }] },
      })
    ).json();
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/lists/${created.id}` })).statusCode,
    ).toBe(200);
    const orphans = t.db
      .prepare(`SELECT COUNT(*) AS n FROM recipient_list_members`)
      .get() as { n: number };
    expect(orphans.n).toBe(0);
  });
});

describe('/api/lists — per-line visibility', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  const HDR = (email: string) => ({ 'cf-access-authenticated-user-email': email });
  const enable = () =>
    t.app.inject({ method: 'PUT', url: '/api/settings', payload: { agentsEnabled: true } });
  /** First request bootstraps the admin; the rest provision plain agents. */
  const provision = async (...emails: string[]) => {
    await enable();
    await t.app.inject({ method: 'GET', url: '/api/me', headers: HDR('admin@x.com') });
    for (const e of emails) await t.app.inject({ method: 'GET', url: '/api/me', headers: HDR(e) });
  };
  const grant = (email: string, instances: string[]) =>
    t.app.inject({
      method: 'PUT',
      url: `/api/agents/${encodeURIComponent(email)}`,
      headers: HDR('admin@x.com'),
      payload: { instances },
    });

  it('a new list defaults to the line it was created on, and stays off other lines', async () => {
    const onSecond = (
      await t.app.inject({
        method: 'POST',
        url: '/api/lists?instance=Second',
        payload: { name: 'Second-only' },
      })
    ).json();
    expect(onSecond.lineScope).toEqual(['Second']);

    const onDefault = (
      await t.app.inject({ method: 'POST', url: '/api/lists', payload: { name: 'Default-only' } })
    ).json();
    expect(onDefault.lineScope).toEqual(['Test']);

    const seenOnSecond = (
      await t.app.inject({ method: 'GET', url: '/api/lists?instance=Second' })
    ).json();
    expect(seenOnSecond.map((l: any) => l.name)).toEqual(['Second-only']);

    const seenOnDefault = (await t.app.inject({ method: 'GET', url: '/api/lists' })).json();
    expect(seenOnDefault.map((l: any) => l.name)).toEqual(['Default-only']);
  });

  it('an admin can widen a list to every line', async () => {
    const created = (
      await t.app.inject({ method: 'POST', url: '/api/lists', payload: { name: 'Widened' } })
    ).json();
    expect((await t.app.inject({ method: 'GET', url: '/api/lists?instance=Second' })).json()).toEqual([]);

    const updated = await t.app.inject({
      method: 'PUT',
      url: `/api/lists/${created.id}`,
      payload: { lineScope: null },
    });
    expect(updated.json().lineScope).toBeNull();

    const nowOnSecond = (
      await t.app.inject({ method: 'GET', url: '/api/lists?instance=Second' })
    ).json();
    expect(nowOnSecond.map((l: any) => l.name)).toEqual(['Widened']);
  });

  it('a non-admin creator can only grant lines they themselves can see', async () => {
    await provision('agent@x.com');
    await grant('agent@x.com', ['Second']);
    const agentHdr = HDR('agent@x.com');

    const created = (
      await t.app.inject({
        method: 'POST',
        url: '/api/lists?instance=Second',
        headers: agentHdr,
        payload: { name: 'Mine' },
      })
    ).json();
    expect(created.lineScope).toEqual(['Second']);

    // can't grant a line outside their own access
    const deniedLine = await t.app.inject({
      method: 'PUT',
      url: `/api/lists/${created.id}`,
      headers: agentHdr,
      payload: { lineScope: ['Test'] },
    });
    expect(deniedLine.statusCode).toBe(403);

    // can't grant "every line" either — that's admin-only
    const deniedAll = await t.app.inject({
      method: 'PUT',
      url: `/api/lists/${created.id}`,
      headers: agentHdr,
      payload: { lineScope: null },
    });
    expect(deniedAll.statusCode).toBe(403);

    // re-affirming a line they do have access to works fine
    const ok = await t.app.inject({
      method: 'PUT',
      url: `/api/lists/${created.id}`,
      headers: agentHdr,
      payload: { lineScope: ['Second'] },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("only an admin or the list's creator may change its scope — everyone else can still edit its name/members", async () => {
    await provision('owner@x.com', 'other@x.com');
    const created = (
      await t.app.inject({
        method: 'POST',
        url: '/api/lists',
        headers: HDR('owner@x.com'),
        payload: { name: 'Owned' },
      })
    ).json();

    const scopeDenied = await t.app.inject({
      method: 'PUT',
      url: `/api/lists/${created.id}`,
      headers: HDR('other@x.com'),
      payload: { lineScope: ['Test'] },
    });
    expect(scopeDenied.statusCode).toBe(403);

    const nameOk = await t.app.inject({
      method: 'PUT',
      url: `/api/lists/${created.id}`,
      headers: HDR('other@x.com'),
      payload: { name: 'Renamed', members: [{ recipient: '0521111111' }] },
    });
    expect(nameOk.statusCode).toBe(200);
    expect(nameOk.json()).toMatchObject({ name: 'Renamed', memberCount: 1, lineScope: ['Test'] });

    // the creator themselves may still manage it, within what they can see —
    // a plain agent with no instance grants only sees the default ('Test')
    const ownerOk = await t.app.inject({
      method: 'PUT',
      url: `/api/lists/${created.id}`,
      headers: HDR('owner@x.com'),
      payload: { lineScope: ['Test'] },
    });
    expect(ownerOk.statusCode).toBe(200);
    expect(ownerOk.json().lineScope).toEqual(['Test']);

    // and granted a second line, the owner can widen onto it too
    await grant('owner@x.com', ['Test', 'Second']);
    const ownerWidened = await t.app.inject({
      method: 'PUT',
      url: `/api/lists/${created.id}`,
      headers: HDR('owner@x.com'),
      payload: { lineScope: ['Test', 'Second'] },
    });
    expect(ownerWidened.statusCode).toBe(200);
    expect(ownerWidened.json().lineScope).toEqual(['Test', 'Second']);
  });

  it('scope=all is the admin roster view; a missing permission falls back to the per-line roster', async () => {
    await provision('agent@x.com');
    await grant('agent@x.com', ['Second']);
    await t.app.inject({ method: 'POST', url: '/api/lists', payload: { name: 'On-Test' } });
    await t.app.inject({
      method: 'POST',
      url: '/api/lists?instance=Second',
      payload: { name: 'On-Second' },
    });

    // no ?instance= → falls back to the server default line, same as
    // quick-replies' identical instanceFilter() convention
    const agentDefault = (
      await t.app.inject({ method: 'GET', url: '/api/lists?scope=all', headers: HDR('agent@x.com') })
    ).json();
    expect(agentDefault.map((l: any) => l.name)).toEqual(['On-Test']);

    // the real frontend always sends the active line explicitly
    const agentOwnLine = (
      await t.app.inject({
        method: 'GET',
        url: '/api/lists?scope=all&instance=Second',
        headers: HDR('agent@x.com'),
      })
    ).json();
    expect(agentOwnLine.map((l: any) => l.name)).toEqual(['On-Second']); // scoped, not everything

    const asAdmin = (
      await t.app.inject({ method: 'GET', url: '/api/lists?scope=all', headers: HDR('admin@x.com') })
    ).json();
    expect(asAdmin.map((l: any) => l.name).sort()).toEqual(['On-Second', 'On-Test']);
  });
});

describe('/api/quick-replies', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('CRUD round-trip', async () => {
    const created = (
      await t.app.inject({
        method: 'POST',
        url: '/api/quick-replies',
        payload: { shortcut: 'hi', text: 'Hello there!' },
      })
    ).json();
    expect(created).toMatchObject({ shortcut: 'hi', text: 'Hello there!' });

    const updated = await t.app.inject({
      method: 'PUT',
      url: `/api/quick-replies/${created.id}`,
      payload: { text: 'Hi!' },
    });
    expect(updated.json()).toMatchObject({ id: created.id, shortcut: 'hi', text: 'Hi!' });

    const all = (await t.app.inject({ method: 'GET', url: '/api/quick-replies' })).json();
    expect(all).toHaveLength(1);

    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/quick-replies/${created.id}` })).statusCode,
    ).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/quick-replies' })).json()).toEqual([]);
  });

  it('bulk import (the localStorage migration) skips empty texts', async () => {
    const res = (
      await t.app.inject({
        method: 'POST',
        url: '/api/quick-replies',
        payload: { rows: [{ shortcut: 'a', text: 'one' }, { shortcut: 'b', text: '  ' }, { text: 'two' }] },
      })
    ).json();
    expect(res).toEqual({ ok: true, added: 2 });
  });

  it('separates quick replies by instance — pinned to the active line on create', async () => {
    // default line (no ?instance=) and another line
    await t.app.inject({
      method: 'POST',
      url: '/api/quick-replies',
      payload: { shortcut: 'def', text: 'default line' },
    });
    const second = (
      await t.app.inject({
        method: 'POST',
        url: '/api/quick-replies?instance=Second',
        payload: { shortcut: 'sec', text: 'second line' },
      })
    ).json();
    expect(second.instance).toBe('Second');

    // default view shows only the default-line reply
    const def = (await t.app.inject({ method: 'GET', url: '/api/quick-replies' })).json();
    expect(def.map((r: { shortcut: string }) => r.shortcut)).toEqual(['def']);

    // the other line shows only its own
    const sec = (
      await t.app.inject({ method: 'GET', url: '/api/quick-replies?instance=Second' })
    ).json();
    expect(sec.map((r: { shortcut: string }) => r.shortcut)).toEqual(['sec']);
  });

  it('attaches media: file bytes stay out of the list and load on demand; url-kind needs no bytes', async () => {
    // file-kind: base64 stored apart from the descriptor
    const withFile = (
      await t.app.inject({
        method: 'POST',
        url: '/api/quick-replies',
        payload: {
          shortcut: 'logo',
          text: '',
          media: { kind: 'file', mediatype: 'image', mimetype: 'image/png', filename: 'logo.png', base64: 'QUJD' },
        },
      })
    ).json();
    // text may be empty when media is present
    expect(withFile).toMatchObject({ shortcut: 'logo', text: '' });
    expect(withFile.media).toEqual({ kind: 'file', mediatype: 'image', mimetype: 'image/png', filename: 'logo.png' });

    // the (polled) list carries the descriptor but never the bytes
    const list = (await t.app.inject({ method: 'GET', url: '/api/quick-replies' })).json();
    expect(JSON.stringify(list)).not.toContain('QUJD');

    // the bytes load on demand
    const media = (await t.app.inject({ method: 'GET', url: `/api/quick-replies/${withFile.id}/media` })).json();
    expect(media).toMatchObject({ base64: 'QUJD', mimetype: 'image/png', mediatype: 'image' });

    // url-kind keeps no bytes
    const withUrl = (
      await t.app.inject({
        method: 'POST',
        url: '/api/quick-replies',
        payload: { shortcut: 'promo', text: 'see this', media: { kind: 'url', mediatype: 'video', mimetype: 'video/mp4', url: 'https://x.test/a.mp4' } },
      })
    ).json();
    expect(withUrl.media).toEqual({ kind: 'url', mediatype: 'video', mimetype: 'video/mp4', url: 'https://x.test/a.mp4' });
    const urlMedia = (await t.app.inject({ method: 'GET', url: `/api/quick-replies/${withUrl.id}/media` })).json();
    expect(urlMedia).toMatchObject({ url: 'https://x.test/a.mp4', base64: null });

    // clearing media (media:null) drops the attachment
    const cleared = (
      await t.app.inject({ method: 'PUT', url: `/api/quick-replies/${withUrl.id}`, payload: { media: null } })
    ).json();
    expect(cleared.media).toBeNull();
  });

  it('rejects a bodyless reply and bad media; 404 media on a text-only reply', async () => {
    // neither text nor media
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/quick-replies', payload: { shortcut: 'x' } })).statusCode,
    ).toBe(400);
    // file kind without bytes
    expect(
      (await t.app.inject({
        method: 'POST',
        url: '/api/quick-replies',
        payload: { text: 'hi', media: { kind: 'file', mediatype: 'image', mimetype: 'image/png' } },
      })).statusCode,
    ).toBe(400);
    // a text-only reply has no media to fetch
    const plain = (
      await t.app.inject({ method: 'POST', url: '/api/quick-replies', payload: { text: 'plain' } })
    ).json();
    expect((await t.app.inject({ method: 'GET', url: `/api/quick-replies/${plain.id}/media` })).statusCode).toBe(404);
  });

  it('rejects empty text on create and update; 404s on unknown id', async () => {
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/quick-replies', payload: { text: ' ' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await t.app.inject({ method: 'PUT', url: '/api/quick-replies/999', payload: { text: 'x' } }))
        .statusCode,
    ).toBe(404);
  });
});
