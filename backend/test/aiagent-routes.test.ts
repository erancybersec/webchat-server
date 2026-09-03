import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

const JID = '972500000000@s.whatsapp.net';
const DANA = { 'cf-access-authenticated-user-email': 'dana@example.com' };

describe('take-over / resume-ai', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
    // identities on, so "the requesting agent" means something
    await t.app.inject({ method: 'PUT', url: '/api/settings', payload: { agentsEnabled: true } });
    await t.app.inject({ method: 'GET', url: '/api/me', headers: DANA }); // provisions dana
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  const takeOver = () =>
    t.app.inject({ method: 'POST', url: '/api/chats/take-over', headers: DANA, payload: { jid: JID } });
  const resume = () =>
    t.app.inject({ method: 'POST', url: '/api/chats/resume-ai', headers: DANA, payload: { jid: JID } });

  it('take-over sets the assignment AND pauses the AI in one call', async () => {
    const res = await takeOver();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, agentEmail: 'dana@example.com', aiState: 'PAUSED' });

    const meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
    expect(meta.assignments[JID]).toMatchObject({ agentEmail: 'dana@example.com' });
    expect(meta.aiStates[JID]).toMatchObject({ state: 'PAUSED', reason: 'human_takeover' });
  });

  it('resume-ai is refused with 409 while a human still owns the chat', async () => {
    await takeOver();
    const res = await resume();
    expect(res.statusCode).toBe(409);
    expect(res.json().assignee).toBe('dana@example.com');
    // still paused — a refused resume changed nothing
    const meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
    expect(meta.aiStates[JID].state).toBe('PAUSED');
  });

  it('being unassigned is necessary but not sufficient — the chat stays paused until resumed', async () => {
    await takeOver();
    await t.app.inject({
      method: 'POST',
      url: '/api/chats/assign',
      headers: DANA,
      payload: { jid: JID, agentEmail: null },
    });
    let meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
    expect(meta.assignments[JID]).toBeUndefined();
    expect(meta.aiStates[JID].state).toBe('PAUSED'); // NOT auto-resumed

    expect((await resume()).statusCode).toBe(200);
    meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
    expect(meta.aiStates[JID].state).toBe('ACTIVE');
  });

  it('rejects a missing jid', async () => {
    for (const url of ['/api/chats/take-over', '/api/chats/resume-ai']) {
      const res = await t.app.inject({ method: 'POST', url, headers: DANA, payload: {} });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it('needs an agent to take over when there is no Access identity', async () => {
    await t.app.inject({ method: 'PUT', url: '/api/settings', payload: { agentsEnabled: false } });
    const none = await t.app.inject({ method: 'POST', url: '/api/chats/take-over', payload: { jid: JID } });
    expect(none.statusCode).toBe(400);
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/chats/take-over',
      payload: { jid: JID, agentEmail: 'ghost@example.com' },
    });
    expect(unknown.statusCode).toBe(400);
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/chats/take-over',
      payload: { jid: JID, agentEmail: 'dana@example.com' },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('/api/ai-agent knowledge + offerings CRUD', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  const post = (url: string, payload: unknown) => t.app.inject({ method: 'POST', url, payload });
  const put = (url: string, payload: unknown) => t.app.inject({ method: 'PUT', url, payload });

  it('knowledge round-trips and rejects empty required fields', async () => {
    const created = await post('/api/ai-agent/knowledge', {
      title: 'Trial class',
      content: 'The first trial is free.',
      keywords: 'trial, free',
      category: 'policies',
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    const list = (await t.app.inject({ method: 'GET', url: '/api/ai-agent/knowledge' })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Trial class', active: true });

    expect((await post('/api/ai-agent/knowledge', { content: 'x' })).statusCode).toBe(400);
    expect((await post('/api/ai-agent/knowledge', { title: 'x' })).statusCode).toBe(400);
    expect((await put(`/api/ai-agent/knowledge/${id}`, { title: '   ' })).statusCode).toBe(400);

    const updated = await put(`/api/ai-agent/knowledge/${id}`, { active: false, category: 'faq' });
    expect(updated.json()).toMatchObject({ active: false, category: 'faq' });
    expect((await put('/api/ai-agent/knowledge/9999', { title: 'x' })).statusCode).toBe(404);

    const del = await t.app.inject({ method: 'DELETE', url: `/api/ai-agent/knowledge/${id}` });
    expect(del.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/ai-agent/knowledge' })).json()).toEqual([]);
  });

  it('offerings validate the enums, the time, the date and the count', async () => {
    for (const payload of [
      { title: '' },
      { title: 'A', ageGroup: 'kids' },
      { title: 'A', dayOfWeek: 'monday' },
      { title: 'A', time: '25:00' },
      { title: 'A', validUntil: '01/02/2026' },
      { title: 'A', spotsLeft: -1 },
      { title: 'A', spotsLeft: 1.5 },
      // an offer with no expiry would be invisible to get_available_offers
      { title: 'A', isOffer: true },
    ]) {
      const res = await post('/api/ai-agent/offerings', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const ok = await post('/api/ai-agent/offerings', {
      title: 'Ballet A',
      branch: 'Center',
      ageGroup: 'child',
      dayOfWeek: 'sun',
      time: '17:30',
      price: '120 ILS',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ageGroup: 'child', dayOfWeek: 'sun', time: '17:30' });
    expect(ok.json().availabilityUpdatedAt).toBeNull();
    expect((await put(`/api/ai-agent/offerings/${ok.json().id}`, { ageGroup: 'kids' })).statusCode).toBe(400);
    expect((await put('/api/ai-agent/offerings/9999', { title: 'x' })).statusCode).toBe(404);
  });

  it('recheck is the only route that stamps availability freshness', async () => {
    const row = (
      await post('/api/ai-agent/offerings', { title: 'Hip hop', price: '100' })
    ).json();
    expect(row.availabilityUpdatedAt).toBeNull();

    // a general edit leaves it alone
    const edited = (await put(`/api/ai-agent/offerings/${row.id}`, { notes: 'moved rooms' })).json();
    expect(edited.availabilityUpdatedAt).toBeNull();

    const bad = await post(`/api/ai-agent/offerings/${row.id}/recheck`, { spotsLeft: -2 });
    expect(bad.statusCode).toBe(400);

    const checked = (await post(`/api/ai-agent/offerings/${row.id}/recheck`, { spotsLeft: 4 })).json();
    expect(checked.spotsLeft).toBe(4);
    expect(checked.availabilityUpdatedAt).toBeTruthy();
    expect((await post('/api/ai-agent/offerings/9999/recheck', { spotsLeft: 1 })).statusCode).toBe(404);
  });

  it('the test sandbox refuses to run without an API key, and never sends', async () => {
    const noKey = await post('/api/ai-agent/test', { message: 'hi' });
    expect(noKey.statusCode).toBe(400);
    expect((await post('/api/ai-agent/test', {})).statusCode).toBe(400);
    expect(t.evo.sentTo()).toEqual([]);
  });

  it('the audit endpoint is empty and filterable', async () => {
    const all = await t.app.inject({ method: 'GET', url: '/api/ai-agent/audit' });
    expect(all.json()).toEqual({ rows: [] });
    const filtered = await t.app.inject({
      method: 'GET',
      url: `/api/ai-agent/audit?chatJid=${encodeURIComponent(JID)}&limit=5`,
    });
    expect(filtered.json()).toEqual({ rows: [] });
  });
});

describe('AI settings validation', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  const put = (payload: unknown) => t.app.inject({ method: 'PUT', url: '/api/settings', payload });

  it('never echoes the AI api key, only whether one is set', async () => {
    const saved = await put({ aiAgentApiKey: 'sk-ant-super-secret-1234' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ aiAgentApiKeySet: true, aiAgentApiKeyHint: '••••1234' });
    const body = (await t.app.inject({ method: 'GET', url: '/api/settings' })).body;
    expect(body).not.toContain('sk-ant-super-secret-1234');
    // live by reference, so the runner sees it on the next tick
    expect(t.cfg.aiAgentApiKey).toBe('sk-ant-super-secret-1234');
    // and an empty key means "keep the saved one"
    await put({ aiAgentApiKey: '' });
    expect(t.cfg.aiAgentApiKey).toBe('sk-ant-super-secret-1234');
  });

  it('rejects bad providers, tiers, channel names and numbers', async () => {
    for (const payload of [
      { aiAgentProvider: 'llamafile' },
      { aiAgentModelTier: 'turbo' },
      { aiAgentInstances: ['ok', '../evil'] },
      { aiAgentInstances: 'Test' },
      { aiAgentMaxRepliesPerSession: 0 },
      { aiAgentMaxRepliesPerSession: 1.5 },
      { aiAgentSessionGapHours: 0 },
      { aiAgentDailyCap: -1 },
      { aiAgentReplyDelaySec: -1 },
    ]) {
      const res = await put(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // nothing leaked through from the rejected batch
    expect(t.cfg.aiAgentProvider).toBe('anthropic');
    expect(t.cfg.aiAgentInstances).toEqual([]);
    expect(t.cfg.aiAgentMaxRepliesPerSession).toBe(20);
  });

  it('round-trips the AI fields live, and resolves the model for the chosen tier', async () => {
    const res = await put({
      aiAgentInstances: [' Test ', 'Second'],
      aiAgentProvider: 'anthropic',
      aiAgentModelTier: 'best',
      aiAgentPersona: 'Warm, brief, Hebrew first.',
      aiAgentRules: 'Never discuss competitors.',
      aiAgentEscalation: 'Escalate anything about payments.',
      aiAgentMaxRepliesPerSession: 8,
      aiAgentSessionGapHours: 24,
      aiAgentDailyCap: 50,
      aiAgentReplyDelaySec: 20,
      aiAgentHandoffMessage: 'Someone will be with you shortly.',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      aiAgentInstances: ['Test', 'Second'],
      aiAgentModelTier: 'best',
      aiAgentResolvedModel: 'claude-opus-5',
      aiAgentMaxRepliesPerSession: 8,
      aiAgentDailyCap: 50,
    });
    expect(t.cfg.aiAgentInstances).toEqual(['Test', 'Second']);
    expect(t.cfg.aiAgentReplyDelaySec).toBe(20);
    // the master switch is untouched by any of that
    expect(t.cfg.aiAgentEnabled).toBe(false);
  });

  it('a custom tier uses the operator model id verbatim', async () => {
    const res = await put({ aiAgentModelTier: 'custom', aiAgentModel: 'claude-sonnet-5-20991231' });
    expect(res.json().aiAgentResolvedModel).toBe('claude-sonnet-5-20991231');
  });

  it('exposes the fixed safety rules read-only and keeps the bot out of the roster', async () => {
    const s = (await t.app.inject({ method: 'GET', url: '/api/settings' })).json();
    expect(s.aiAgentSafetyRules).toContain('Every turn must end with exactly one respond_to_lead call');
    // the switch cannot be flipped by sending the rules back
    const roster = (await t.app.inject({ method: 'GET', url: '/api/agents' })).json();
    expect(roster.some((a: { email: string }) => a.email === 'ai-agent@webchat.local')).toBe(false);
    // but the bot row exists for attribution
    const bot = t.db
      .prepare(`SELECT email, is_bot FROM agents WHERE email = 'ai-agent@webchat.local'`)
      .get() as { email: string; is_bot: number };
    expect(bot).toMatchObject({ is_bot: 1 });
  });
});
