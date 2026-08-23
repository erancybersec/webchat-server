import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

const HDR = { 'cf-access-authenticated-user-email': 'Dana.Levi@gmail.com' };
const textItem = { type: 'text', data: { text: 'hi' } };

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((res) => setTimeout(res, 20));
  }
}

describe('agent identification', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  const enable = async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { agentsEnabled: true },
    });
    expect(res.statusCode).toBe(200);
  };

  const sendOnce = () =>
    t.app.inject({
      method: 'POST',
      url: '/api/send',
      headers: HDR,
      payload: { recipient: '972521111111', item: textItem },
    });

  const lookup = async (ids: string[]) =>
    (await t.app.inject({ method: 'POST', url: '/api/message-agents', payload: { ids } })).json();

  it('is OFF by default: /api/me reports disabled and nothing is stamped', async () => {
    expect(t.cfg.agentsEnabled).toBe(false);
    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: HDR })).json();
    expect(me).toEqual({
      enabled: false, email: null, name: '', color: '', role: null, perms: null,
      instances: null, defaultInstance: 'Test',
    });

    expect((await sendOnce()).statusCode).toBe(200);
    expect(await lookup(['msg-1'])).toEqual({});

    const job = (
      await t.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: HDR,
        payload: {
          scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
          recipients: [{ id: '972521111111' }],
          items: [textItem],
        },
      })
    ).json();
    expect(job.sentBy).toBeNull();
    // no agent was provisioned either
    expect((await t.app.inject({ method: 'GET', url: '/api/agents' })).json()).toEqual([]);
  });

  it('toggle round-trips through /api/settings into live config', async () => {
    await enable();
    expect(t.cfg.agentsEnabled).toBe(true);
    const s = (await t.app.inject({ method: 'GET', url: '/api/settings' })).json();
    expect(s.agentsEnabled).toBe(true);
  });

  it('auto-provisions agents from the Access header (normalized lowercase)', async () => {
    await enable();
    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: HDR })).json();
    // first agent ever seen bootstraps as admin (so: every permission)
    expect(me).toMatchObject({ enabled: true, email: 'dana.levi@gmail.com', name: '', color: '', role: 'admin' });
    expect(me.perms).toMatchObject({ 'settings.manage': true, 'jobs.approve': true });
    const roster = (await t.app.inject({ method: 'GET', url: '/api/agents' })).json();
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ email: 'dana.levi@gmail.com', active: true });
  });

  it('no header (or junk header) means anonymous, not a crash', async () => {
    await enable();
    const me = (await t.app.inject({ method: 'GET', url: '/api/me' })).json();
    expect(me).toEqual({
      enabled: true, email: null, name: '', color: '', role: null, perms: null,
      instances: null, defaultInstance: 'Test',
    });
    const junk = (
      await t.app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { 'cf-access-authenticated-user-email': 'not-an-email' },
      })
    ).json();
    expect(junk.email).toBeNull();
    expect((await t.app.inject({ method: 'GET', url: '/api/agents' })).json()).toEqual([]);
  });

  it('PUT /api/agents/:email edits name/color/active and /api/me reflects it', async () => {
    await enable();
    await t.app.inject({ method: 'GET', url: '/api/me', headers: HDR });
    const updated = (
      await t.app.inject({
        method: 'PUT',
        url: '/api/agents/dana.levi%40gmail.com',
        payload: { name: 'Dana', color: 'teal' },
      })
    ).json();
    expect(updated).toMatchObject({ name: 'Dana', color: 'teal', active: true });
    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: HDR })).json();
    expect(me).toMatchObject({ name: 'Dana', color: 'teal' });
    expect(
      (await t.app.inject({ method: 'PUT', url: '/api/agents/nobody%40x.com', payload: {} }))
        .statusCode,
    ).toBe(404);
  });

  it('attributes /api/send messages to the sending agent', async () => {
    await enable();
    expect((await sendOnce()).statusCode).toBe(200);
    // FakeEvo assigns key.id = msg-<n> per call
    const map = await lookup(['msg-1', 'unknown-id']);
    expect(map['msg-1']).toMatchObject({ email: 'dana.levi@gmail.com' });
    expect(map['unknown-id']).toBeUndefined();
  });

  it('attributes a delete-for-everyone to the deleting agent (deletedBy)', async () => {
    await enable();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/messages/delete',
      headers: HDR,
      payload: { remoteJid: '972521111111@s.whatsapp.net', messageId: 'DELME', fromMe: true },
    });
    expect(res.statusCode).toBe(201); // FakeEvo mirrors 201 ok → delete is stamped
    const map = await lookup(['DELME']);
    // name falls back to the email local part when no display name is set
    expect(map['DELME']?.deletedBy).toMatchObject({ email: 'dana.levi@gmail.com', name: 'dana.levi' });
    // the delete time is surfaced so the tombstone can show "deleted at HH:MM"
    expect(map['DELME']?.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not stamp a deleter when identification is off', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/messages/delete',
      headers: HDR,
      payload: { remoteJid: '972521111111@s.whatsapp.net', messageId: 'DELME2', fromMe: true },
    });
    await enable(); // turn on only to read back
    expect((await lookup(['DELME2']))['DELME2']).toBeUndefined();
  });

  it('attributes an edit to the editing agent (editedBy)', async () => {
    await enable();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/messages/edit',
      headers: HDR,
      payload: { remoteJid: '972521111111@s.whatsapp.net', messageId: 'EDITME', text: 'fixed' },
    });
    expect(res.statusCode).toBe(201); // FakeEvo mirrors 201 ok → edit is stamped
    const map = await lookup(['EDITME']);
    expect(map['EDITME']?.editedBy).toMatchObject({ email: 'dana.levi@gmail.com', name: 'dana.levi' });
  });

  it('stamps jobs with sentBy and attributes the blast messages', async () => {
    await enable();
    const job = (
      await t.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: HDR,
        payload: {
          scheduledAt: new Date().toISOString(),
          type: 'immediate',
          recipients: [{ id: '972521111111' }],
          items: [textItem],
        },
      })
    ).json();
    expect(job.sentBy).toBe('dana.levi@gmail.com');
    await waitFor(() => t.jobs.byId(job.id)?.status === 'done');

    const sends = (
      await t.app.inject({ method: 'GET', url: `/api/jobs/${job.id}/sends` })
    ).json();
    const messageId = sends[0].messageId as string;
    expect(messageId).toBeTruthy();
    const map = await lookup([messageId]);
    expect(map[messageId]).toMatchObject({ email: 'dana.levi@gmail.com' });
  });

  it('rerun stamps the agent who pressed resend', async () => {
    await enable();
    // a finished job from before tracking (no sentBy)
    const old = t.jobs.upsert({
      scheduledAt: new Date(Date.now() - 3_600_000).toISOString(),
      status: 'done',
      recipients: [{ id: '972521111111' }],
      items: [textItem],
    });
    expect(old.sentBy).toBeNull();
    const clone = (
      await t.app.inject({ method: 'POST', url: `/api/jobs/${old.id}/rerun`, headers: HDR })
    ).json();
    expect(clone.sentBy).toBe('dana.levi@gmail.com');
    await waitFor(() => t.jobs.byId(clone.id)?.status === 'done');
  });

  it('an edit keeps the original creator stamp', async () => {
    await enable();
    const payload = {
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      recipients: [{ id: '972521111111' }],
      items: [textItem],
    };
    const job = (
      await t.app.inject({ method: 'POST', url: '/api/jobs', headers: HDR, payload })
    ).json();
    const edited = (
      await t.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { 'cf-access-authenticated-user-email': 'yossi@gmail.com' },
        payload: { ...payload, id: job.id },
      })
    ).json();
    expect(edited.sentBy).toBe('dana.levi@gmail.com');
  });

  it('turning the toggle off stops stamping but keeps existing attribution queryable off-switch', async () => {
    await enable();
    expect((await sendOnce()).statusCode).toBe(200);
    await t.app.inject({ method: 'PUT', url: '/api/settings', payload: { agentsEnabled: false } });
    // lookups are gated with the toggle — the UI shows nothing while off
    expect(await lookup(['msg-1'])).toEqual({});
    // and new sends are not attributed
    expect((await sendOnce()).statusCode).toBe(200);
    await t.app.inject({ method: 'PUT', url: '/api/settings', payload: { agentsEnabled: true } });
    const map = await lookup(['msg-1', 'msg-2']);
    expect(map['msg-1']).toBeDefined(); // from while it was on
    expect(map['msg-2']).toBeUndefined(); // sent while it was off
  });
});
