import path from 'node:path';

export interface EvolutionConfig {
  base: string;
  instance: string;
  apikey: string;
}

export interface Config {
  port: number;
  staticDir: string;
  dbPath: string;
  /** Empty string = API auth disabled (rely on an access proxy in front). */
  apiToken: string;
  delayMinMs: number;
  delayMaxMs: number;
  pollMs: number;
  /** Jobs overdue by more than this many minutes are marked missed. 0 = always fire. */
  maxOverdueMin: number;
  sendMaxAttempts: number;
  /**
   * Number verification: campaigns check every recipient against WhatsApp
   * before sending, and never send to one it says is not registered.
   * Off = the old behavior (send blind, learn from the 400).
   */
  verifyEnabled: boolean;
  /** Cache lifetimes. 'valid' outlives 'invalid' — see migration 019. */
  verifyValidDays: number;
  verifyInvalidDays: number;
  /**
   * Numbers per /chat/whatsappNumbers call, and the gap between calls.
   * These are paced for a BACKGROUND drip, not a pre-flight burst: 1,000
   * existence lookups fired off in under a minute is the signature of contact
   * scraping, whoever is doing it and whatever for.
   */
  verifyBatchSize: number;
  verifyBatchPauseMs: number;
  /** Ceiling on existence lookups per calendar day, across all sweeps. */
  verifyDailyCap: number;
  /**
   * Throttle guard: this many exists:false IN A ROW with no live number
   * between them reads as rate-limiting rather than a dead stretch of list,
   * because genuinely dead numbers are scattered through a list and throttled
   * ones are not. Tripping discards the suspect run and caches nothing.
   */
  verifyBreakerRun: number;
  /**
   * Cold-contact cap: how many people this line may reach FOR THE FIRST TIME
   * per rolling 24h. Recipients with an existing conversation, and groups, are
   * never counted — the cap rations unsolicited first contact, which is the
   * thing recipients report and WhatsApp acts on.
   */
  coldCapEnabled: boolean;
  coldDailyCap: number;
  /** Day-one ceiling; doubles per earlier day of cold sends up to the cap. */
  coldWarmupStart: number;
  /** Rolling window the ramp counts active days over; also the cold-send retention. */
  coldRampWindowDays: number;
  /** Relay Evolution websocket events to clients over SSE (/api/events). */
  eventsEnabled: boolean;
  /** Recurring jobs are opt-in (Settings toggle) so a stray repeat rule can't loop sends. */
  recurringEnabled: boolean;
  /** Quiet hours: due scheduled jobs are deferred to the window's end. */
  quietEnabled: boolean;
  quietStart: string; // 'HH:MM'
  quietEnd: string; // 'HH:MM'
  /** Agent identification: tag sends with the Cloudflare Access user (Settings toggle). */
  agentsEnabled: boolean;
  /**
   * Job approval: agents without the send-without-approval permission need an
   * approver for jobs with MORE than this many recipients ("bulk"). ≥ 1.
   */
  approvalThreshold: number;
  /** Auto-purge finished jobs/attribution older than this many days. 0 = off. */
  retentionDays: number;
  /** Auto opt-out: incoming keyword messages blacklist the sender. */
  optoutEnabled: boolean;
  optoutKeywords: string; // comma-separated exact matches
  optoutReply: string; // empty = no confirmation message
  /** VAPID "sub" claim for Web Push — a mailto: or https: contact. */
  vapidSubject: string;
  /**
   * Evolution lines whose incoming messages fire a push notification — the
   * complete allowlist, the default line included. Empty = no notifications
   * (Settings → Notifications controls this; nothing is implicit).
   */
  notifyInstances: string[];
  /**
   * AI agent for inbound leads. Read-only: it can retrieve knowledge/structured
   * studio data and request a human handoff, and has no tool that writes to any
   * business system. Master switch defaults OFF and the instance allow-list
   * defaults EMPTY — both must be set deliberately before a word is ever sent.
   */
  aiAgentEnabled: boolean;
  /** Explicit allow-list of Evolution lines the AI may answer on, like notifyInstances. */
  aiAgentInstances: string[];
  aiAgentProvider: AiProviderName;
  aiAgentModelTier: AiModelTier;
  /** Only consulted when aiAgentModelTier === 'custom'. */
  aiAgentModel: string;
  /** Never sent to the browser, never in prompts/tool results/the audit log. */
  aiAgentApiKey: string;
  /** Identity, tone, language, example replies. */
  aiAgentPersona: string;
  /** Studio-specific boundaries, on top of the fixed (code-level) safety rules. */
  aiAgentRules: string;
  /** Studio-specific handoff guidance, on top of the fixed safety rules. */
  aiAgentEscalation: string;
  /** Replies per AI SESSION, not lifetime — see the session-gap rollover. */
  aiAgentMaxRepliesPerSession: number;
  /** Idle gap that starts a fresh AI session for a returning lead. */
  aiAgentSessionGapHours: number;
  /** Global replies/day across every chat — a cost ceiling, not per-chat state. */
  aiAgentDailyCap: number;
  aiAgentHandoffMessage: string;
  /** Debounce before answering, so a lead typing three lines gets one reply. */
  aiAgentReplyDelaySec: number;
  evo: EvolutionConfig;
}

export type AiProviderName = 'anthropic' | 'openai';
export type AiModelTier = 'fast' | 'balanced' | 'best' | 'custom';

