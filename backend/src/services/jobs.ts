import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { inQuietHours, nextClockTime } from './time.js';
import type {
  BatchRule,
  CampaignProgress,
  Job,
  JobItem,
  JobPage,
  JobScope,
  JobSend,
  JobStatus,
  Recipient,
  RepeatRule,
  SendStatus,
} from '../types.js';

/**
 * How long `pending` messages will actually take at `ratePerMin`, honoring a
 * `batch` rule's boundaries — both the batch-size wait and the sending-hours
 * window, which a plain `pending/ratePerMin` division ignores. `null` means
 * "no honest number exists": the pacing ahead depends on a human (a manual
 * batch wait, or a window with no auto-resume), and guessing when a human
 * will act would only look precise.
 *
 * The window is checked continuously (not just at batch boundaries) via
 * `capByWindow`, so a window-only rule (no batch size at all) still stops the
 * simulated clock at the cutoff instead of running straight through it.
 */
export function estimatePendingMinutes(
  pending: number,
  ratePerMin: number,
  batch: BatchRule | null,
  now = new Date(),
): number | null {
  if (pending <= 0 || !ratePerMin) return null;
  const hasBatch = !!batch?.size;
  const hasWindow = !!batch?.pauseAt;
  if (hasBatch && batch!.pauseMin === 0) return null; // a manual batch wait is ahead
  if (hasWindow && !batch!.resumeAt) return null; // a manual window wait is ahead
  if (!hasBatch && !hasWindow) return pending / ratePerMin;

  const pauseAt = batch!.pauseAt;
  const resumeAt = batch!.resumeAt;
  // a ranged wait's expected cost, for an estimate — the run itself rolls fresh
  const waitPerBoundaryMin = hasBatch
    ? batch!.pauseMinMax && batch!.pauseMinMax > batch!.pauseMin
      ? (batch!.pauseMin + batch!.pauseMinMax) / 2
      : batch!.pauseMin
    : 0;
  const msPerMsg = 60_000 / ratePerMin;

  let cursor = now.getTime();
  let remaining = pending;
  let sinceBoundary = 0; // wire attempts since the last batch boundary/window resume
  let guard = 0; // a pathological rule (e.g. a window that never opens) must not hang
  while (remaining > 0 && guard++ < 100_000) {
    if (hasWindow && inQuietHours(new Date(cursor), pauseAt!, resumeAt!)) {
      // a fresh run starts counting its own batch from zero, exactly as a real
      // resume after a window pause is a new runJob() call
      cursor = nextClockTime(new Date(cursor), resumeAt!).getTime();
      sinceBoundary = 0;
    }
    const windowEnd = hasWindow ? nextClockTime(new Date(cursor), pauseAt!).getTime() : Infinity;
    const capByWindow = hasWindow ? Math.max(0, Math.floor((windowEnd - cursor) / msPerMsg)) : Infinity;
    const capByBatch = hasBatch ? batch!.size! - sinceBoundary : Infinity;
    const chunk = Math.min(remaining, capByWindow, capByBatch);
    if (chunk <= 0) {
      // essentially at the cutoff already (rounding) — jump straight to it so
      // the top-of-loop check crosses into the resume branch next pass,
      // rather than spinning in place forever
      cursor = windowEnd;
      continue;
    }
    cursor += chunk * msPerMsg;
    remaining -= chunk;
    sinceBoundary += chunk;
    if (remaining <= 0) break;
    if (hasBatch && sinceBoundary >= batch!.size!) {
      cursor += waitPerBoundaryMin * 60_000;
      sinceBoundary = 0;
    }
  }
  return (cursor - now.getTime()) / 60_000;
}

// The two job lists the UI shows. Immediate ("send now") jobs always belong to
// history — even while pending/running — so the Scheduled tab stays a queue of
// upcoming work and History is the record of everything composed. Jobs held
// for approval live in the Scheduled queue whatever their type: they are
// upcoming work, and History's bulk clears must never delete them.
const SCHEDULED_SCOPE = `((status IN ('pending','running','paused','cancelled') AND COALESCE(type,'') != 'immediate')
  OR status = 'pending_approval')`;
const HISTORY_SCOPE = `(status IN ('done','failed','missed')
  OR (COALESCE(type,'') = 'immediate' AND status != 'pending_approval'))`;

// Statuses a bulk clear must never touch: a paused campaign is half-sent work
// waiting for a human, and its ledger is the record of who already got it.
const LIVE_STATUSES = `('pending','running','paused','pending_approval')`;

// Per-instance separation. A row's effective instance is its own, or the server
// default when blank (matching how a job resolves instance || default at fire
// time). @eff='' = no filter (single-instance deployments, internal callers).
const INSTANCE_SCOPE = `(@eff = '' OR COALESCE(NULLIF(instance,''), @def) = @eff)`;

