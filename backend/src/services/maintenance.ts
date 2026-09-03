import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';

export interface StorageReport {
  disk: { totalBytes: number; freeBytes: number } | null;
  db: { sizeBytes: number; walBytes: number };
  tables: Record<string, number>;
  /** First day message stats exist for — "tracked since". */
  statsSince: string | null;
}

export interface CleanupResult {
  dryRun: boolean;
  olderThanDays: number;
  jobs: number;
  sends: number;
  messageAgents: number;
  messageCache: number;
  /** prior edit versions purged (message_edits rows). */
  messageEdits: number;
  reminders: number;
  /** DB file bytes before/after (after = before on a dry run). */
  bytesBefore: number;
  bytesAfter: number;
  vacuumed: boolean;
  note?: string;
}

const COUNTED_TABLES = [
  'jobs',
  'job_sends',
  'message_agents',
  'message_cache',
  'message_deletes',
  'message_edits',
  'message_editors',
  'message_reads',
  'message_stats',
  'message_stat_chats',
  'blacklist',
  'reminders',
  'chat_notes',
  'quick_replies',
] as const;

/**
 * Storage telemetry + retention for the app's own SQLite. The big Evolution
 * Postgres numbers come from fetchInstances `_count` (see /api/instances) —
 * this covers the half we own: the job ledger and attribution rows that grow
 * with every send, the disk they live on, and a retention policy so an
 * unattended server can't quietly fill it.
 */
