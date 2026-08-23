import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

const asAgent = (email: string) => ({ 'cf-access-authenticated-user-email': email });
const ADMIN = asAgent('admin@x.com');
const AGENT = asAgent('worker@x.com');

describe('role-based permissions', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
    // enable identification, then provision admin@x.com first (bootstrap admin)
    await t.app.inject({ method: 'PUT', url: '/api/settings', payload: { agentsEnabled: true } });
    await t.app.inject({ method: 'GET', url: '/api/me', headers: ADMIN });
    await t.app.inject({ method: 'GET', url: '/api/me', headers: AGENT });
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  const status = async (
    method: 'GET' | 'PUT' | 'POST',
    url: string,
    headers?: Record<string, string>,
    payload?: unknown,
  ) => (await t.app.inject({ method, url, headers, payload: payload as never })).statusCode;

  it('bootstraps the first agent as admin, later ones as agents', async () => {
    const roster = (await t.app.inject({ method: 'GET', url: '/api/agents' })).json();
    expect(roster.map((a: any) => [a.email, a.role])).toEqual([
      ['admin@x.com', 'admin'],
      ['worker@x.com', 'agent'],
    ]);
  });

  it('blocks non-admins from admin routes with 403', async () => {
    expect(await status('PUT', '/api/settings', AGENT, { delayMin: 0 })).toBe(403);
    expect(await status('POST', '/api/settings/test', AGENT, {})).toBe(403);
    expect(await status('GET', '/api/analytics/summary', AGENT)).toBe(403);
    expect(await status('PUT', '/api/agents/worker%40x.com', AGENT, { name: 'W' })).toBe(403);
  });

  it('blocks agents from clearing job history (jobs.clearHistory), admins allowed', async () => {
    expect(await status('POST', '/api/jobs/clear-done', AGENT, { scope: 'history' })).toBe(403);
    expect(await status('POST', '/api/jobs/clear-done', ADMIN, { scope: 'history' })).toBe(200);
    // a per-agent override can still grant it
    await status('PUT', '/api/agents/worker%40x.com', ADMIN, {
      perms: { 'jobs.clearHistory': true },
    });
    expect(await status('POST', '/api/jobs/clear-done', AGENT, { scope: 'history' })).toBe(200);
  });

  it('keeps shared routes open to non-admins', async () => {
    expect(await status('GET', '/api/settings', AGENT)).toBe(200);
    expect(await status('GET', '/api/agents', AGENT)).toBe(200);
    expect(await status('GET', '/api/me', AGENT)).toBe(200);
    expect(await status('POST', '/api/message-agents', AGENT, { ids: [] })).toBe(200);
  });

  it('lets admins through everywhere and /api/me reports the role', async () => {
    expect(await status('PUT', '/api/settings', ADMIN, { delayMin: 0 })).toBe(200);
    expect(await status('GET', '/api/analytics/summary', ADMIN)).toBe(200);
    expect(await status('PUT', '/api/agents/worker%40x.com', ADMIN, { name: 'W' })).toBe(200);
    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: AGENT })).json();
    expect(me.role).toBe('agent');
  });

  it('allows requests without an Access identity (LAN/bearer/automation)', async () => {
    expect(await status('PUT', '/api/settings', undefined, { delayMin: 0 })).toBe(200);
    expect(await status('GET', '/api/analytics/summary')).toBe(200);
  });

  it('enforces nothing while the toggle is off', async () => {
    await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: ADMIN,
      payload: { agentsEnabled: false },
    });
    expect(await status('PUT', '/api/settings', AGENT, { delayMin: 0 })).toBe(200);
    expect(await status('GET', '/api/analytics/summary', AGENT)).toBe(200);
  });

  it('validates the role value', async () => {
    expect(
      await status('PUT', '/api/agents/worker%40x.com', ADMIN, { role: 'superuser' }),
    ).toBe(400);
  });

  it('admins can promote and demote; the last admin cannot be demoted', async () => {
    // sole admin demoting themselves → 409
    expect(await status('PUT', '/api/agents/admin%40x.com', ADMIN, { role: 'agent' })).toBe(409);

    // promote the worker, then the original admin may step down
    expect(await status('PUT', '/api/agents/worker%40x.com', ADMIN, { role: 'admin' })).toBe(200);
    expect(await status('PUT', '/api/agents/admin%40x.com', ADMIN, { role: 'agent' })).toBe(200);

    // demoted: now locked out of admin routes
    expect(await status('PUT', '/api/settings', ADMIN, { delayMin: 0 })).toBe(403);

    // deactivating the sole remaining admin is allowed (active is cosmetic)
    expect(
      await status('PUT', '/api/agents/worker%40x.com', AGENT, { active: false }),
    ).toBe(200);
  });
});
