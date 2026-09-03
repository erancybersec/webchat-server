import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { AI_MODEL_TIERS, AI_PROVIDERS, type Config } from '../config.js';
import { FIXED_SAFETY_RULES, resolveModel } from '../services/aiProviders.js';
import type { EventRelay } from '../services/events.js';
import { SAFE_INSTANCE } from '../services/instances.js';
import type { SettingKey, SettingsStore } from '../services/settings.js';

interface SettingsDeps {
  cfg: Config;
  store: SettingsStore;
  relay: EventRelay;
  requireAdmin: preHandlerHookHandler;
}

/** The settings shape sent to the browser — the apikey itself never leaves the server. */
function publicSettings(cfg: Config) {
  return {
    base: cfg.evo.base,
    instance: cfg.evo.instance,
    apikeySet: !!cfg.evo.apikey,
    apikeyHint: cfg.evo.apikey ? `••••${cfg.evo.apikey.slice(-4)}` : '',
    delayMin: cfg.delayMinMs / 1000,
    delayMax: cfg.delayMaxMs / 1000,
    // Every 'HH:MM' the server acts on — quiet hours, a campaign's sending
    // window — is read in THIS zone, which in a container is whatever TZ says
    // (UTC when nobody sets it). The UI shows it next to those fields so 21:00
    // never quietly means 21:00 somewhere else.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    serverTime: new Date().toISOString(),
    recurringEnabled: cfg.recurringEnabled,
    quietEnabled: cfg.quietEnabled,
    quietStart: cfg.quietStart,
    quietEnd: cfg.quietEnd,
    optoutEnabled: cfg.optoutEnabled,
    optoutKeywords: cfg.optoutKeywords,
    optoutReply: cfg.optoutReply,
    agentsEnabled: cfg.agentsEnabled,
    approvalThreshold: cfg.approvalThreshold,
    retentionDays: cfg.retentionDays,
    verifyEnabled: cfg.verifyEnabled,
    verifyValidDays: cfg.verifyValidDays,
    verifyInvalidDays: cfg.verifyInvalidDays,
    verifyDailyCap: cfg.verifyDailyCap,
    verifyBatchSize: cfg.verifyBatchSize,
    verifyBatchPauseMs: cfg.verifyBatchPauseMs,
    verifyBreakerRun: cfg.verifyBreakerRun,
    coldCapEnabled: cfg.coldCapEnabled,
    coldDailyCap: cfg.coldDailyCap,
    coldWarmupStart: cfg.coldWarmupStart,
    coldRampWindowDays: cfg.coldRampWindowDays,
    notifyInstances: cfg.notifyInstances,
    aiAgentEnabled: cfg.aiAgentEnabled,
    aiAgentInstances: cfg.aiAgentInstances,
    aiAgentProvider: cfg.aiAgentProvider,
    aiAgentModelTier: cfg.aiAgentModelTier,
    aiAgentModel: cfg.aiAgentModel,
    // Same convention as evo.apikey: the key itself never leaves the server,
    // only whether one is set and its last four characters.
    aiAgentApiKeySet: !!cfg.aiAgentApiKey,
    aiAgentApiKeyHint: cfg.aiAgentApiKey ? `••••${cfg.aiAgentApiKey.slice(-4)}` : '',
    aiAgentPersona: cfg.aiAgentPersona,
    aiAgentRules: cfg.aiAgentRules,
    aiAgentEscalation: cfg.aiAgentEscalation,
    aiAgentMaxRepliesPerSession: cfg.aiAgentMaxRepliesPerSession,
    aiAgentSessionGapHours: cfg.aiAgentSessionGapHours,
    aiAgentDailyCap: cfg.aiAgentDailyCap,
    aiAgentHandoffMessage: cfg.aiAgentHandoffMessage,
    aiAgentReplyDelaySec: cfg.aiAgentReplyDelaySec,
    /** The fixed safety rules, read-only — shown so the operator can see what
     * their own instructions are layered on top of. */
    aiAgentSafetyRules: FIXED_SAFETY_RULES,
    aiAgentResolvedModel: resolveModel(cfg),
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_INSTRUCTION_CHARS = 8000;

export function registerSettings(app: FastifyInstance, deps: SettingsDeps): void {
  const { cfg, store, relay, requireAdmin } = deps;

  // Open to all agents: Compose reads recurringEnabled, Blacklist reads the
  // opt-out values. No secrets here — the apikey never leaves the server.
  app.get('/api/settings', async () => publicSettings(cfg));

  // Partial update; empty/missing apikey means "keep the saved one".
  app.put('/api/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<Record<SettingKey, string>> = {};

    if (typeof b.base === 'string') patch.evo_base = b.base.trim().replace(/\/+$/, '');
    if (typeof b.instance === 'string') patch.evo_instance = b.instance.trim();
    if (typeof b.apikey === 'string' && b.apikey.trim()) patch.evo_apikey = b.apikey.trim();

    const delayMin = b.delayMin == null ? cfg.delayMinMs / 1000 : Number(b.delayMin);
    const delayMax = b.delayMax == null ? cfg.delayMaxMs / 1000 : Number(b.delayMax);
    if (!Number.isFinite(delayMin) || !Number.isFinite(delayMax) || delayMin < 0 || delayMax < 0)
      return reply.code(400).send({ error: 'delays must be numbers (seconds, >= 0)' });
    if (delayMax < delayMin) return reply.code(400).send({ error: 'delayMax must be >= delayMin' });
    if (b.delayMin != null) patch.delay_min = String(delayMin);
    if (b.delayMax != null) patch.delay_max = String(delayMax);

    if (typeof b.recurringEnabled === 'boolean') patch.recurring_enabled = b.recurringEnabled ? '1' : '0';
    if (typeof b.quietEnabled === 'boolean') patch.quiet_enabled = b.quietEnabled ? '1' : '0';
    for (const [field, key] of [['quietStart', 'quiet_start'], ['quietEnd', 'quiet_end']] as const) {
      const v = b[field];
      if (v == null) continue;
      if (typeof v !== 'string' || !HHMM.test(v))
        return reply.code(400).send({ error: `${field} must be HH:MM` });
      patch[key] = v;
    }
    if (typeof b.optoutEnabled === 'boolean') patch.optout_enabled = b.optoutEnabled ? '1' : '0';
    if (typeof b.agentsEnabled === 'boolean') patch.agents_enabled = b.agentsEnabled ? '1' : '0';
    if (b.approvalThreshold != null) {
      const t = Number(b.approvalThreshold);
      if (!Number.isInteger(t) || t < 1)
        return reply.code(400).send({ error: 'approvalThreshold must be an integer >= 1' });
      patch.approval_threshold = String(t);
    }
    if (b.retentionDays != null) {
      const d = Number(b.retentionDays);
      if (!Number.isInteger(d) || d < 0)
        return reply.code(400).send({ error: 'retentionDays must be an integer >= 0 (0 = off)' });
      patch.retention_days = String(d);
    }
    if (typeof b.verifyEnabled === 'boolean') patch.verify_enabled = b.verifyEnabled ? '1' : '0';
    // TTLs are asymmetric on purpose: being wrong about 'invalid' costs a real
    // customer for the whole window, being wrong about 'valid' costs one failed
    // send — so the UI is free to set them independently, but both need a floor.
    for (const [key, field] of [
      ['verify_valid_days', 'verifyValidDays'],
      ['verify_invalid_days', 'verifyInvalidDays'],
    ] as const) {
      if (b[field] == null) continue;
      const d = Number(b[field]);
      if (!Number.isInteger(d) || d < 1)
        return reply.code(400).send({ error: `${field} must be an integer >= 1 (days)` });
      patch[key] = String(d);
    }
    if (typeof b.coldCapEnabled === 'boolean') patch.cold_cap_enabled = b.coldCapEnabled ? '1' : '0';
    // Send-safety numbers. The bounds are config.ts's own clamps restated, so a
    // saved value can never take the sweep or the ration somewhere an env var
    // could not — the point of these knobs is to pace DOWN, not to unlock.
    for (const [key, field, min, max] of [
      ['cold_daily_cap', 'coldDailyCap', 1, 100_000],
      ['cold_warmup_start', 'coldWarmupStart', 1, 100_000],
      ['cold_ramp_window_days', 'coldRampWindowDays', 1, 3_650],
      ['verify_daily_cap', 'verifyDailyCap', 0, 100_000],
      ['verify_batch_size', 'verifyBatchSize', 1, 200],
      ['verify_batch_pause_ms', 'verifyBatchPauseMs', 0, 3_600_000],
      ['verify_breaker_run', 'verifyBreakerRun', 1, 1_000],
    ] as const) {
      if (b[field] == null) continue;
      const n = Number(b[field]);
      if (!Number.isInteger(n) || n < min || n > max)
        return reply.code(400).send({ error: `${field} must be an integer between ${min} and ${max}` });
      patch[key] = String(n);
    }
    if (typeof b.optoutKeywords === 'string') patch.optout_keywords = b.optoutKeywords.trim();
    if (typeof b.optoutReply === 'string') patch.optout_reply = b.optoutReply.trim();
    if (b.notifyInstances !== undefined) {
      if (!Array.isArray(b.notifyInstances) || !b.notifyInstances.every((n) => typeof n === 'string'))
        return reply.code(400).send({ error: 'notifyInstances must be an array of channel names' });
      const names = (b.notifyInstances as string[]).map((n) => n.trim()).filter(Boolean);
      if (!names.every((n) => SAFE_INSTANCE.test(n)))
        return reply.code(400).send({ error: 'notifyInstances has an invalid channel name' });
      patch.notify_instances = names.join(',');
    }

    // ---- AI agent -------------------------------------------------------
    // The master switch and the line allow-list are what let the AI speak to a
    // customer at all, so they are validated exactly as strictly as the send
    // safety knobs above — and the allow-list reuses notifyInstances' own
    // channel-name guard rather than a looser one of its own.
    if (typeof b.aiAgentEnabled === 'boolean')
      patch.ai_agent_enabled = b.aiAgentEnabled ? '1' : '0';
    if (b.aiAgentInstances !== undefined) {
      if (
        !Array.isArray(b.aiAgentInstances) ||
        !b.aiAgentInstances.every((n) => typeof n === 'string')
      )
        return reply.code(400).send({ error: 'aiAgentInstances must be an array of channel names' });
      const names = (b.aiAgentInstances as string[]).map((n) => n.trim()).filter(Boolean);
      if (!names.every((n) => SAFE_INSTANCE.test(n)))
        return reply.code(400).send({ error: 'aiAgentInstances has an invalid channel name' });
      patch.ai_agent_instances = names.join(',');
    }
    if (b.aiAgentProvider != null) {
      if (!AI_PROVIDERS.includes(b.aiAgentProvider as never))
        return reply
          .code(400)
          .send({ error: `aiAgentProvider must be one of: ${AI_PROVIDERS.join(', ')}` });
      patch.ai_agent_provider = String(b.aiAgentProvider);
    }
    if (b.aiAgentModelTier != null) {
      if (!AI_MODEL_TIERS.includes(b.aiAgentModelTier as never))
        return reply
          .code(400)
          .send({ error: `aiAgentModelTier must be one of: ${AI_MODEL_TIERS.join(', ')}` });
      patch.ai_agent_model_tier = String(b.aiAgentModelTier);
    }
    if (typeof b.aiAgentModel === 'string') patch.ai_agent_model = b.aiAgentModel.trim().slice(0, 120);
    // Empty/missing means "keep the saved one", exactly like the Evolution key.
    if (typeof b.aiAgentApiKey === 'string' && b.aiAgentApiKey.trim())
      patch.ai_agent_apikey = b.aiAgentApiKey.trim();
    for (const [key, field] of [
      ['ai_agent_persona', 'aiAgentPersona'],
      ['ai_agent_rules', 'aiAgentRules'],
      ['ai_agent_escalation', 'aiAgentEscalation'],
    ] as const) {
      if (typeof b[field] !== 'string') continue;
      patch[key] = (b[field] as string).slice(0, MAX_INSTRUCTION_CHARS);
    }
    if (typeof b.aiAgentHandoffMessage === 'string')
      patch.ai_agent_handoff_message = b.aiAgentHandoffMessage.trim().slice(0, 1000);
    for (const [key, field, min, max] of [
      ['ai_agent_max_replies', 'aiAgentMaxRepliesPerSession', 1, 500],
      ['ai_agent_session_gap_hours', 'aiAgentSessionGapHours', 1, 8_760],
      ['ai_agent_daily_cap', 'aiAgentDailyCap', 0, 100_000],
      ['ai_agent_reply_delay_sec', 'aiAgentReplyDelaySec', 0, 3_600],
    ] as const) {
      if (b[field] == null) continue;
      const n = Number(b[field]);
      if (!Number.isInteger(n) || n < min || n > max)
        return reply
          .code(400)
          .send({ error: `${field} must be an integer between ${min} and ${max}` });
      patch[key] = String(n);
    }

    // The saved apikey is sent wherever base points — make redirections loud.
    if (patch.evo_base != null && patch.evo_base !== cfg.evo.base)
      app.log.warn(`settings: Evolution base URL changed ${cfg.evo.base || '(empty)'} → ${patch.evo_base}`);
    store.set(patch);
    store.applyTo(cfg); // live: sender/scheduler read cfg by reference
    relay.reconfigure(cfg.evo);
    return publicSettings(cfg);
  });

  // Probe a candidate connection (unsaved values allowed) without persisting.
  app.post('/api/settings/test', { preHandler: requireAdmin }, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const base = (typeof b.base === 'string' && b.base.trim() ? b.base.trim() : cfg.evo.base).replace(/\/+$/, '');
    const apikey = typeof b.apikey === 'string' && b.apikey.trim() ? b.apikey.trim() : cfg.evo.apikey;
    const instance = typeof b.instance === 'string' && b.instance.trim() ? b.instance.trim() : cfg.evo.instance;
    if (!base) return { ok: false, error: 'Server URL is empty' };
    try {
      const res = await fetch(`${base}/instance/fetchInstances`, {
        headers: { apikey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, error: `Evolution returned ${res.status} ${res.statusText}` };
      const data = (await res.json().catch(() => [])) as unknown;
      const list = Array.isArray(data) ? data : [];
      const found = list.some((i: any) => (i?.name ?? i?.instance?.instanceName ?? i?.instanceName) === instance);
      return {
        ok: true,
        instances: list.length,
        instanceFound: found,
      };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    }
  });
}