/** Restrict a read to one Evolution line. eff='' (the default) = no filter. */
export interface InstanceFilter {
  /** Effective instance to match: the requested one, or the server default. */
  eff: string;
  /** Server default — blank-instance rows belong here. */
  def: string;
}
const NO_FILTER: InstanceFilter = { eff: '', def: '' };

// Search across a job's recipients (id + display name) and message content —
// both are JSON blobs, so a plain substring match (no digit-stripping, unlike
// job_sends' normalized-phone search) covers a phone or a name either way.
// @q IS NULL short-circuits when no search term was given.
const JOB_TEXT_MATCH = `(@q IS NULL OR recipients LIKE '%'||@q||'%' OR items LIKE '%'||@q||'%')`;

interface JobRow {
  id: string;
  scheduled_at: string;
  status: JobStatus;
  type: string | null;
  recipients: string;
  items: string;
  result: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  repeat: string | null;
  sent_by: string | null;
  instance: string | null;
  batch: string | null;
  hold_reason: string | null;
}

interface SendRow {
  job_id: string;
  recipient: string;
  is_group: number;
  item_index: number;
  status: SendStatus;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  message_id: string | null;
  delivered_at: string | null;
  read_at: string | null;
}

function parseRepeat(raw: string | null): RepeatRule | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as RepeatRule;
    return r && typeof r.freq === 'string' ? r : null;
  } catch {
    return null;
  }
}

function parseBatch(raw: string | null): BatchRule | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as BatchRule;
    // a rule is meaningful with a batch size, a clock cutoff, a per-compose
    // cold-cap override, or any combination of the three
    const sized = Number.isFinite(b?.size) && (b.size as number) > 0;
    return b && (sized || typeof b.pauseAt === 'string' || !!b.coldCap) ? b : null;
  } catch {
    return null;
  }
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    scheduledAt: r.scheduled_at,
    status: r.status,
    type: r.type,
    recipients: JSON.parse(r.recipients),
    items: JSON.parse(r.items),
    result: r.result,
    createdAt: r.created_at,
    startedAt: r.started_at,
    ranAt: r.finished_at,
    repeat: parseRepeat(r.repeat),
    sentBy: r.sent_by,
    instance: r.instance,
    batch: parseBatch(r.batch),
  };
}

function sendRowToJobSend(r: SendRow): JobSend {
  return {
    jobId: r.job_id,
    recipient: r.recipient,
    isGroup: !!r.is_group,
    itemIndex: r.item_index,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    sentAt: r.sent_at,
    messageId: r.message_id,
    deliveredAt: r.delivered_at,
    readAt: r.read_at,
  };
}

export interface UpsertInput {
  id?: string;
  scheduledAt: string;
  status?: JobStatus;
  type?: string;
  recipients: Recipient[];
  items: JobItem[];
  result?: string;
  createdAt?: string;
  /** undefined = keep existing rule on edit; null = clear it. */
  repeat?: RepeatRule | null;
  /** Agent email (Cloudflare Access identity). The creator's stamp survives edits. */
  sentBy?: string;
  /** undefined = keep existing on edit; null = default instance. */
  instance?: string | null;
  /** undefined = keep existing pacing on edit; null = clear it (one run). */
  batch?: BatchRule | null;
}

