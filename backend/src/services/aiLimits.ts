/**
 * The AI agent's hard limits and its one fixed data shape.
 *
 * These are CODE constants, not settings: they are the cost/blast-radius
 * envelope the whole feature is designed inside, and an operator turning a
 * "max history" box up to 500 in a Settings form would quietly move the cost of
 * every reply without anyone reviewing it. Kept in their own module so the
 * stores, the provider adapters and the engine can all share them without any
 * import cycle between them.
 */

/** Recent messages sent as the reply context. */
export const MAX_HISTORY_MESSAGES = 6;
export const MAX_HISTORY_CHARS = 4000;
export const MAX_KNOWLEDGE_RESULTS = 3;
export const MAX_KNOWLEDGE_CHARS_PER_RESULT = 800;
export const MAX_TOOL_RESULT_BYTES = 4000;
export const MAX_OUTPUT_TOKENS = 300;
/** Provider rounds per turn; the last one pins tool_choice to respond_to_lead. */
export const MAX_TOOL_ROUNDS = 3;
/** Unsummarized messages that trigger one cheap summary-refresh call. */
export const SUMMARY_REFRESH_EVERY = 12;
/** Ceiling on the backward walk that counts them, so a long thread can't fan out. */
export const SUMMARY_LOOKBACK_CAP = 50;
export const MAX_SUMMARY_CHARS = 1200;
export const MAX_REPLY_CHARS = 1000;
export const MAX_HANDOFF_REASON_CHARS = 300;
/**
 * How old a spots_left recheck may be and still be quotable. Deliberately
 * measured against studio_offerings.availability_updated_at, never the row's
 * general updated_at — see StudioDataStore.
 */
export const AVAILABILITY_MAX_AGE_HOURS = 24;

/** Cap on a `search_knowledge` query string. */
export const MAX_QUERY_CHARS = 200;

/** How long a claimed pending-send row is considered in flight. */
export const PENDING_LEASE_MS = 120_000;
/** A daily-cap-blocked row is simply re-queued this far ahead — never failed. */
export const DAILY_CAP_RETRY_DELAY_SEC = 300;
/** One retry only, and only for a failure that provably never reached Evolution. */
export const MAX_SEND_ATTEMPTS = 2;

export const AGE_GROUPS = ['child', 'teen', 'adult'] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

export const DAYS_OF_WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

export const EXPERIENCE_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

/**
 * The ONLY per-lead memory the AI keeps, and a closed shape on purpose: anything
 * else the model tries to remember is dropped server-side before storage. This
 * is conversation memory so a returning lead isn't asked their child's age three
 * times — not a CRM record, and not a place for free-form notes about a person.
 */
export interface LeadContext {
  /** Truncated to 100 chars. */
  name: string | null;
  age_group: AgeGroup | null;
  /** Truncated to 100 chars. */
  branch_preference: string | null;
  experience_level: ExperienceLevel | null;
  /** Subset of DAYS_OF_WEEK, max 7 entries. */
  preferred_days: string[];
  /** Free-form short strings, max 10 entries, 50 chars each. */
  preferred_times: string[];
  trial_interest: boolean | null;
}

export const EMPTY_LEAD_CONTEXT: LeadContext = {
  name: null,
  age_group: null,
  branch_preference: null,
  experience_level: null,
  preferred_days: [],
  preferred_times: [],
  trial_interest: null,
};

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s || null;
};

/**
 * The server-side allowlist every `memory_updates` payload passes through.
 * Unknown keys are dropped silently, known keys are shape- and length-checked,
 * and an out-of-enum value is dropped rather than stored: the model does not get
 * to widen this schema by asking, and a malformed field must never make it into
 * the facts block of the next prompt.
 */
export function sanitizeLeadContext(raw: unknown): Partial<LeadContext> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<LeadContext> = {};
  if ('name' in r) out.name = str(r.name, 100);
  if ('branch_preference' in r) out.branch_preference = str(r.branch_preference, 100);
  if ('age_group' in r)
    out.age_group = AGE_GROUPS.includes(r.age_group as AgeGroup) ? (r.age_group as AgeGroup) : null;
  if ('experience_level' in r)
    out.experience_level = EXPERIENCE_LEVELS.includes(r.experience_level as ExperienceLevel)
      ? (r.experience_level as ExperienceLevel)
      : null;
  if ('preferred_days' in r && Array.isArray(r.preferred_days))
    out.preferred_days = [
      ...new Set(
        r.preferred_days
          .filter((d): d is string => typeof d === 'string')
          .map((d) => d.trim().toLowerCase())
          .filter((d) => (DAYS_OF_WEEK as readonly string[]).includes(d)),
      ),
    ].slice(0, 7);
  if ('preferred_times' in r && Array.isArray(r.preferred_times))
    out.preferred_times = [
      ...new Set(
        r.preferred_times
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim().slice(0, 50))
          .filter(Boolean),
      ),
    ].slice(0, 10);
  if ('trial_interest' in r)
    out.trial_interest = typeof r.trial_interest === 'boolean' ? r.trial_interest : null;
  return out;
}

/** A stored facts blob back into the closed shape, tolerating anything on disk. */
export function parseLeadContext(json: string): LeadContext {
  try {
    return { ...EMPTY_LEAD_CONTEXT, ...sanitizeLeadContext(JSON.parse(json)) };
  } catch {
    return { ...EMPTY_LEAD_CONTEXT };
  }
}
