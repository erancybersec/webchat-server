import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

const HDR = (email: string) => ({ 'cf-access-authenticated-user-email': email });

describe('multi-instance: /api/instances + per-agent grants', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  const enable = () =>
    t.app.inject({ method: 'PUT', url: '/api/settings', payload: { agentsEnabled: true } });

  /** First request bootstraps the admin; second provisions a plain agent. */
  const provision = async () => {
    await enable();
    await t.app.inject({ method: 'GET', url: '/api/me', headers: HDR('admin@x.com') });
    await t.app.inject({ method: 'GET', url: '/api/me', headers: HDR('agent@x.com') });
  };

  it('lists instances with safe fields only — the Evolution token never leaks', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/instances' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.default).toBe('Test');
    expect(body.instances.map((i: any) => i.name)).toEqual(['Test', 'Second']);
    expect(JSON.stringify(body)).not.toContain('SECRET-TOKEN');
    // unrestricted requester gets the storage telemetry
    expect(body.instances[1].counts).toEqual({ messages: 222531, contacts: 8070, chats: 5921 });
  });

  it('agents see only their granted instances; no grants = the default', async () => {
    await provision();
    const agentView = (
      await t.app.inject({ method: 'GET', url: '/api/instances', headers: HDR('agent@x.com') })
    ).json();
    expect(agentView.instances.map((i: any) => i.name)).toEqual(['Test']);
    // plain agents don't get counts (storage telemetry is an insights.view concern)
    expect(agentView.instances[0].counts).toBeUndefined();

    await t.app.inject({
      method: 'PUT',
      url: '/api/agents/agent%40x.com',
      headers: HDR('admin@x.com'),
      payload: { instances: ['Second'] },
    });
    const granted = (
      await t.app.inject({ method: 'GET', url: '/api/instances', headers: HDR('agent@x.com') })
    ).json();
    expect(granted.instances.map((i: any) => i.name)).toEqual(['Second']);

    const adminView = (
      await t.app.inject({ method: 'GET', url: '/api/instances', headers: HDR('admin@x.com') })
    ).json();
    expect(adminView.instances).toHaveLength(2);
    expect(adminView.instances[0].counts).toBeDefined();
  });

  it('/api/me reports the allowed set and the default', async () => {
    await provision();
    await t.app.inject({
      method: 'PUT',
      url: '/api/agents/agent%40x.com',
      headers: HDR('admin@x.com'),
      payload: { instances: ['Second'] },
    });
    const me = (
      await t.app.inject({ method: 'GET', url: '/api/me', headers: HDR('agent@x.com') })
    ).json();
    expect(me.instances).toEqual(['Second']);
    expect(me.defaultInstance).toBe('Test');
    const admin = (
      await t.app.inject({ method: 'GET', url: '/api/me', headers: HDR('admin@x.com') })
    ).json();
    expect(admin.instances).toBeNull(); // unrestricted
  });

  it('gateway: ?instance= is enforced against grants and routed into the path', async () => {
    await provision();
    // agent with default-only grants: own instance OK, foreign 403
    const ok = await t.app.inject({ method: 'GET', url: '/api/chats', headers: HDR('agent@x.com') });
    expect(ok.statusCode).toBe(201); // FakeEvo's mirrored status — not a 403
    expect(t.evo.calls.at(-1)!.endpoint).toBe('/chat/findChats/Test');
    const denied = await t.app.inject({
      method: 'GET',
      url: '/api/chats?instance=Second',
      headers: HDR('agent@x.com'),
    });
    expect(denied.statusCode).toBe(403);

    // admin reaches the second instance; the path carries it
    const admin = await t.app.inject({
      method: 'GET',
      url: '/api/chats?instance=Second',
      headers: HDR('admin@x.com'),
    });
    expect(admin.statusCode).toBe(201);
    expect(t.evo.calls.at(-1)!.endpoint).toBe('/chat/findChats/Second');
  });

  it('rejects path-injection instance names for EVERYONE, admin included', async () => {
    await provision();
    for (const evil of ['a/../b', 'x?y=1', 'a%2Fb', 'a#b']) {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/chats?instance=${encodeURIComponent(evil)}`,
        headers: HDR('admin@x.com'),
      });
      expect(res.statusCode, evil).toBe(403);
    }
    // and even with no identity at all (perimeter posture ≠ injection allowed)
    const anon = await t.app.inject({
      method: 'GET',
      url: `/api/chats?instance=${encodeURIComponent('a/../b')}`,
    });
    expect(anon.statusCode).toBe(403);
  });

  it('POST /api/send routes through the requested instance', async () => {
    await provision();
    await t.app.inject({
      method: 'PUT',
      url: '/api/agents/agent%40x.com',
      headers: HDR('admin@x.com'),
      payload: { instances: ['Second'] },
    });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/send?instance=Second',
      headers: HDR('agent@x.com'),
      payload: { recipient: '972521111111', item: { type: 'text', data: { text: 'hi' } } },
    });
    expect(res.statusCode).toBe(200);
    expect(t.evo.calls.at(-1)!.endpoint).toContain('/Second');

    // …the default instance is now FORBIDDEN when named explicitly…
    const denied = await t.app.inject({
      method: 'POST',
      url: '/api/send?instance=Test',
      headers: HDR('agent@x.com'),
      payload: { recipient: '972521111111', item: { type: 'text', data: { text: 'hi' } } },
    });
    expect(denied.statusCode).toBe(403);

    // …and a bare request falls back to the agent's granted line, not the
    // default they can't use (otherwise the whole app 403s for them)
    const bare = await t.app.inject({
      method: 'POST',
      url: '/api/send',
      headers: HDR('agent@x.com'),
      payload: { recipient: '972521111111', item: { type: 'text', data: { text: 'hi' } } },
    });
    expect(bare.statusCode).toBe(200);
    expect(t.evo.calls.at(-1)!.endpoint).toContain('/Second');
  });

  it('grant-limited agents get filtered maintenance telemetry and a stripped roster', async () => {
    await provision();
    // the agent needs insights.view to read /api/maintenance at all
    await t.app.inject({
      method: 'PUT',
      url: '/api/agents/agent%40x.com',
      headers: HDR('admin@x.com'),
      payload: { instances: ['Second'], perms: { 'insights.view': true } },
    });
    const m = (
      await t.app.inject({ method: 'GET', url: '/api/maintenance', headers: HDR('agent@x.com') })
    ).json();
    expect(m.evolution.map((i: any) => i.name)).toEqual(['Second']);
    const adminM = (
      await t.app.inject({ method: 'GET', url: '/api/maintenance', headers: HDR('admin@x.com') })
    ).json();
    expect(adminM.evolution).toHaveLength(2);

    // roster: instance grants are admin-only data
    const asAgent = (
      await t.app.inject({ method: 'GET', url: '/api/agents', headers: HDR('agent@x.com') })
    ).json();
    expect(asAgent.every((a: any) => a.instances === null)).toBe(true);
    const asAdmin = (
      await t.app.inject({ method: 'GET', url: '/api/agents', headers: HDR('admin@x.com') })
    ).json();
    expect(asAdmin.find((a: any) => a.email === 'agent@x.com').instances).toEqual(['Second']);
  });
});

describe('multi-instance: jobs carry their instance', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  const HDRS = { 'cf-access-authenticated-user-email': 'admin@x.com' };
  const enable = () =>
    t.app.inject({ method: 'PUT', url: '/api/settings', payload: { agentsEnabled: true } });

  const jobBody = (extra: Record<string, unknown> = {}) => ({
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    recipients: [{ id: '972521111111' }],
    items: [{ type: 'text', data: { text: 'x' } }],
    ...extra,
  });

  it('create stores the instance; edits keep it unless changed', async () => {
    const created = (
      await t.app.inject({ method: 'POST', url: '/api/jobs', payload: jobBody({ instance: 'Second' }) })
    ).json();
    expect(created.instance).toBe('Second');
    const edited = (
      await t.app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: { ...jobBody(), id: created.id },
      })
    ).json();
    expect(edited.instance).toBe('Second');
  });

  it('an agent denied the job\'s instance can neither create, edit, restore nor rerun it', async () => {
    await enable();
    await t.app.inject({ method: 'GET', url: '/api/me', headers: HDRS }); // admin bootstrap
    const agentHdr = { 'cf-access-authenticated-user-email': 'agent@x.com' };
    await t.app.inject({ method: 'GET', url: '/api/me', headers: agentHdr });

    // create on a foreign instance → 403
    const denied = await t.app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: agentHdr,
      payload: jobBody({ instance: 'Second' }),
    });
    expect(denied.statusCode).toBe(403);

    // admin parks a job on Second; the agent cannot edit/restore/rerun it
    const j = (
      await t.app.inject({ method: 'POST', url: '/api/jobs', headers: HDRS, payload: jobBody({ instance: 'Second' }) })
    ).json();
    const edit = await t.app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: agentHdr,
      payload: { ...jobBody(), id: j.id },
    });
    expect(edit.statusCode).toBe(403);

    await t.app.inject({ method: 'POST', url: `/api/jobs/${j.id}/cancel`, headers: HDRS });
    const restore = await t.app.inject({
      method: 'POST',
      url: `/api/jobs/${j.id}/restore`,
      headers: agentHdr,
    });
    expect(restore.statusCode).toBe(403);
    expect(t.jobs.byId(j.id)!.status).toBe('cancelled'); // refused → unchanged

    t.jobs.finish(j.id, 'done', 'x');
    const rerun = await t.app.inject({
      method: 'POST',
      url: `/api/jobs/${j.id}/rerun`,
      headers: agentHdr,
    });
    expect(rerun.statusCode).toBe(403);
  });

  it('the scheduler sends through the job\'s instance and roll-forward inherits it', async () => {
    // this test is about ROUTING, not connectivity — the shared fixture has
    // 'Second' disconnected, which the send-time health guard would (rightly)
    // refuse to send through. Set before anything can cache the instance list.
    t.evo.evoInstances = t.evo.evoInstances.map((i) =>
      i.name === 'Second' ? { ...i, connectionStatus: 'open' } : i,
    );
    await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { recurringEnabled: true },
    });
    const j = (
      await t.app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          scheduledAt: new Date(Date.now() - 1000).toISOString(),
          recipients: [{ id: '972521111111' }],
          items: [{ type: 'text', data: { text: 'x' } }],
          instance: 'Second',
          repeat: { freq: 'daily' },
        },
      })
    ).json();
    await t.scheduler.tick();
    const sendCall = t.evo.calls.find((c) => c.endpoint.startsWith('/message/'));
    expect(sendCall!.endpoint).toContain('/Second');
    expect(t.jobs.byId(j.id)!.status).toBe('done');
    const next = t.jobs.all().find((x) => x.id !== j.id && x.repeat);
    expect(next?.instance).toBe('Second');
  });
});