export class JobStore {
  private readonly q;
  constructor(private readonly db: Db) {
    this.q = {
      upsert: db.prepare(`INSERT INTO jobs
        (id, scheduled_at, status, type, recipients, items, result, created_at, repeat, sent_by, instance, batch)
        VALUES (@id,@scheduled_at,@status,@type,@recipients,@items,@result,@created_at,@repeat,@sent_by,@instance,@batch)
        ON CONFLICT(id) DO UPDATE SET
          scheduled_at=excluded.scheduled_at, status=excluded.status, type=excluded.type,
          recipients=excluded.recipients, items=excluded.items, result=excluded.result,
          repeat=excluded.repeat, instance=excluded.instance, batch=excluded.batch,
          sent_by=COALESCE(jobs.sent_by, excluded.sent_by)`),
      all: db.prepare(`SELECT * FROM jobs WHERE ${INSTANCE_SCOPE} ORDER BY created_at DESC`),
      // newest-first (and an ascending counterpart) for both the queue and the
      // record; @q matches recipient/message text — same "JSON blob, plain
      // LIKE" idiom as sendsPage's recipient search below
      pageScheduledDesc: db.prepare(`SELECT * FROM jobs WHERE ${SCHEDULED_SCOPE}
        AND ${INSTANCE_SCOPE}
        AND (@status IS NULL OR status=@status)
        AND ${JOB_TEXT_MATCH}
        ORDER BY scheduled_at DESC, created_at DESC LIMIT @limit OFFSET @offset`),
      pageScheduledAsc: db.prepare(`SELECT * FROM jobs WHERE ${SCHEDULED_SCOPE}
        AND ${INSTANCE_SCOPE}
        AND (@status IS NULL OR status=@status)
        AND ${JOB_TEXT_MATCH}
        ORDER BY scheduled_at ASC, created_at ASC LIMIT @limit OFFSET @offset`),
      pageHistoryDesc: db.prepare(`SELECT * FROM jobs WHERE ${HISTORY_SCOPE}
        AND ${INSTANCE_SCOPE}
        AND (@status IS NULL OR status=@status)
        AND ${JOB_TEXT_MATCH}
        ORDER BY scheduled_at DESC, created_at DESC LIMIT @limit OFFSET @offset`),
      pageHistoryAsc: db.prepare(`SELECT * FROM jobs WHERE ${HISTORY_SCOPE}
        AND ${INSTANCE_SCOPE}
        AND (@status IS NULL OR status=@status)
        AND ${JOB_TEXT_MATCH}
        ORDER BY scheduled_at ASC, created_at ASC LIMIT @limit OFFSET @offset`),
      countScheduled: db.prepare(
        `SELECT status, COUNT(*) AS n FROM jobs WHERE ${SCHEDULED_SCOPE} AND ${INSTANCE_SCOPE} AND ${JOB_TEXT_MATCH} GROUP BY status`,
      ),
      countHistory: db.prepare(
        `SELECT status, COUNT(*) AS n FROM jobs WHERE ${HISTORY_SCOPE} AND ${INSTANCE_SCOPE} AND ${JOB_TEXT_MATCH} GROUP BY status`,
      ),
      // @tzMod shifts scheduled_at (stored UTC) to the viewer's local time
      // before taking the date, e.g. '180 minutes' for UTC+3 — otherwise a
      // late-evening local job buckets under the wrong day, silently
      // breaking the volume strip's "click a day, jump to it" in any
      // non-UTC timezone (which is every real deployment of this app).
      volumePerDay: db.prepare(
        `SELECT date(datetime(scheduled_at, @tzMod)) AS day, COUNT(*) AS n FROM jobs
         WHERE ${HISTORY_SCOPE} AND ${INSTANCE_SCOPE} AND date(datetime(scheduled_at, @tzMod)) >= @cutoff
         GROUP BY day ORDER BY day`,
      ),
      byId: db.prepare(`SELECT * FROM jobs WHERE id=?`),
      due: db.prepare(
        `SELECT * FROM jobs WHERE status='pending' AND scheduled_at<=? ORDER BY scheduled_at ASC`,
      ),
      // while agent identification is OFF the approval hold is inert: held
      // jobs fire as if pending, WITHOUT mutating their status — flipping the
      // toggle off briefly must not permanently release every held job
      dueWithHeld: db.prepare(
        `SELECT * FROM jobs WHERE status IN ('pending','pending_approval') AND scheduled_at<=?
         ORDER BY scheduled_at ASC`,
      ),
      setStatus: db.prepare(`UPDATE jobs SET status=? WHERE id=?`),
      // started_at is the moment the CAMPAIGN began, not this batch: a job that
      // resumes after a pause keeps its original stamp, which is what tells the
      // overdue guard it is half-sent work rather than a job that never fired.
      markRunning: db.prepare(
        `UPDATE jobs SET status='running', started_at=COALESCE(started_at, ?), hold_reason=NULL, result=NULL
         WHERE id=? AND status='pending' AND scheduled_at<=?`,
      ),
      markRunningWithHeld: db.prepare(
        `UPDATE jobs SET status='running', started_at=COALESCE(started_at, ?), hold_reason=NULL, result=NULL
         WHERE id=? AND status IN ('pending','pending_approval') AND scheduled_at<=?`,
      ),
      // a user's cancel (or pause) must never be overwritten by done/failed/
      // missed — only a finalize that itself reports that same status may
      // touch such a job, which is what makes a pause landing in the
      // finalize gap safe: the job stays paused with its ledger intact
      finish: db.prepare(`UPDATE jobs SET status=@status, result=@result, finished_at=@now, hold_reason=NULL
        WHERE id=@id AND (status NOT IN ('cancelled','paused') OR @status=status)`),
      // progress note on a job that is NOT finished (paused / between batches)
      setResult: db.prepare(`UPDATE jobs SET result=? WHERE id=?`),
      setHold: db.prepare(`UPDATE jobs SET hold_reason=? WHERE id=?`),
      holdReason: db.prepare(`SELECT hold_reason AS why FROM jobs WHERE id=?`),
      del: db.prepare(`DELETE FROM jobs WHERE id=?`),
      clearDone: db.prepare(`DELETE FROM jobs WHERE status NOT IN ${LIVE_STATUSES}`),
      // scoped clears so wiping History never deletes a restorable cancelled
      // job from the Scheduled queue (and vice versa)
      clearScheduled: db.prepare(`DELETE FROM jobs WHERE ${SCHEDULED_SCOPE} AND status='cancelled'`),
      clearHistory: db.prepare(
        `DELETE FROM jobs WHERE ${HISTORY_SCOPE} AND status NOT IN ${LIVE_STATUSES}`,
      ),
      recover: db.prepare(`UPDATE jobs SET status='pending' WHERE status='running'`),
      // approval release: a job whose moment passed while it sat in the queue
      // fires now instead of being finalized 'missed' by the overdue guard
      // Campaign control. A pause is honored mid-run: the scheduler re-reads
      // the status between sends, so 'running' -> 'paused' stops it after the
      // send in flight, with every unsent ledger row left pending.
      pause: db.prepare(`UPDATE jobs SET status='paused' WHERE id=? AND status IN ('pending','running')`),
      // Continue: back in the queue, due now. Resuming is NOT re-approved —
      // the job was already released once and is half-sent. It covers all
      // three ways a campaign can be sitting still: paused for a human, waiting
      // out an unattended batch pause ('pending' + a fire time in the future),
      // and stopped after it had already sent something.
      resume: db.prepare(`UPDATE jobs SET status='pending', scheduled_at=@now
        WHERE id=@id AND (status='paused'
          OR (status IN ('pending','cancelled') AND started_at IS NOT NULL))`),
      // A batch boundary or clock cutoff with an auto-continue: out of
      // 'running' without finalizing, due again at @at.
      requeueAt: db.prepare(`UPDATE jobs SET status='pending', scheduled_at=@at
        WHERE id=@id AND status='running'`),
      // ... and one that waits for a human instead.
      holdPaused: db.prepare(`UPDATE jobs SET status='paused' WHERE id=? AND status='running'`),

      approve: db.prepare(`UPDATE jobs SET status='pending',
        scheduled_at = CASE WHEN scheduled_at <= @now THEN @now ELSE scheduled_at END
        WHERE id=@id AND status='pending_approval'`),

      sendInsert: db.prepare(`INSERT OR IGNORE INTO job_sends
        (job_id, recipient, is_group, item_index) VALUES (?, ?, ?, ?)`),
      sendsDeleteByJob: db.prepare(`DELETE FROM job_sends WHERE job_id=?`),
      sendsPending: db.prepare(
        `SELECT * FROM job_sends WHERE job_id=? AND status='pending'
         ORDER BY recipient, item_index`,
      ),
      sendsAll: db.prepare(`SELECT * FROM job_sends WHERE job_id=?`),
      // One page of the ledger for the campaign panel: the same rows, filtered
      // server-side so a 1000-recipient job never ships whole to a browser.
      // @q matches the recipient digits (the name lives in the browser).
      sendsPage: db.prepare(`SELECT * FROM job_sends WHERE job_id=@jobId
        AND (@status IS NULL OR status=@status)
        AND (@q IS NULL OR recipient LIKE '%' || @q || '%')
        ORDER BY recipient, item_index LIMIT @limit OFFSET @offset`),
      sendsPageCount: db.prepare(`SELECT COUNT(*) AS n FROM job_sends WHERE job_id=@jobId
        AND (@status IS NULL OR status=@status)
        AND (@q IS NULL OR recipient LIKE '%' || @q || '%')`),
      sendCounts: db.prepare(
        `SELECT status, COUNT(*) AS n FROM job_sends WHERE job_id=? GROUP BY status`,
      ),
      sendSpan: db.prepare(
        `SELECT MIN(sent_at) AS first, MAX(sent_at) AS last FROM job_sends
         WHERE job_id=? AND sent_at IS NOT NULL AND status='sent'`,
      ),
      // Distinct contacts behind each status — a sequence's per-status message
      // count double-counts a recipient who has several items in that status,
      // so this is a different (and smaller) number per status.
      sendContactsByStatus: db.prepare(
        `SELECT status, COUNT(DISTINCT recipient) AS n FROM job_sends
         WHERE job_id=? AND recipient != 'status@broadcast' GROUP BY status`,
      ),
      // The union across failed+pending, deduped once — contacts.failed +
      // contacts.pending would double-count anyone with items in both statuses.
      notSentContacts: db.prepare(
        `SELECT COUNT(DISTINCT recipient) AS n FROM job_sends
         WHERE job_id=? AND recipient != 'status@broadcast' AND status IN ('failed', 'pending')`,
      ),
      // The most recent sends, for measuring the CURRENT pace. Newest first and
      // deliberately a SHORT window: a campaign's pace is what it is doing now,
      // not what it averaged over three days — and if the operator changes the
      // send gap in Settings mid-campaign, a long window would keep quoting the
      // old pace for ages.
      recentSends: db.prepare(
        `SELECT sent_at FROM job_sends WHERE job_id=? AND status='sent' AND sent_at IS NOT NULL
         ORDER BY sent_at DESC LIMIT 20`,
      ),
      // "Retry the ones that failed": failed rows go back to pending with a
      // clean slate, so continuing the campaign picks them up. Sent and skipped
      // rows are untouched — nobody is messaged twice.
      sendsRequeueFailed: db.prepare(
        `UPDATE job_sends SET status='pending', attempts=0, last_error=NULL
         WHERE job_id=? AND status='failed'`,
      ),
      // Editing a partly-sent campaign: drop one not-yet-sent row (a recipient
      // that was removed). Sent rows are never touched — they are the record
      // of who already got the message.
      sendDeletePending: db.prepare(
        `DELETE FROM job_sends WHERE job_id=? AND recipient=? AND status='pending'`,
      ),
      // COALESCE, not a plain set: a skip records WHY in last_error, while a
      // plain send passes null and keeps whatever a previous failed attempt
      // left there (the ledger's history of the row is worth more than tidiness)
      sendOk: db.prepare(
        `UPDATE job_sends SET status=?, sent_at=?, attempts=attempts+1, message_id=?,
           last_error=COALESCE(?, last_error)
         WHERE job_id=? AND recipient=? AND item_index=?`,
      ),
      sendFailedAttempt: db.prepare(
        `UPDATE job_sends SET status=?, attempts=attempts+1, last_error=?
         WHERE job_id=? AND recipient=? AND item_index=?`,
      ),
      reschedule: db.prepare(
        `UPDATE jobs SET scheduled_at=? WHERE id=? AND status='pending'`,
      ),
      // READ implies delivery — backfill delivered_at so the UI never shows
      // a read message that was somehow "not delivered"
      ackDelivered: db.prepare(
        `UPDATE job_sends SET delivered_at=COALESCE(delivered_at, ?) WHERE message_id=?`,
      ),
      ackRead: db.prepare(
        `UPDATE job_sends SET read_at=COALESCE(read_at, ?),
         delivered_at=COALESCE(delivered_at, ?) WHERE message_id=?`,
      ),
    };
  }