export class MaintenanceService {
  constructor(
    private readonly db: Db,
    private readonly dbPath: string,
    /** Refuse VACUUM while a job is running — it stalls the whole process. */
    private readonly hasRunningJob: () => boolean = () => false,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  private fileBytes(p: string): number {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  }

  report(): StorageReport {
    let disk: StorageReport['disk'] = null;
    try {
      // the data dir's filesystem — in the container that's the bind mount,
      // i.e. the host disk that actually fills up
      const s = fs.statfsSync(path.dirname(path.resolve(this.dbPath)));
      disk = { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
    } catch {
      /* :memory: or platforms without statfs */
    }
    const tables: Record<string, number> = {};
    for (const t of COUNTED_TABLES) {
      try {
        tables[t] = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      } catch {
        tables[t] = 0;
      }
    }
    const page = this.db.pragma('page_count', { simple: true }) as number;
    const size = this.db.pragma('page_size', { simple: true }) as number;
    const since = this.db.prepare(`SELECT MIN(day) AS day FROM message_stats`).get() as {
      day: string | null;
    };
    return {
      disk,
      db: { sizeBytes: page * size, walBytes: this.fileBytes(`${this.dbPath}-wal`) },
      tables,
      statsSince: since.day,
    };
  }

  /**
   * Purge old finished work. Deliberately conservative:
   * - jobs: done/failed/missed finished before the cutoff, plus cancelled
   *   ones whose moment passed (cancel never sets finished_at). Pending,
   *   running and held-for-approval jobs are untouchable. The ledger rides
   *   along via ON DELETE CASCADE.
   * - message_agents / cached message bodies / fired reminders older than the
   *   cutoff.
   * - message_stats stay forever — they're tiny aggregates and the whole
   *   point of Insights history.
   * VACUUM is manual-only (vacuum=true) and skipped while a job runs: it
   * stalls the event loop for the duration and needs ~DB-size free disk.
   */
  cleanup(opts: {
    olderThanDays: number;
    dryRun?: boolean;
    vacuum?: boolean;
    /** PASSIVE checkpoint (no event-loop stall) — the automatic daily sweep. */
    gentle?: boolean;
  }): CleanupResult {
    const days = Math.max(1, Math.floor(opts.olderThanDays));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const dryRun = !!opts.dryRun;
    const bytesBefore =
      (this.db.pragma('page_count', { simple: true }) as number) *
      (this.db.pragma('page_size', { simple: true }) as number);

    const jobsWhere = `(status IN ('done','failed','missed') AND finished_at < @cutoff)
      OR (status = 'cancelled' AND scheduled_at < @cutoff)`;

    let jobs: number;
    let sends: number;
    let messageAgents: number;
    let messageCache: number;
    let messageEdits: number;
    let reminders: number;
    if (dryRun) {
      jobs = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${jobsWhere}`).get({ cutoff }) as { n: number }).n;
      sends = (this.db
        .prepare(`SELECT COUNT(*) AS n FROM job_sends WHERE job_id IN (SELECT id FROM jobs WHERE ${jobsWhere})`)
        .get({ cutoff }) as { n: number }).n;
      messageAgents = (this.db
        .prepare(`SELECT COUNT(*) AS n FROM message_agents WHERE sent_at < ?`)
        .get(cutoff) as { n: number }).n;
      messageCache = (this.db
        .prepare(`SELECT COUNT(*) AS n FROM message_cache WHERE created_at < ?`)
        .get(cutoff) as { n: number }).n;
      messageEdits = (this.db
        .prepare(`SELECT COUNT(*) AS n FROM message_edits WHERE edited_at < ?`)
        .get(cutoff) as { n: number }).n;
      reminders = (this.db
        .prepare(`SELECT COUNT(*) AS n FROM reminders WHERE status IN ('fired','dismissed') AND due_at < ?`)
        .get(cutoff) as { n: number }).n;
      return {
        dryRun, olderThanDays: days, jobs, sends, messageAgents, messageCache, messageEdits, reminders,
        bytesBefore, bytesAfter: bytesBefore, vacuumed: false,
      };
    }

    const counts = this.db.transaction(() => {
      const s = (this.db
        .prepare(`SELECT COUNT(*) AS n FROM job_sends WHERE job_id IN (SELECT id FROM jobs WHERE ${jobsWhere})`)
        .get({ cutoff }) as { n: number }).n;
      const j = this.db.prepare(`DELETE FROM jobs WHERE ${jobsWhere}`).run({ cutoff }).changes;
      const m = this.db.prepare(`DELETE FROM message_agents WHERE sent_at < ?`).run(cutoff).changes;
      const c = this.db.prepare(`DELETE FROM message_cache WHERE created_at < ?`).run(cutoff).changes;
      // read receipts grow one row per read sent message — prune with the cache
      this.db.prepare(`DELETE FROM message_reads WHERE read_at < ?`).run(cutoff);
      // shared unread state: a row per chat that received traffic — prune stale ones
      this.db.prepare(`DELETE FROM chat_unread WHERE updated_at < ?`).run(cutoff);
      // AI agent: the per-turn audit log, the daily-cap ledger, and settled
      // queue rows. ai_agent_chat_state is NOT swept — it is the AI's only
      // memory of a lead, and losing it silently would re-ask a returning
      // customer everything they already told us.
      this.db.prepare(`DELETE FROM ai_agent_audit_log WHERE created_at < ?`).run(cutoff);
      this.db.prepare(`DELETE FROM ai_agent_replies WHERE sent_at < ?`).run(cutoff);
      this.db
        .prepare(
          `DELETE FROM ai_agent_pending_sends
           WHERE status IN ('sent','failed','canceled') AND created_at < ?`,
        )
        .run(cutoff);
      const e = this.db.prepare(`DELETE FROM message_edits WHERE edited_at < ?`).run(cutoff).changes;
      const r = this.db
        .prepare(`DELETE FROM reminders WHERE status IN ('fired','dismissed') AND due_at < ?`)
        .run(cutoff).changes;
      return { j, s, m, c, e, r };
    })();
    jobs = counts.j;
    sends = counts.s;
    messageAgents = counts.m;
    messageCache = counts.c;
    messageEdits = counts.e;
    reminders = counts.r;

    this.db.pragma(`wal_checkpoint(${opts.gentle ? 'PASSIVE' : 'TRUNCATE'})`);
    let vacuumed = false;
    let note: string | undefined;
    if (opts.vacuum) {
      if (this.hasRunningJob()) {
        note = 'VACUUM skipped — a job is currently running';
      } else {
        this.db.exec('VACUUM');
        vacuumed = true;
      }
    }
    const bytesAfter =
      (this.db.pragma('page_count', { simple: true }) as number) *
      (this.db.pragma('page_size', { simple: true }) as number);
    this.log(
      `[maintenance] cleanup >${days}d: ${jobs} jobs, ${sends} sends, ${messageAgents} attributions, ${messageCache} cached bodies, ${messageEdits} edit versions, ${reminders} reminders` +
        (vacuumed ? `, vacuum ${bytesBefore} → ${bytesAfter} bytes` : ''),
    );
    return { dryRun, olderThanDays: days, jobs, sends, messageAgents, messageCache, messageEdits, reminders, bytesBefore, bytesAfter, vacuumed, note };
  }
}
