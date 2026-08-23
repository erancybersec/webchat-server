import type { Db } from '../db/index.js';
import { contactKey } from './phone.js';

export interface QuotaConfig {
  coldCapEnabled: boolean;
  coldDailyCap: number;
  coldWarmupStart: number;
  /** Rolling window the ramp counts active days over; also the cold-send retention. Default 30. */
  coldRampWindowDays?: number;
}

export interface QuotaState {
  /** Cold contacts reached in the trailing 24h. */
  spent: number;
  /** Today's ceiling, after the warm-up ramp. */
  cap: number;
  remaining: number;
  /** Distinct earlier days with cold sends in the ramp window — the ramp's input. */
  activeDays: number;
  enabled: boolean;
}

/**
 * A single compose's override of the line's cold-contact ceiling, for that run
 * only — a flat number that replaces the warm-up ramp outright (no climbing),
 * and applies even while the site-wide cap toggle is off: setting one is a
 * deliberate per-send decision, not conditioned on an unrelated global switch.
 */
export interface ColdCapOverride {
  dailyCap: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_RAMP_WINDOW_DAYS = 30;

/**
 * Rations FIRST CONTACT, and nothing else.
 *
 * The unit is one cold RECIPIENT per rolling 24 hours, not one message: a
 * two-item sequence is still one stranger hearing from you for the first time,
 * and splitting a sequence across a cap boundary would leave someone with half
 * a conversation overnight. Messages to people you already have a thread with,
 * and to groups, are never counted here — they are not what gets a number
 * banned, and rationing them would make the tool useless for its day job.
 *
 * **The warm-up ramp.** A number with no bulk history that suddenly reaches
 * hundreds of strangers is the exact anomaly WhatsApp acts on, so the ceiling
 * starts low and doubles for each earlier day the line actually did cold
 * outreach: 10 → 20 → 40 → … up to `coldDailyCap`. Counting DISTINCT DAYS
 * rather than elapsed time means the ramp tracks demonstrated behavior, and a
 * line that goes quiet for a month starts gently again instead of inheriting a
 * ceiling it hasn't earned.
 */
export class ColdSendQuota {
  private readonly q;

  constructor(
    private readonly db: Db,
    private readonly cfg: QuotaConfig,
  ) {
    this.q = {
      spent: db.prepare(
        `SELECT COUNT(DISTINCT phone_number) AS n FROM cold_sends
         WHERE instance = ? AND sent_at > ?`,
      ),
      activeDays: db.prepare(
        `SELECT COUNT(DISTINCT substr(sent_at, 1, 10)) AS n FROM cold_sends
         WHERE instance = ? AND sent_at > ? AND substr(sent_at, 1, 10) < ?`,
      ),
      put: db.prepare(
        `INSERT INTO cold_sends (instance, phone_number, sent_at) VALUES (?, ?, ?)`,
      ),
      purge: db.prepare(`DELETE FROM cold_sends WHERE sent_at <= ?`),
    };
  }

  /** The ramp window in effect — configurable, defaulting to 30 days. */
  private get rampWindowDays(): number {
    return this.cfg.coldRampWindowDays ?? DEFAULT_RAMP_WINDOW_DAYS;
  }

  /** Today's ceiling for this line — a flat override bypasses the ramp entirely. */
  capFor(instance: string, now = new Date(), override?: ColdCapOverride): number {
    if (override) return Math.max(0, Math.floor(override.dailyCap));
    const { coldDailyCap, coldWarmupStart } = this.cfg;
    if (coldWarmupStart <= 0 || coldWarmupStart >= coldDailyCap) return coldDailyCap;
    const days = this.activeDays(instance, now);
    // 2**days overflows nothing here: it is clamped by coldDailyCap immediately
    const ramped = coldWarmupStart * 2 ** Math.min(days, 20);
    return Math.min(coldDailyCap, Math.floor(ramped));
  }

  /** Earlier days (not today) with cold sends, inside the ramp window. */
  activeDays(instance: string, now = new Date()): number {
    const since = new Date(now.getTime() - this.rampWindowDays * DAY_MS).toISOString();
    const today = now.toISOString().slice(0, 10);
    return (this.q.activeDays.get(instance, since, today) as { n: number }).n;
  }

  spent(instance: string, now = new Date()): number {
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    return (this.q.spent.get(instance, since) as { n: number }).n;
  }

  state(instance: string, now = new Date(), override?: ColdCapOverride): QuotaState {
    const enabled = this.cfg.coldCapEnabled || !!override;
    const cap = this.capFor(instance, now, override);
    const spent = this.spent(instance, now);
    return {
      spent,
      cap,
      remaining: enabled ? Math.max(0, cap - spent) : Number.POSITIVE_INFINITY,
      activeDays: this.activeDays(instance, now),
      enabled,
    };
  }

  /** How many more strangers this line may reach right now. */
  remaining(instance: string, now = new Date(), override?: ColdCapOverride): number {
    if (!this.cfg.coldCapEnabled && !override) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.capFor(instance, now, override) - this.spent(instance, now));
  }

  /**
   * Records one cold recipient actually reached. Idempotent per rolling window
   * by construction: `spent` counts DISTINCT numbers, so a retry or a second
   * item for the same person can't double-charge the budget.
   */
  record(instance: string, recipient: unknown, now = new Date()): void {
    const key = contactKey(recipient);
    if (!key) return;
    this.q.put.run(instance, key, now.toISOString());
  }

  /** Rows older than the ramp window carry no information — drop them. */
  purge(now = new Date()): number {
    return this.q.purge.run(new Date(now.getTime() - this.rampWindowDays * DAY_MS).toISOString())
      .changes;
  }
}