  upsert(input: UpsertInput): Job {
    const existing = input.id ? (this.q.byId.get(input.id) as JobRow | undefined) : undefined;
    const id = input.id || `job_${randomUUID()}`;
    const recipients = JSON.stringify(input.recipients);
    const items = JSON.stringify(input.items);
    this.db.transaction(() => {
      this.q.upsert.run({
        id,
        scheduled_at: new Date(input.scheduledAt).toISOString(),
        // an edit must not silently re-queue a done/cancelled/missed job —
        // re-running is an explicit act (status:'pending' or /restore)
        status: input.status || existing?.status || 'pending',
        // an edit that says nothing about the type keeps it: a "send now" job
        // is History's, and silently turning it into a 'compose' one would
        // move it out of the list its author is watching it in
        type: input.type || existing?.type || 'compose',
        recipients,
        items,
        // a plain edit keeps the note it already carries ("paused — 312/1043 sent")
        result: input.result ?? existing?.result ?? null,
        created_at: input.createdAt || existing?.created_at || new Date().toISOString(),
        sent_by: input.sentBy ?? null,
        instance: input.instance === undefined ? (existing?.instance ?? null) : input.instance,
        repeat:
          input.repeat === undefined
            ? (existing?.repeat ?? null)
            : input.repeat && JSON.stringify(input.repeat),
        batch:
          input.batch === undefined
            ? (existing?.batch ?? null)
            : input.batch && JSON.stringify(input.batch),
      });
      // Edited recipients/items invalidate a previous run's ledger — stale
      // rows would mis-skip recipients or point at the wrong item index.
      if (existing && (existing.recipients !== recipients || existing.items !== items)) {
        const sameItemCount = (JSON.parse(existing.items) as JobItem[]).length === input.items.length;
        if (existing.started_at && sameItemCount) {
          // A partly-sent campaign (paused, then edited): the ledger IS the
          // record of who already got the message, so it survives. Only the
          // unsent rows of dropped recipients go; recipients that were added
          // get their rows from ensureLedger when the run continues, and the
          // rewritten item text is picked up there too (rows key on the item
          // INDEX, which is why an item-count change can't come through here).
          const keep = new Set(input.recipients.map((r) => r.id));
          for (const row of this.q.sendsAll.all(id) as SendRow[]) {
            // a status/story row is a broadcast, not a recipient — never pruned
            if (row.status !== 'pending' || row.recipient === 'status@broadcast') continue;
            if (!keep.has(row.recipient)) this.q.sendDeletePending.run(id, row.recipient);
          }
        } else {
          this.q.sendsDeleteByJob.run(id);
        }
      }
    })();
    return this.byId(id)!;
  }

