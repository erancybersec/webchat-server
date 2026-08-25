import type { BatchRule, Job, JobSend, RepeatFreq } from '../types.js';
import type { JobStore } from './jobs.js';
import { personalizeItem, usesWaName } from './personalize.js';
import { digitsOnly, toChatJid } from './phone.js';
import type { Sender } from './sender.js';
import { inQuietHours, nextClockTime, quietHoursEnd } from './time.js';

/** Seam for {{wa_name}} resolution (ContactNameResolver in production). */
export interface ContactNames {
  /** instance: the job's Evolution instance; absent = the default. */
  names(instance?: string): Promise<Map<string, string>>;
}

/** Seam for agent attribution of sent messages (AgentsStore in production). */
export interface MessageAttribution {
  recordMessage(messageId: string, email: string, chatJid?: string, instance?: string | null): void;
  /** {{agent_name}} source — the composing agent's display name. */
  displayName(email: string): string;
}

/** Seam for the bulk number check (VerificationService in production). */
export interface NumberVerifier {
  /** Fire-and-forget: campaigns never wait on verification. */
  sweepInBackground(recipients: readonly string[], instance?: string): boolean;
}

/** Seam for cold/known classification (ContactFamiliarityStore in production). */
export interface RecipientFamiliarity {
  classify(recipient: string, instance: string): 'group' | 'known' | 'cold';
}

/** Seam for the cold-contact ration (ColdSendQuota in production). */
export interface ColdQuota {
  /** Strangers this line may still reach; Infinity = capping is off. `override`
   *  is the job's own per-compose cold cap, when one was set for this run. */
  remaining(instance: string, override?: { dailyCap: number }): number;
  record(instance: string, recipient: string): void;
}

/** Seam for the line's live connection state (InstancesService in production). */
export interface InstanceHealth {
  /** true = connected, false = not, null = unknown (never blocks a send). */
  isOpen(instance: string): Promise<boolean | null>;
}

/**
 * Optional send-time guards. Bundled rather than appended one-by-one to an
 * already long constructor, and every one is absent-safe: a Scheduler built
 * without them behaves exactly as it did before they existed.
 */
export interface SendGuards {
  familiarity?: RecipientFamiliarity;
  quota?: ColdQuota;
  health?: InstanceHealth;
}

/** How often a long run re-checks that the line is still connected. */
const HEALTH_CHECK_EVERY_MS = 60_000;
/** Consecutive send failures that force an immediate health re-check. */
const FAILURES_BEFORE_HEALTH_CHECK = 3;

/** Seam for follow-up reminders (RemindersStore in production). */
export interface ReminderSource {
  fireDue(now?: Date): Array<{ id: number; chatJid: string; agentEmail: string; note: string }>;
}

export interface SchedulerConfig {
  pollMs: number;
  delayMinMs: number;
  delayMaxMs: number;
  maxOverdueMin: number;
  sendMaxAttempts: number;
  /** Live-updated via settings (held by reference to the app Config). Absent = off. */
  recurringEnabled?: boolean;
  quietEnabled?: boolean;
  quietStart?: string;
  quietEnd?: string;
  /** While OFF, the approval hold is inert: held jobs fire as if pending. */
  agentsEnabled?: boolean;
  /** Verify recipients against WhatsApp before a campaign sends. */
  verifyEnabled?: boolean;
}

/** Job progress pushed to browsers over the SSE relay. */
export interface JobProgress {
  jobId: string;
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  done: boolean;
  status?: string;
  /** Ledger rows still to go — set when a campaign stops short of finishing. */
  pending?: number;
  /** When an unattended batch pause ends; null/absent = waiting for a human. */
  nextRunAt?: string | null;
  /** Why it stopped short, in words the operator can act on. */
  holdReason?: string;
}

type Logger = (msg: string) => void;
type Emitter = (event: string, data: unknown) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export { inQuietHours, nextClockTime, quietHoursEnd } from './time.js';

