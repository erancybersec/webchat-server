import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { FakeEvo, makeApp, testConfig, type TestApp } from './helpers.js';

describe('/api/settings', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('GET exposes the connection without leaking the apikey', async () => {
    const res = (await t.app.inject({ method: 'GET', url: '/api/settings' })).json();
    expect(res).toEqual({
      base: 'https://evolution.test',
      instance: 'Test',
      apikeySet: true,
      apikeyHint: '••••-key',
      delayMin: 0,
      delayMax: 0,
      recurringEnabled: false,
      quietEnabled: false,
      quietStart: '21:00',
      quietEnd: '08:00',
      optoutEnabled: false,
      optoutKeywords: 'STOP, הסר',
      optoutReply: '',
      agentsEnabled: false,
      approvalThreshold: 1,
      retentionDays: 0,
      verifyEnabled: true,
      verifyValidDays: 180,
      verifyInvalidDays: 90,
      verifyDailyCap: 400,
      verifyBatchSize: 10,
      verifyBatchPauseMs: 60_000,
      verifyBreakerRun: 25,
      coldCapEnabled: true,
      coldDailyCap: 50,
      coldWarmupStart: 10,
      coldRampWindowDays: 30,
      notifyInstances: [],
      // AI agent — OFF with an empty line allow-list, the two things that have
      // to be set deliberately before it can speak to anyone
      aiAgentEnabled: false,
      aiAgentInstances: [],
      aiAgentProvider: 'anthropic',
      aiAgentModelTier: 'fast',
      aiAgentModel: '',
      aiAgentApiKeySet: false,
      aiAgentApiKeyHint: '',
      aiAgentPersona: '',
      aiAgentRules: '',
      aiAgentEscalation: '',
      aiAgentMaxRepliesPerSession: 20,
      aiAgentSessionGapHours: 48,
      aiAgentDailyCap: 200,
      aiAgentHandoffMessage: 'Let me get a team member to help with that.',
      aiAgentReplyDelaySec: 10,
      aiAgentSafetyRules: expect.stringContaining('Never fabricate studio information'),
      aiAgentResolvedModel: 'claude-haiku-4-5-20251001',
      // the zone every 'HH:MM' setting is read in, plus the server's clock —
      // the UI labels quiet hours and sending windows with them
      timezone: expect.any(String),
      serverTime: expect.any(String),
    });
    expect(JSON.stringify(res)).not.toContain('test-key');
  });

  it('PUT updates live config; empty apikey keeps the saved one', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { base: 'https://new.example/', instance: 'Prod', apikey: '', delayMin: 2, delayMax: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ base: 'https://new.example', instance: 'Prod', apikeySet: true });
    // live: scheduler/sender read these by reference
    expect(t.cfg.evo.base).toBe('https://new.example');
    expect(t.cfg.evo.apikey).toBe('test-key'); // unchanged
    expect(t.cfg.delayMinMs).toBe(2000);
    expect(t.cfg.delayMaxMs).toBe(5000);
  });

  it('PUT round-trips notifyInstances and validates channel names', async () => {
    const ok = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { notifyInstances: ['Test', ' Second '] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().notifyInstances).toEqual(['Test', 'Second']); // trimmed
    expect(t.cfg.notifyInstances).toEqual(['Test', 'Second']); // live by reference

    // an unsafe channel name (path-injection guard) is rejected
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { notifyInstances: ['ok', '../evil'] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('PUT rejects bad delays', async () => {
    for (const payload of [
      { delayMin: 5, delayMax: 2 },
      { delayMin: -1 },
      { delayMax: 'abc' },
    ]) {
      const res = await t.app.inject({ method: 'PUT', url: '/api/settings', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('PUT applies the send-safety knobs live', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        coldCapEnabled: false,
        coldDailyCap: 120,
        coldWarmupStart: 5,
        coldRampWindowDays: 14,
        verifyDailyCap: 250,
        verifyBatchSize: 8,
        verifyBatchPauseMs: 90_000,
        verifyBreakerRun: 15,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      coldCapEnabled: false,
      coldDailyCap: 120,
      coldWarmupStart: 5,
      coldRampWindowDays: 14,
      verifyDailyCap: 250,
      verifyBatchSize: 8,
      verifyBatchPauseMs: 90_000,
      verifyBreakerRun: 15,
    });
    // live by reference — the sweep and the ration read these on the next pass
    expect(t.cfg.coldCapEnabled).toBe(false);
    expect(t.cfg.coldDailyCap).toBe(120);
    expect(t.cfg.coldRampWindowDays).toBe(14);
    expect(t.cfg.verifyBatchSize).toBe(8);
    expect(t.cfg.verifyBreakerRun).toBe(15);
  });

  it('PUT refuses a send-safety value config.ts would have clamped', async () => {
    for (const payload of [
      { verifyBatchSize: 201 }, // Evolution's own per-call ceiling
      { verifyBatchSize: 0 },
      { verifyBatchSize: 1.5 },
      { verifyDailyCap: -1 },
      { verifyBreakerRun: 0 },
      { verifyBatchPauseMs: -1 },
      { coldDailyCap: 0 },
      { coldWarmupStart: 0 },
      { coldRampWindowDays: 0 },
    ]) {
      const res = await t.app.inject({ method: 'PUT', url: '/api/settings', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // and nothing leaked through from the rejected batch
    expect(t.cfg.verifyBatchSize).toBe(10);
  });

  it('saved settings override env config on the next boot', async () => {
    const db = openDb(':memory:');
    const first = await buildApp({ cfg: testConfig(), db, evo: new FakeEvo() });
    await first.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { instance: 'FromDb', apikey: 'db-key', delayMax: 9 },
    });
    await first.app.close();

    const cfg = testConfig(); // fresh env values
    const second = await buildApp({ cfg, db, evo: new FakeEvo() });
    expect(cfg.evo.instance).toBe('FromDb');
    expect(cfg.evo.apikey).toBe('db-key');
    expect(cfg.delayMaxMs).toBe(9000);
    expect(cfg.evo.base).toBe('https://evolution.test'); // never saved — env wins
    await second.app.close();
    db.close();
  });
});