  all(filter: InstanceFilter = NO_FILTER): Job[] {
    return (this.q.all.all(filter) as JobRow[]).map(rowToJob);
  }

  /**
   * One page of a scope, plus per-status counts over the WHOLE scope (the UI
   * filter chips) — so a list of thousands never ships to the browser at once.
   * Both the page and the counts are confined to one instance (filter.eff).
   */
  page(
    scope: JobScope,
    opts: { status?: JobStatus; limit: number; offset: number; q?: string; dir?: 'asc' | 'desc' },
    filter: InstanceFilter = NO_FILTER,
  ): JobPage {
    const asc = opts.dir === 'asc';
    const pageQ = scope === 'history'
      ? (asc ? this.q.pageHistoryAsc : this.q.pageHistoryDesc)
      : (asc ? this.q.pageScheduledAsc : this.q.pageScheduledDesc);
    const countQ = scope === 'history' ? this.q.countHistory : this.q.countScheduled;
    const q = opts.q?.trim() || null;
    const counts: JobPage['counts'] = {};
    let totalAll = 0;
    for (const r of countQ.all({ ...filter, q }) as Array<{ status: JobStatus; n: number }>) {
      counts[r.status] = r.n;
      totalAll += r.n;
    }
    const rows = pageQ.all({
      eff: filter.eff,
      def: filter.def,
      status: opts.status ?? null,
      q,
      limit: opts.limit,
      offset: opts.offset,
    }) as JobRow[];
    return {
      jobs: rows.map(rowToJob),
      total: opts.status ? (counts[opts.status] ?? 0) : totalAll,
      counts,
    };
  }

