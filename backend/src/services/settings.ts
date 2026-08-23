import type { Config } from '../config.js';
import type { Db } from '../db/index.js';

/** Keys persisted in the settings table. */
export type SettingKey =
  | 'evo_base'
  | 'evo_instance'
  | 'evo_apikey'
  | 'delay_min'
  | 'delay_max'
  | 'recurring_enabled'
  | 'quiet_enabled'
  | 'quiet_start'
  | 'quiet_end'
  | 'optout_enabled'
  | 'optout_keywords'
  | 'optout_reply'
  | 'agents_enabled'
  | 'approval_threshold'
  | 'retention_days'
  | 'notify_instances'
  | 'verify_enabled'
  | 'verify_valid_days'
  | 'verify_invalid_days'
  | 'verify_daily_cap'
  | 'verify_batch_size'
  | 'verify_batch_pause_ms'
  | 'verify_breaker_run'
  | 'cold_cap_enabled'
  | 'cold_daily_cap'
  | 'cold_warmup_start'
  | 'cold_ramp_window_days';

/**
 * Operator settings stored in SQLite. Saved values override env config —
 * `applyTo` mutates the live Config object in place, which propagates
 * immediately because EvolutionClient/Scheduler hold it by reference.
 */
export class SettingsStore {
  constructor(private readonly db: Db) {}

  all(): Partial<Record<SettingKey, string>> {
    const rows = this.db.prepare(`SELECT key, value FROM settings`).all() as Array<{
      key: SettingKey;
      value: string;
    }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  set(values: Partial<Record<SettingKey, string>>): void {
    const upsert = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (value != null) upsert.run(key, value);
      }
    })();
  }

  applyTo(cfg: Config): void {
    const s = this.all();
    if (s.evo_base != null) cfg.evo.base = s.evo_base.replace(/\/+$/, '');
    if (s.evo_instance != null) cfg.evo.instance = s.evo_instance;
    if (s.evo_apikey != null) cfg.evo.apikey = s.evo_apikey;
    const min = Number(s.delay_min);
    const max = Number(s.delay_max);
    if (s.delay_min != null && Number.isFinite(min)) cfg.delayMinMs = min * 1000;
    if (s.delay_max != null && Number.isFinite(max)) cfg.delayMaxMs = max * 1000;
    if (s.recurring_enabled != null) cfg.recurringEnabled = s.recurring_enabled === '1';
    if (s.quiet_enabled != null) cfg.quietEnabled = s.quiet_enabled === '1';
    if (s.quiet_start != null) cfg.quietStart = s.quiet_start;
    if (s.quiet_end != null) cfg.quietEnd = s.quiet_end;
    if (s.optout_enabled != null) cfg.optoutEnabled = s.optout_enabled === '1';
    if (s.optout_keywords != null) cfg.optoutKeywords = s.optout_keywords;
    if (s.optout_reply != null) cfg.optoutReply = s.optout_reply;
    if (s.agents_enabled != null) cfg.agentsEnabled = s.agents_enabled === '1';
    const threshold = Number(s.approval_threshold);
    if (s.approval_threshold != null && Number.isInteger(threshold) && threshold >= 1)
      cfg.approvalThreshold = threshold;
    const retention = Number(s.retention_days);
    if (s.retention_days != null && Number.isInteger(retention) && retention >= 0)
      cfg.retentionDays = retention;
    if (s.verify_enabled != null) cfg.verifyEnabled = s.verify_enabled === '1';
    const validDays = Number(s.verify_valid_days);
    if (s.verify_valid_days != null && Number.isInteger(validDays) && validDays >= 1)
      cfg.verifyValidDays = validDays;
    const invalidDays = Number(s.verify_invalid_days);
    if (s.verify_invalid_days != null && Number.isInteger(invalidDays) && invalidDays >= 1)
      cfg.verifyInvalidDays = invalidDays;
    // The sweep's pacing, clamped exactly as config.ts clamps the env vars —
    // a saved value must never reach somewhere an env var could not.
    const dailyCap = Number(s.verify_daily_cap);
    if (s.verify_daily_cap != null && Number.isInteger(dailyCap) && dailyCap >= 0)
      cfg.verifyDailyCap = dailyCap;
    const batchSize = Number(s.verify_batch_size);
    if (s.verify_batch_size != null && Number.isInteger(batchSize) && batchSize >= 1)
      cfg.verifyBatchSize = Math.min(200, batchSize);
    const batchPause = Number(s.verify_batch_pause_ms);
    if (s.verify_batch_pause_ms != null && Number.isInteger(batchPause) && batchPause >= 0)
      cfg.verifyBatchPauseMs = batchPause;
    const breakerRun = Number(s.verify_breaker_run);
    if (s.verify_breaker_run != null && Number.isInteger(breakerRun) && breakerRun >= 1)
      cfg.verifyBreakerRun = breakerRun;
    if (s.cold_cap_enabled != null) cfg.coldCapEnabled = s.cold_cap_enabled === '1';
    const coldCap = Number(s.cold_daily_cap);
    if (s.cold_daily_cap != null && Number.isInteger(coldCap) && coldCap >= 1)
      cfg.coldDailyCap = coldCap;
    const coldStart = Number(s.cold_warmup_start);
    if (s.cold_warmup_start != null && Number.isInteger(coldStart) && coldStart >= 1)
      cfg.coldWarmupStart = coldStart;
    const coldRampWindow = Number(s.cold_ramp_window_days);
    if (s.cold_ramp_window_days != null && Number.isInteger(coldRampWindow) && coldRampWindow >= 1)
      cfg.coldRampWindowDays = coldRampWindow;
    if (s.notify_instances != null)
      cfg.notifyInstances = s.notify_instances
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
  }
}