function addFreq(d: Date, freq: RepeatFreq): Date {
  const n = new Date(d);
  if (freq === 'daily') n.setDate(n.getDate() + 1);
  else if (freq === 'weekly') n.setDate(n.getDate() + 7);
  else {
    // monthly: keep the day-of-month, clamping to the target month's length
    // (Jan 31 → Feb 28) instead of letting JS roll into the next month
    const day = n.getDate();
    n.setDate(1);
    n.setMonth(n.getMonth() + 1);
    const last = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
    n.setDate(Math.min(day, last));
  }
  return n;
}

/** First occurrence after `after`, stepping from the previous fire time. */
export function nextOccurrence(from: Date, freq: RepeatFreq, after: Date): Date {
  let d = addFreq(from, freq);
  while (d.getTime() <= after.getTime()) d = addFreq(d, freq);
  return d;
}

/**
 * Reorders pending sends so cold (never-contacted) recipients are woven evenly
 * among warm ones, instead of wherever the ledger's `ORDER BY recipient` sort
 * happened to cluster them. A recipient's items stay adjacent and in order —
 * only the order of RECIPIENTS changes.
 *
 * The weave is ratio-based (a Bresenham-style accumulator), so cold contacts
 * spread across the whole run in proportion to how many there are, rather than
 * bunching at the front or back. A same-bucket streak is still possible once
 * one bucket runs out — draining the rest of the longer list is unavoidable,
 * and it is never cold that outlasts warm, since cold is the rationed one.
 */
export function interleaveByFamiliarity(
  pending: JobSend[],
  classify: (recipient: string, instance: string) => 'group' | 'known' | 'cold',
  instance: string,
): JobSend[] {
  const byRecipient = new Map<string, JobSend[]>();
  const recipientOrder: string[] = [];
  for (const s of pending) {
    let group = byRecipient.get(s.recipient);
    if (!group) {
      group = [];
      byRecipient.set(s.recipient, group);
      recipientOrder.push(s.recipient);
    }
    group.push(s);
  }
  if (recipientOrder.length <= 1) return pending;

  const cold: string[] = [];
  const warm: string[] = []; // known + group — neither is rationed
  for (const recipient of recipientOrder)
    (classify(recipient, instance) === 'cold' ? cold : warm).push(recipient);

  const woven: string[] = [];
  let ci = 0;
  let wi = 0;
  let acc = 0;
  let lastWasCold = false;
  while (ci < cold.length || wi < warm.length) {
    acc += cold.length;
    const coldDue = acc >= warm.length && ci < cold.length;
    if (coldDue && !lastWasCold) {
      woven.push(cold[ci++]!);
      acc -= warm.length;
      lastWasCold = true;
    } else if (wi < warm.length) {
      woven.push(warm[wi++]!);
      lastWasCold = false;
    } else {
      woven.push(cold[ci++]!); // warm exhausted — cold drains on its own
      acc -= warm.length;
      lastWasCold = true;
    }
  }

  return woven.flatMap((recipient) => byRecipient.get(recipient)!);
}