  /** Job counts per calendar day (History scope) over the last `days` days —
   * feeds the History volume strip. Bucketed by `scheduled_at` shifted into
   * the viewer's local day (via `tzMinutes`, minutes to ADD to UTC), the
   * same field and the same local day the list itself sorts/groups by. */
  volumePerDay(
    days: number,
    tzMinutes: number,
    filter: InstanceFilter = NO_FILTER,
  ): Array<{ day: string; count: number }> {
    const tzMod = `${tzMinutes} minutes`;
    const localNow = Date.now() + tzMinutes * 60_000;
    const cutoff = new Date(localNow - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = this.q.volumePerDay.all({ eff: filter.eff, def: filter.def, tzMod, cutoff }) as Array<{
      day: string;
      n: number;
    }>;
    return rows.map((r) => ({ day: r.day, count: r.n }));
  }

  byId(id: string): Job | null {
    const r = this.q.byId.get(id) as JobRow | undefined;
    return r ? rowToJob(r) : null;
  }

  /** includeHeld: treat pending_approval as due (agent identification OFF). */
  due(now: Date = new Date(), includeHeld = false): Job[] {
    const q = includeHeld ? this.q.dueWithHeld : this.q.due;
    return (q.all(now.toISOString()) as JobRow[]).map(rowToJob);
  }

  setStatus(id: string, status: JobStatus): void {
    this.q.setStatus.run(status, id);
  }

  /**
   * Atomically claim a pending job for execution. Returns false if it was no
   * longer pending — or was rescheduled into the future since the due query.
   */
  claim(id: string, now: Date = new Date(), includeHeld = false): boolean {
    const iso = now.toISOString();
    const q = includeHeld ? this.q.markRunningWithHeld : this.q.markRunning;
    return q.run(iso, id, iso).changes > 0;
  }

  finish(id: string, status: JobStatus, result: string): void {
    this.q.finish.run({ id, status, result, now: new Date().toISOString() });
  }

  /** Release a held job. Returns false when it was no longer awaiting approval. */
  approve(id: string, now: Date = new Date()): boolean {
    return this.q.approve.run({ id, now: now.toISOString() }).changes > 0;
  }

  /**
   * Hold a campaign. A 'running' job stops after the send in flight (the
   * scheduler re-reads the status between sends); a 'pending' one never starts.
   * Returns false when the job was in neither state.
   */
  pause(id: string): boolean {
    return this.q.pause.run(id).changes > 0;
  }

  /**
   * Continue a paused campaign (or one cancelled after it had started) from
   * exactly where the ledger left off — due now. Returns false when there was
   * nothing to continue.
   */
  resume(id: string, now: Date = new Date()): boolean {
    return this.q.resume.run({ id, now: now.toISOString() }).changes > 0;
  }

  /**
   * Leave 'running' at a batch boundary WITHOUT finalizing: due again at `at`
   * when the pause is unattended, or 'paused' waiting for a human when it
   * isn't. Unsent ledger rows stay pending either way. `why` is the bare
   * reason the UI shows; `note` is the whole sentence, and the reason cannot be
   * recovered from it (it has an em dash of its own).
   */
  interrupt(id: string, at: Date | null, note: string, why: string): void {
    if (at) this.q.requeueAt.run({ id, at: at.toISOString() });
    else this.q.holdPaused.run(id);
    this.q.setResult.run(note, id);
    this.q.setHold.run(why, id);
  }

  /**
   * Put every failed row back in the queue. Returns how many — the caller then
   * re-queues the job itself so they actually go out.
   */
  requeueFailed(jobId: string): number {
    return this.q.sendsRequeueFailed.run(jobId).changes;
  }

  /** Progress note on a job that is paused or between batches (not finished). */
  setResult(id: string, result: string, holdReason?: string): void {
    this.q.setResult.run(result, id);
    if (holdReason !== undefined) this.q.setHold.run(holdReason, id);
  }

  delete(id: string): void {
    this.q.del.run(id);
  }

  /** Bulk-delete a specific set of jobs (the id-scoped counterpart to
   * clearDone's status-scoped bulk delete) — same irreversibility, so callers
   * must gate this behind the same permission as clear-done. */
  deleteMany(ids: string[]): number {
    return this.db.transaction((list: string[]) => {
      let n = 0;
      for (const id of list) n += this.q.del.run(id).changes;
      return n;
    })(ids);
  }

  clearDone(scope?: JobScope): number {
    const q =
      scope === 'history'
        ? this.q.clearHistory
        : scope === 'scheduled'
          ? this.q.clearScheduled
          : this.q.clearDone;
    return q.run().changes;
  }

  /**
   * Boot-time crash recovery: jobs left 'running' return to 'pending'. Their
   * ledger rows keep their statuses, so the re-run resumes instead of resending.
   */
  recoverInterrupted(): number {
    return this.q.recover.run().changes;
  }

  /** Create missing ledger rows for a job (idempotent — existing rows untouched). */
  ensureLedger(job: Job): void {
    this.db.transaction(() => {
      for (let i = 0; i < job.items.length; i++) {
        // a status/story item is a broadcast — Evolution ignores the recipient,
        // so one row per recipient would post the identical story N times
        if (job.items[i]?.type === 'status') {
          this.q.sendInsert.run(job.id, 'status@broadcast', 0, i);
          continue;
        }
        for (const r of job.recipients) {
          this.q.sendInsert.run(job.id, r.id, r.isGroup ? 1 : 0, i);
        }
      }
    })();
  }

  pendingSends(jobId: string): JobSend[] {
    return (this.q.sendsPending.all(jobId) as SendRow[]).map(sendRowToJobSend);
  }

  /**
   * One page of the ledger — who has been sent to and who hasn't, filtered and
   * counted server-side so a campaign of thousands stays browsable. `q` matches
   * the recipient digits.
   */
  sendsPage(
    jobId: string,
    opts: { status?: SendStatus; q?: string; limit: number; offset: number },
  ): { sends: JobSend[]; total: number } {
    const args = {
      jobId,
      status: opts.status ?? null,
      q: opts.q?.trim() ? opts.q.trim() : null,
      limit: opts.limit,
      offset: opts.offset,
    };
    const { n } = this.q.sendsPageCount.get(args) as { n: number };
    return {
      sends: (this.q.sendsPage.all(args) as SendRow[]).map(sendRowToJobSend),
      total: n,
    };
  }

  /**
   * Every ledger row matching a filter, unpaged — the export path. Same filter
   * as `sendsPage`, so "download what I am looking at" means exactly that.
   */
  sendsFiltered(jobId: string, opts: { status?: SendStatus; q?: string } = {}): JobSend[] {
    return this.sendsPage(jobId, { ...opts, limit: 1_000_000, offset: 0 }).sends;
  }

  /**
   * The recipients behind a ledger status chip — everyone with at least one
   * row in one of the given statuses. Deduplicated (a sequence has one row
   * per message) and never including the status/story broadcast row, which
   * is not a person.
   */
  recipientsByStatus(jobId: string, statuses: SendStatus[]): Array<{ recipient: string; isGroup: boolean }> {
    const seen = new Set<string>();
    const out: Array<{ recipient: string; isGroup: boolean }> = [];
    for (const s of this.allSends(jobId)) {
      if (!statuses.includes(s.status)) continue;
      if (s.recipient === 'status@broadcast' || seen.has(s.recipient)) continue;
      seen.add(s.recipient);
      out.push({ recipient: s.recipient, isGroup: s.isGroup });
    }
    return out;
  }

  /**
   * Who a re-send would have to reach: the recipients whose message never went
   * out. Never including a blacklist skip — that was a decision, not a failure.
   */
  unsentRecipients(jobId: string): Array<{ recipient: string; isGroup: boolean }> {
    return this.recipientsByStatus(jobId, ['pending', 'failed']);
  }

  /**
   * A campaign's live state, computed from the ledger (not from in-flight
   * counters) so it is exact after a refresh, a restart, or a pause that spans
   * days. `assumedDelayMs` seeds the rate before anything has been sent.
   */
  /**
   * Measured send pace, in messages per minute — from the gaps BETWEEN recent
   * sends, with anything longer than `pauseGapMs` thrown out. Measuring across
   * first→last instead would fold every batch pause and overnight wait into the
   * average, and the ETA (which adds the remaining pauses back on) would then
   * count them twice. null = not enough evidence yet.
   */
  private measuredRate(jobId: string, pauseGapMs: number): number | null {
    const stamps = (this.q.recentSends.all(jobId) as Array<{ sent_at: string }>).map((r) =>
      new Date(r.sent_at).getTime(),
    );
    const gaps: number[] = [];
    for (let i = 0; i + 1 < stamps.length; i++) {
      const gap = stamps[i]! - stamps[i + 1]!;
      if (gap > 0 && gap <= pauseGapMs) gaps.push(gap);
    }
    if (gaps.length < 3) return null;
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    return mean > 0 ? 60_000 / mean : null;
  }

  /**
   * @param assumedDelayMs Average configured send gap — the pace guess before
   * anything has been measured (Settings → Sending, read live).
   * @param minDelayMs Smallest configured gap. The send loop cannot go faster
   * than this, so it caps the measured rate: raise the gap mid-campaign and the
   * estimate corrects immediately instead of coasting on the old pace.
   */
  progress(jobId: string, assumedDelayMs = 0, minDelayMs = assumedDelayMs): CampaignProgress | null {
    const job = this.byId(jobId);
    if (!job) return null;
    const counts = { sent: 0, skipped: 0, failed: 0, pending: 0 } as Record<SendStatus, number>;
    let total = 0;
    for (const r of this.q.sendCounts.all(jobId) as Array<{ status: SendStatus; n: number }>) {
      counts[r.status] = r.n;
      total += r.n;
    }
    const span = this.q.sendSpan.get(jobId) as { first: string | null; last: string | null };
    const contacts = { sent: 0, skipped: 0, failed: 0, pending: 0 } as Record<SendStatus, number>;
    for (const r of this.q.sendContactsByStatus.all(jobId) as Array<{ status: SendStatus; n: number }>)
      contacts[r.status] = r.n;
    const notSentContacts = (this.q.notSentContacts.get(jobId) as { n: number }).n;
    // Pace: measured from recent gaps once there are enough of them, otherwise
    // the configured send delay (Settings → Sending, live). A gap longer than
    // this threshold is a pause, not pacing, and is excluded.
    const pauseGapMs = Math.max(60_000, assumedDelayMs * 6);
    const measured =
      this.measuredRate(jobId, pauseGapMs) ?? (assumedDelayMs > 0 ? 60_000 / assumedDelayMs : null);
    // no run can beat the configured minimum gap, so anything above that is not
    // a pace — it is history from before the setting changed
    const ceiling = minDelayMs > 0 ? 60_000 / minDelayMs : null;
    const ratePerMin =
      measured != null && ceiling != null ? Math.min(measured, ceiling) : measured;
    const batch = job.batch;
    const etaMinutes =
      counts.pending > 0 && ratePerMin
        ? estimatePendingMinutes(counts.pending, ratePerMin, batch)
        : null;
    return {
      jobId,
      status: job.status,
      total,
      sent: counts.sent,
      skipped: counts.skipped,
      failed: counts.failed,
      pending: counts.pending,
      contacts,
      notSentContacts,
      startedAt: job.startedAt,
      firstSentAt: span.first,
      lastSentAt: span.last,
      ratePerMin,
      etaMinutes,
      batch,
      // when an unattended batch pause is what's holding it, this is the moment
      // it picks back up; a 'paused' campaign waits for a human instead
      nextRunAt: job.status === 'pending' && job.startedAt ? job.scheduledAt : null,
      holdReason: (this.q.holdReason.get(jobId) as { why: string | null }).why,
    };
  }

  allSends(jobId: string): JobSend[] {
    return (this.q.sendsAll.all(jobId) as SendRow[]).map(sendRowToJobSend);
  }

  /** `note` explains a skip in the ledger's Error column; null leaves it as-is. */
  markSendDone(
    s: JobSend,
    status: 'sent' | 'skipped',
    messageId?: string,
    note?: string,
  ): void {
    this.q.sendOk.run(
      status,
      new Date().toISOString(),
      messageId ?? null,
      note ?? null,
      s.jobId,
      s.recipient,
      s.itemIndex,
    );
  }

  /** Move a pending job's fire time (quiet-hours deferral). */
  reschedule(id: string, scheduledAt: string): boolean {
    return this.q.reschedule.run(scheduledAt, id).changes > 0;
  }

  /** Record a delivery/read ack from Evolution against sent ledger rows. */
  markAck(messageId: string, kind: 'delivered' | 'read'): number {
    const now = new Date().toISOString();
    return kind === 'read'
      ? this.q.ackRead.run(now, now, messageId).changes
      : this.q.ackDelivered.run(now, messageId).changes;
  }

  /** Record a failed attempt; the row stays pending until attempts reach the cap. */
  markSendFailedAttempt(s: JobSend, error: string, maxAttempts: number): void {
    const status: SendStatus = s.attempts + 1 >= maxAttempts ? 'failed' : 'pending';
    this.q.sendFailedAttempt.run(status, error.slice(0, 500), s.jobId, s.recipient, s.itemIndex);
  }
}