export const AI_PROVIDERS: readonly AiProviderName[] = ['anthropic', 'openai'];
export const AI_MODEL_TIERS: readonly AiModelTier[] = ['fast', 'balanced', 'best', 'custom'];

const DEFAULT_HANDOFF_MESSAGE = 'Let me get a team member to help with that.';

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Config: ${key}=${JSON.stringify(raw)} is not a number`);
  return n;
}

export function loadConfig(env: Env = process.env): Config {
  const delayMinMs = num(env, 'DELAY_MIN', 1) * 1000;
  const delayMaxMs = num(env, 'DELAY_MAX', 3) * 1000;
  if (delayMaxMs < delayMinMs) throw new Error('Config: DELAY_MAX must be >= DELAY_MIN');

  return {
    port: num(env, 'PORT', 8080),
    staticDir: path.resolve(env.STATIC_DIR || '../frontend/dist'),
    dbPath: env.DB_PATH || './data/webchat.db',
    apiToken: env.API_TOKEN || '',
    delayMinMs,
    delayMaxMs,
    pollMs: num(env, 'SCHED_POLL_MS', 15000),
    maxOverdueMin: num(env, 'MAX_OVERDUE_MIN', 0),
    sendMaxAttempts: Math.max(1, num(env, 'SEND_MAX_ATTEMPTS', 3)),
    verifyEnabled: env.VERIFY_ENABLED !== 'false',
    verifyValidDays: Math.max(1, num(env, 'VERIFY_VALID_DAYS', 180)),
    verifyInvalidDays: Math.max(1, num(env, 'VERIFY_INVALID_DAYS', 90)),
    verifyBatchSize: Math.min(200, Math.max(1, num(env, 'VERIFY_BATCH_SIZE', 10))),
    verifyBatchPauseMs: Math.max(0, num(env, 'VERIFY_BATCH_PAUSE_MS', 60_000)),
    verifyDailyCap: Math.max(0, num(env, 'VERIFY_DAILY_CAP', 400)),
    verifyBreakerRun: Math.max(1, num(env, 'VERIFY_BREAKER_RUN', 25)),
    coldCapEnabled: env.COLD_CAP_ENABLED !== 'false',
    coldDailyCap: Math.max(1, num(env, 'COLD_DAILY_CAP', 50)),
    coldWarmupStart: Math.max(1, num(env, 'COLD_WARMUP_START', 10)),
    coldRampWindowDays: Math.max(1, num(env, 'COLD_RAMP_WINDOW_DAYS', 30)),
    eventsEnabled: env.EVENTS_ENABLED !== 'false',
    recurringEnabled: env.RECURRING_ENABLED === 'true',
    quietEnabled: env.QUIET_ENABLED === 'true',
    quietStart: env.QUIET_START || '21:00',
    quietEnd: env.QUIET_END || '08:00',
    agentsEnabled: env.AGENTS_ENABLED === 'true',
    approvalThreshold: Math.max(1, num(env, 'APPROVAL_THRESHOLD', 1)),
    retentionDays: Math.max(0, num(env, 'RETENTION_DAYS', 0)),
    optoutEnabled: env.OPTOUT_ENABLED === 'true',
    optoutKeywords: env.OPTOUT_KEYWORDS ?? 'STOP, הסר',
    optoutReply: env.OPTOUT_REPLY ?? '',
    vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@webchat.local',
    notifyInstances: (env.NOTIFY_INSTANCES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    aiAgentEnabled: env.AI_AGENT_ENABLED === 'true',
    aiAgentInstances: (env.AI_AGENT_INSTANCES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    aiAgentProvider: AI_PROVIDERS.includes(env.AI_AGENT_PROVIDER as AiProviderName)
      ? (env.AI_AGENT_PROVIDER as AiProviderName)
      : 'anthropic',
    aiAgentModelTier: AI_MODEL_TIERS.includes(env.AI_AGENT_MODEL_TIER as AiModelTier)
      ? (env.AI_AGENT_MODEL_TIER as AiModelTier)
      : 'fast',
    aiAgentModel: env.AI_AGENT_MODEL ?? '',
    aiAgentApiKey: env.AI_AGENT_API_KEY ?? '',
    aiAgentPersona: env.AI_AGENT_PERSONA ?? '',
    aiAgentRules: env.AI_AGENT_RULES ?? '',
    aiAgentEscalation: env.AI_AGENT_ESCALATION ?? '',
    aiAgentMaxRepliesPerSession: Math.max(1, num(env, 'AI_AGENT_MAX_REPLIES', 20)),
    aiAgentSessionGapHours: Math.max(1, num(env, 'AI_AGENT_SESSION_GAP_HOURS', 48)),
    aiAgentDailyCap: Math.max(0, num(env, 'AI_AGENT_DAILY_CAP', 200)),
    aiAgentHandoffMessage: env.AI_AGENT_HANDOFF_MESSAGE ?? DEFAULT_HANDOFF_MESSAGE,
    aiAgentReplyDelaySec: Math.max(0, num(env, 'AI_AGENT_REPLY_DELAY_SEC', 10)),
    evo: {
      base: (env.EVOLUTION_BASE || '').replace(/\/+$/, ''),
      instance: env.EVOLUTION_INSTANCE || '',
      apikey: env.EVOLUTION_APIKEY || '',
    },
  };
}
