import type { Db } from '../db/index.js';
import { inQuietHours } from './scheduler.js';

/**
 * Per-person notification preferences. Keyed by the Cloudflare Access identity
 * (agent email); '' = anonymous / identification off, a single shared row.
 * Layered ON TOP of the global `notify_instances` allowlist (which lines are
 * eligible at all) — these decide which *categories* ping a given person.
 */
export interface NotifyPrefs {
  /** Notify on group (@g.us) messages. */
  groups: boolean;
  /** Notify on direct (1:1) messages. */
  dms: boolean;
  /** Push when a job this person created finishes. */
  jobsEnded: boolean;
  /** Only notify about a finished job when it had failures. */
  jobsFailuresOnly: boolean;
  /** Mute window for notifications (distinct from send-side quiet hours). */
  quietEnabled: boolean;
  quietStart: string; // 'HH:MM'
  quietEnd: string; // 'HH:MM'
  /** Comma-separated; a hit pierces category mute AND quiet hours. */
  keywords: string;
}

/** Defaults preserve today's behavior for anyone who never opens the card. */
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  groups: true,
  dms: true,
  jobsEnded: true,
  jobsFailuresOnly: false,
  quietEnabled: false,
  quietStart: '21:00',
  quietEnd: '08:00',
  keywords: '',
};

interface PrefsRow {
  agent_email: string;
  groups: number;
  dms: number;
  jobs_ended: number;
  jobs_failures_only: number;
  quiet_enabled: number;
  quiet_start: string;
  quiet_end: string;
  keywords: string;
}

const rowToPrefs = (r: PrefsRow): NotifyPrefs => ({
  groups: !!r.groups,
  dms: !!r.dms,
  jobsEnded: !!r.jobs_ended,
  jobsFailuresOnly: !!r.jobs_failures_only,
  quietEnabled: !!r.quiet_enabled,
  quietStart: r.quiet_start,
  quietEnd: r.quiet_end,
  keywords: r.keywords,
});

/** Whether `text` contains any of the comma-separated keywords (case-insensitive). */
export function keywordHit(text: string, keywords: string): boolean {
  const kws = keywords
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  if (!kws.length) return false;
  const t = text.toLowerCase();
  return kws.some((k) => t.includes(k));
}

/**
 * Message rule (shared with the in-page gate in the frontend — keep in sync):
 * a keyword hit always notifies; otherwise quiet hours mute everything; else
 * the per-category toggle decides.
 */
export function shouldNotifyMessage(
  p: NotifyPrefs,
  opts: { isGroup: boolean; text: string; now?: Date },
): boolean {
  if (keywordHit(opts.text, p.keywords)) return true;
  if (p.quietEnabled && inQuietHours(opts.now ?? new Date(), p.quietStart, p.quietEnd)) return false;
  return opts.isGroup ? p.groups : p.dms;
}

/** Job-ended rule: off → never; failures-only → only when failed>0; else quiet hours apply. */
export function shouldNotifyJob(p: NotifyPrefs, opts: { failed: number; now?: Date }): boolean {
  if (!p.jobsEnded) return false;
  if (p.jobsFailuresOnly && opts.failed <= 0) return false;
  if (p.quietEnabled && inQuietHours(opts.now ?? new Date(), p.quietStart, p.quietEnd)) return false;
  return true;
}

export class NotifyPrefsStore {
  private readonly q;

  constructor(private readonly db: Db) {
    this.q = {
      get: db.prepare(`SELECT * FROM notify_prefs WHERE agent_email = ?`),
      put: db.prepare(`INSERT INTO notify_prefs
        (agent_email, groups, dms, jobs_ended, jobs_failures_only, quiet_enabled, quiet_start, quiet_end, keywords)
        VALUES (@agent_email, @groups, @dms, @jobs_ended, @jobs_failures_only, @quiet_enabled, @quiet_start, @quiet_end, @keywords)
        ON CONFLICT(agent_email) DO UPDATE SET
          groups = excluded.groups, dms = excluded.dms, jobs_ended = excluded.jobs_ended,
          jobs_failures_only = excluded.jobs_failures_only, quiet_enabled = excluded.quiet_enabled,
          quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, keywords = excluded.keywords`),
    };
  }

  /** Saved prefs for an agent, with defaults filled in for a missing row. */
  get(email: string): NotifyPrefs {
    const r = this.q.get.get(email) as PrefsRow | undefined;
    return r ? rowToPrefs(r) : { ...DEFAULT_NOTIFY_PREFS };
  }

  /** Partial update — unspecified fields keep their current (or default) value. */
  set(email: string, patch: Partial<NotifyPrefs>): NotifyPrefs {
    const next: NotifyPrefs = { ...this.get(email), ...patch };
    this.q.put.run({
      agent_email: email,
      groups: next.groups ? 1 : 0,
      dms: next.dms ? 1 : 0,
      jobs_ended: next.jobsEnded ? 1 : 0,
      jobs_failures_only: next.jobsFailuresOnly ? 1 : 0,
      quiet_enabled: next.quietEnabled ? 1 : 0,
      quiet_start: next.quietStart,
      quiet_end: next.quietEnd,
      keywords: next.keywords,
    });
    return next;
  }
}