/**
 * Fires due jobs server-side. Each job is driven by its send ledger: every
 * recipient x item is one row, marked sent/skipped/failed individually, so a
 * crash mid-job resumes where it left off instead of resending.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopping = false;
  private current: Promise<void> | null = null;

  constructor(
    private readonly jobs: JobStore,
    private readonly sender: Sender,
    private readonly cfg: SchedulerConfig,
    private readonly log: Logger = (m) => console.log(new Date().toISOString(), m),
    /** Pushes JOB_PROGRESS events to browsers (wired to the SSE relay). */
    private readonly emit: Emitter = () => {},
    /** {{wa_name}} source; absent or failing = fallbacks apply. */
    private readonly contacts?: ContactNames,
    /** Maps sent message ids to the job's agent (chat-bubble attribution). */
    private readonly attribution?: MessageAttribution,
    /** Follow-up reminders fired on the same poll. */
    private readonly reminders?: ReminderSource,
    /** Daily retention sweep (maintenance) — invoked at most once per day. */
    private readonly retentionSweep?: () => void,
    /** Background number check; absent = send unverified (the old behavior). */
    private readonly verifier?: NumberVerifier,
    /** Cold-contact cap and connection guard; all parts optional. */
    private readonly guards: SendGuards = {},
  ) {}

  private lastSweepDay = '';

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), this.cfg.pollMs);
    void this.tick(); // catch up immediately on boot
  }

  /**
   * Stops polling and waits for an in-flight tick. A job interrupted mid-run
   * is left 'running' on purpose: boot recovery flips it back to pending and
   * the ledger resumes it — finalizing here would mark unsent rows failed.
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopping = true;
    await this.current;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.current = this.run();
    try {
      await this.current;
    } finally {
      this.ticking = false;
      this.current = null;
    }
  }

  private async run(): Promise<void> {
    // overdue is measured against tick start: a job queued behind a slow job
    // in the same tick must not accrue "overdue" minutes while we work
    const tickStart = Date.now();
    try {
      this.fireReminders();
      this.sweepRetention();
      // the approval hold only exists while agent identification is on —
      // held jobs fire (without a status rewrite) while the toggle is off,
      // so nothing gets stuck, and re-enabling re-holds whatever hasn't fired
      const includeHeld = !this.cfg.agentsEnabled;
      for (const due of this.jobs.due(new Date(tickStart), includeHeld)) {
        if (this.stopping) return;
        // quiet hours: scheduled work waits for the window to end. Immediate
        // jobs bypass — the operator is at the keyboard pressing "send now" —
        // but only on their FIRST run: a batched blast that is still going
        // hours later is no longer "someone at the keyboard".
        if (
          this.cfg.quietEnabled &&
          (due.type !== 'immediate' || !!due.startedAt) &&
          inQuietHours(new Date(tickStart), this.cfg.quietStart ?? '', this.cfg.quietEnd ?? '')
        ) {
          const resume = quietHoursEnd(new Date(tickStart), this.cfg.quietEnd ?? '');
          if (this.jobs.reschedule(due.id, resume.toISOString()))
            this.log(`[job ${due.id}] quiet hours — deferred to ${resume.toISOString()}`);
          continue;
        }
        // started jobs are crash-recovered, possibly half-sent — marking them
        // missed would abandon the ledger resume the crash recovery exists for
        if (this.cfg.maxOverdueMin > 0 && !due.startedAt) {
          const overdueMin = (tickStart - new Date(due.scheduledAt).getTime()) / 60000;
          if (overdueMin > this.cfg.maxOverdueMin) {
            this.jobs.finish(due.id, 'missed', `skipped — overdue by ${Math.round(overdueMin)} min`);
            this.log(`[job ${due.id}] missed (overdue ${Math.round(overdueMin)}m)`);
            // one outage must not silently kill a recurring series
            this.rollForward(due);
            continue;
          }
        }
        // claim() is atomic — honors a cancel that landed since the due query
        if (!this.jobs.claim(due.id, new Date(), includeHeld)) continue;
        // re-fetch after claiming: an edit landing while earlier jobs in this
        // tick were sending would otherwise run with stale recipients/items
        const fresh = this.jobs.byId(due.id);
        if (!fresh) continue;
        try {
          await this.runJob(fresh);
        } catch (e) {
          // an unexpected throw must not leave the job stuck 'running' until
          // the next restart — the ledger makes a manual re-run safe
          this.jobs.finish(due.id, 'failed', `crashed: ${String((e as Error).message ?? e)}`);
          this.log(`[job ${due.id}] crashed: ${String(e)}`);
          this.rollForward(fresh);
        }
      }
    } catch (e) {
      this.log(`[tick] error: ${String(e)}`);
    }
  }

  async runJob(job: Job): Promise<void> {
    this.jobs.ensureLedger(job);
    let cancelled = false;
    // Campaign pacing. A batch is counted in WIRE ATTEMPTS: a blacklist skip
    // never sent anything, so it doesn't spend the batch.
    const batch = job.batch;
    let wireSends = 0;
    // 'pause at HH:MM' — fixed for this run, so a run always has room to work
    // and a manual Continue past the cutoff isn't instantly re-stopped.
    const cutoff = batch?.pauseAt ? nextClockTime(new Date(), batch.pauseAt) : null;
    // set when the campaign steps out of this run without finishing:
    // { at } = re-queue then, { at: null } = hold 'paused' for a human
    let interrupted: { at: Date | null; why: string } | null = null;
    let pausedByOperator = false;

    // {{name}} personalization source — recipient display names from Compose
    const names = new Map(job.recipients.map((r) => [r.id, r.name ?? '']));
    // {{agent_name}} — the composing agent's display name (one job, one agent)
    const agentName = job.sentBy ? (this.attribution?.displayName(job.sentBy) ?? '') : '';
    // {{wa_name}} source — contact book, fetched once per run and only when
    // an item actually uses the tag; a failed fetch degrades to fallbacks
    let waNames = new Map<string, string>();
    if (usesWaName(job.items)) {
      try {
        waNames = (await this.contacts?.names(job.instance ?? undefined)) ?? new Map();
      } catch (e) {
        this.log(`[job ${job.id}] contact-name fetch failed (${String((e as Error).message ?? e)}) — {{wa_name}} fallbacks apply`);
      }
    }

    // Live progress, kept as counters (re-querying the ledger per send would
    // be O(n²) on big broadcasts). Seeded from the ledger so resumes report
    // already-sent rows.
    const initial = this.jobs.allSends(job.id);
    const progress: JobProgress = {
      jobId: job.id,
      total: initial.length,
      sent: initial.filter((s) => s.status === 'sent').length,
      skipped: initial.filter((s) => s.status === 'skipped').length,
      failed: 0, // 'failed' rows are retried below — counted when they exhaust
      done: false,
    };
    this.emit('JOB_PROGRESS', { ...progress });

    // Kick the number check off in the BACKGROUND and start sending straight
    // away. It exists to stop the send loop spending its gap — three times
    // over, at sendMaxAttempts — on a number that cannot receive; it was never
    // meant to gate the campaign, and waiting on it forced the sweep to run
    // fast enough to look like contact scraping. Whatever it learns while the
    // campaign is in flight applies to every recipient it hasn't reached yet,
    // and anything still unknown simply sends, as it always did.
    if (this.verifier && this.cfg.verifyEnabled !== false) {
      const targets = [
        ...new Set(initial.filter((s) => s.status === 'pending').map((s) => s.recipient)),
      ];
      if (targets.length) this.verifier.sweepInBackground(targets, job.instance ?? undefined);
    }

    // Cold-contact ration. The budget is read once per run and spent per
    // RECIPIENT, not per message: two items to one stranger is still one first
    // contact. Groups and people with an existing thread never touch it.
    const inst = job.instance ?? '';
    let coldBudget = this.guards.quota?.remaining(inst, batch?.coldCap) ?? Number.POSITIVE_INFINITY;
    const coldAdmitted = new Set<string>();
    const coldRecorded = new Set<string>();
    let deferredCold = 0;
    // 0, not now(): the line is checked BEFORE the first message, so a campaign
    // launched at a dead number stops at zero sends rather than one minute in
    let lastHealthAt = 0;
    let consecutiveFailures = 0;

    // Multiple passes: a failed send stays pending (attempts++) until it hits
    // the attempt cap, so transient Evolution errors get retried within the run.
    for (
      let pass = 0;
      pass < this.cfg.sendMaxAttempts && !cancelled && !pausedByOperator && !interrupted;
      pass++
    ) {
      let pending = this.jobs.pendingSends(job.id);
      if (!pending.length) break;
      if (this.guards.familiarity)
        pending = interleaveByFamiliarity(
          pending,
          (rec, i) => this.guards.familiarity!.classify(rec, i),
          inst,
        );
      for (let i = 0; i < pending.length; i++) {
        // shutdown mid-run: leave the job 'running' (not finalized) so boot
        // recovery re-pends it and the ledger resumes exactly where we stopped
        if (this.stopping) {
          this.log(`[job ${job.id}] interrupted by shutdown — resumes on next boot`);
          return;
        }
        // a cancel or a pause can land mid-run (campaigns run for hours) —
        // both stop after the send in flight, with unsent rows left pending
        const live = this.jobs.byId(job.id)?.status;
        if (live === 'cancelled') {
          cancelled = true;
          break;
        }
        if (live === 'paused') {
          pausedByOperator = true;
          break;
        }
        // 'pause at HH:MM' reached — stop, and pick up at resumeAt when set
        if (cutoff && Date.now() >= cutoff.getTime()) {
          interrupted = {
            at: batch?.resumeAt ? nextClockTime(new Date(), batch.resumeAt) : null,
            why: `reached ${batch?.pauseAt}`,
          };
          break;
        }
        const s = pending[i]!;
        // The line dropped out from under us. A campaign that keeps firing into
        // a severed session burns sendMaxAttempts per recipient against an
        // outcome that cannot change, and the ledger fills with failures that
        // were never the recipients' fault — so stop and say why. Checked on a
        // timer, and immediately after a run of failures.
        if (
          this.guards.health &&
          Date.now() - lastHealthAt >= (consecutiveFailures >= FAILURES_BEFORE_HEALTH_CHECK ? 0 : HEALTH_CHECK_EVERY_MS)
        ) {
          lastHealthAt = Date.now();
          let open: boolean | null = null;
          try {
            open = await this.guards.health.isOpen(inst);
          } catch {
            open = null; // a failed health check is not evidence of a problem
          }
          if (open === false) {
            interrupted = { at: null, why: 'the WhatsApp line is disconnected' };
            break;
          }
          consecutiveFailures = 0;
        }
        // Cold-contact ration, decided once per recipient so a multi-item
        // sequence is never split across the cap boundary — half a conversation
        // today and half tomorrow is worse than waiting a day for both.
        const kind = this.guards.familiarity?.classify(s.recipient, inst) ?? 'known';
        if (kind === 'cold' && !coldAdmitted.has(s.recipient)) {
          if (coldBudget <= 0) {
            deferredCold++;
            continue; // left pending; the next run picks it up
          }
          coldAdmitted.add(s.recipient);
          coldBudget--;
        }
        const item = job.items[s.itemIndex];
        let paced = true; // delay only after an actual network send
        let outcome = null as Awaited<ReturnType<Sender['sendOne']>> | null;
        try {
          if (!item) throw new Error(`item ${s.itemIndex} missing`);
          outcome = await this.sender.sendOne(
            s.recipient,
            personalizeItem(item, {
              name: names.get(s.recipient) ?? '',
              waName: waNames.get(digitsOnly(s.recipient.split('@')[0])) ?? '',
              agentName,
            }),
            {
              instance: job.instance ?? undefined,
              // campaigns respect the verification verdict; 1:1 chat does not
              enforceVerification: this.cfg.verifyEnabled !== false,
            },
          );
        } catch (e) {
          this.jobs.markSendFailedAttempt(s, String((e as Error).message ?? e), this.cfg.sendMaxAttempts);
          if (s.attempts + 1 >= this.cfg.sendMaxAttempts) progress.failed++;
          consecutiveFailures++;
        }
        // ledger write OUTSIDE the catch: the message is already on the wire,
        // so a failing write must abort the run — recording it as a retryable
        // failed attempt would resend the message on the next pass
        if (outcome) {
          if (outcome.status === 'skipped') {
            this.jobs.markSendDone(
              s,
              'skipped',
              undefined,
              outcome.reason === 'not_on_whatsapp'
                ? 'not on WhatsApp — skipped, not retried'
                : 'on the blacklist',
            );
            progress.skipped++;
            paced = false;
          } else {
            consecutiveFailures = 0;
            // Charge the ration only once the stranger was actually reached —
            // a failed attempt costs the budget nothing.
            if (kind === 'cold' && !coldRecorded.has(s.recipient)) {
              coldRecorded.add(s.recipient);
              this.guards.quota?.record(inst, s.recipient);
            }
            this.jobs.markSendDone(s, 'sent', outcome.messageId);
            // sentBy is only ever stamped while the Settings toggle is on
            if (outcome.messageId && job.sentBy)
              this.attribution?.recordMessage(
                outcome.messageId,
                job.sentBy,
                toChatJid(s.recipient),
                job.instance,
              );
            progress.sent++;
          }
        }
        this.emit('JOB_PROGRESS', { ...progress });
        // a batch is full — leave the rest for the next run. A multi-item
        // sequence is kept whole: stopping between a recipient's first and
        // second message would leave them with half a conversation until the
        // pause ends (possibly overnight), so the boundary waits for the next
        // recipient. Ledger rows are ordered by recipient, so "same recipient"
        // is just the next row.
        if (paced) wireSends++;
        const midSequence = job.items.length > 1 && pending[i + 1]?.recipient === s.recipient;
        if (batch?.size && wireSends >= batch.size && !midSequence) {
          interrupted = {
            at: batch.pauseMin > 0 ? new Date(Date.now() + this.randomBatchPauseMs(batch)) : null,
            why: `batch of ${batch.size} sent`,
          };
          break;
        }
        const last = i === pending.length - 1;
        if (!last && paced) await sleep(this.randomDelayMs());
      }
      // Everyone reachable today has been reached; the rest are strangers over
      // the ration. Hand them to tomorrow rather than the attempt-cap, which
      // would mark them failed for a reason that has nothing to do with them.
      if (!interrupted && !cancelled && !pausedByOperator && deferredCold > 0) {
        interrupted = {
          at: nextClockTime(new Date(), batch?.resumeAt || '09:00'),
          why: `daily cold-contact cap reached — ${deferredCold} first-time recipient${deferredCold === 1 ? '' : 's'} held back`,
        };
      }
    }

    // Stepped out without finishing: hand the campaign over to the next run
    // (or to a human) with its ledger intact. If nothing is actually left the
    // job finalizes normally below — a batch boundary on the last recipient is
    // a finished campaign, not a paused one.
    if (interrupted || pausedByOperator) {
      const remaining = this.jobs.pendingSends(job.id).length;
      if (remaining > 0) {
        const done = progress.sent + progress.skipped + progress.failed;
        const at = pausedByOperator ? null : interrupted!.at;
        const why = pausedByOperator ? 'paused' : interrupted!.why;
        const note = at
          ? `${why} — ${done} of ${progress.total} done, continues ${at.toLocaleString()}`
          : `${why} — ${done} of ${progress.total} done, ${remaining} waiting for Continue`;
        // A hand pause needs no explanation — the status already is the
        // reason, and "Paused — paused" is worse than saying nothing.
        const holdReason = pausedByOperator ? '' : why;
        // an operator pause already moved the status; only the note is ours
        if (pausedByOperator) this.jobs.setResult(job.id, note, holdReason);
        else this.jobs.interrupt(job.id, at, note, holdReason);
        this.log(`[job ${job.id}] ${note}`);
        this.emit('JOB_PROGRESS', {
          ...progress,
          pending: remaining,
          done: false,
          status: at ? 'pending' : 'paused',
          nextRunAt: at ? at.toISOString() : null,
          holdReason,
        } satisfies JobProgress);
        return;
      }
    }

    // Anything still pending exhausted its in-run passes — finalize as failed.
    // Under a cancel, pending rows stay pending so a re-queued job can resume.
    const sends = this.jobs.allSends(job.id);
    let sent = 0,
      skipped = 0,
      failed = 0,
      unsent = 0;
    for (const s of sends) {
      if (s.status === 'sent') sent++;
      else if (s.status === 'skipped') skipped++;
      else if (s.status === 'failed') failed++;
      else if (cancelled) unsent++;
      else {
        failed++;
        this.jobs.markSendFailedAttempt(s, s.lastError ?? 'not sent', 1);
      }
    }
    const errors = [
      ...new Set(sends.filter((s) => s.lastError).map((s) => s.lastError as string)),
    ].slice(0, 5);

    const total = sends.length;
    let result = `${sent}/${total} sent`;
    if (skipped) result += `, ${skipped} skipped (blacklisted)`;
    if (failed) result += `, ${failed} failed`;
    if (unsent) result += `, ${unsent} not sent (cancelled)`;
    if (errors.length) result += ` — ${errors.join(' | ')}`;
    const status = cancelled ? 'cancelled' : total > 0 && failed === total ? 'failed' : 'done';
    this.jobs.finish(job.id, status, result);
    this.log(`[job ${job.id}] ${status}: ${result}`);
    this.emit('JOB_PROGRESS', {
      ...progress,
      sent,
      skipped,
      failed,
      done: true,
      status,
    } satisfies JobProgress);
    this.rollForward(job);
  }

  /**
   * Recurring jobs: when an occurrence reaches a terminal state, queue the
   * next one. Gated on the Settings toggle (off by default) so a stray rule
   * can never loop sends; a user cancel ends the series.
   */
  private rollForward(job: Job): void {
    const rule = job.repeat;
    if (!rule) return;
    if (this.jobs.byId(job.id)?.status === 'cancelled') return;
    if (!this.cfg.recurringEnabled) {
      this.log(`[job ${job.id}] repeat rule ignored — recurring jobs are disabled in Settings`);
      return;
    }
    const next = nextOccurrence(new Date(job.scheduledAt), rule.freq, new Date());
    if (rule.until && next.getTime() >= new Date(rule.until).getTime()) {
      this.log(`[job ${job.id}] recurring series ended (until ${rule.until})`);
      return;
    }
    const clone = this.jobs.upsert({
      scheduledAt: next.toISOString(),
      type: job.type ?? 'compose',
      recipients: job.recipients,
      items: job.items,
      repeat: rule,
      sentBy: job.sentBy ?? undefined,
      instance: job.instance,
      // the pacing is part of the campaign, not of one occurrence — without
      // this a weekly blast would go out unpaced from its second week on
      batch: job.batch,
    });
    this.log(`[job ${job.id}] recurring → next occurrence ${clone.id} at ${clone.scheduledAt}`);
  }

  /** Retention rides the poll too: once per (UTC) day, never with VACUUM. */
  private sweepRetention(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastSweepDay === today) return;
    this.lastSweepDay = today;
    try {
      this.retentionSweep?.();
    } catch (e) {
      this.log(`[retention] sweep error: ${String(e)}`);
    }
  }

  /** Follow-up reminders ride the same poll — due ones fire over SSE. */
  private fireReminders(): void {
    try {
      for (const r of this.reminders?.fireDue() ?? []) {
        this.emit('REMINDER_DUE', {
          id: r.id,
          chatJid: r.chatJid,
          agentEmail: r.agentEmail,
          note: r.note,
        });
        this.log(`[reminder ${r.id}] fired for ${r.agentEmail || 'everyone'} on ${r.chatJid}`);
      }
    } catch (e) {
      this.log(`[reminders] error: ${String(e)}`);
    }
  }

  private randomDelayMs(): number {
    const { delayMinMs, delayMaxMs } = this.cfg;
    return Math.max(0, Math.random() * (delayMaxMs - delayMinMs) + delayMinMs);
  }

  /** A batch boundary's wait, in ms — ranged when `pauseMinMax` calls for it,
   *  freshly rolled at every boundary, exactly like `randomDelayMs()`. */
  private randomBatchPauseMs(batch: BatchRule): number {
    if (batch.pauseMinMax && batch.pauseMinMax > batch.pauseMin)
      return (batch.pauseMin + Math.random() * (batch.pauseMinMax - batch.pauseMin)) * 60_000;
    return batch.pauseMin * 60_000;
  }
}
