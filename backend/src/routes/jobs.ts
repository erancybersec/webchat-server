import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { emailFromRequest, type AgentsStore } from '../services/agents.js';
import { can, requirePerm } from '../services/authz.js';
import { toCsv } from '../services/csv.js';
import type { InstanceAccess } from '../services/instances.js';
import type { JobStore } from '../services/jobs.js';
import type { ListsStore } from '../services/lists.js';
import { buildEvoRequest } from '../services/messages.js';
import type {
  BatchRule,
  JobItem,
  JobScope,
  JobStatus,
  Recipient,
  RepeatFreq,
  RepeatRule,
  SendStatus,
} from '../types.js';

const REPEAT_FREQS: readonly RepeatFreq[] = ['daily', 'weekly', 'monthly'];

// 'running' is excluded — only the scheduler's atomic claim may set it.
// 'pending_approval' too: the approval rule decides it, never the client —
// otherwise a submitter could self-approve by saving with status 'pending'.
const SETTABLE_STATUSES: readonly JobStatus[] = ['pending', 'done', 'failed', 'cancelled', 'missed'];
// 'paused' is not settable either — /pause and /resume own that transition.
const ALL_STATUSES: readonly JobStatus[] = [
  ...SETTABLE_STATUSES,
  'running',
  'pending_approval',
  'paused',
];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Hard ceilings on the pacing knobs — a typo shouldn't strand a campaign. */
const MAX_BATCH_PAUSE_MIN = 7 * 24 * 60;
const SCOPES: readonly JobScope[] = ['scheduled', 'history'];
const SEND_STATUSES: readonly SendStatus[] = ['pending', 'sent', 'skipped', 'failed'];

const isDue = (j: { status: JobStatus; scheduledAt: string }): boolean =>
  j.status === 'pending' && new Date(j.scheduledAt).getTime() <= Date.now();

function parseRecipients(value: unknown): Recipient[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const out: Recipient[] = [];
  for (const r of value) {
    if (!r || typeof r !== 'object' || typeof (r as Recipient).id !== 'string' || !(r as Recipient).id)
      return null;
    const rec: Recipient = { id: (r as Recipient).id, isGroup: !!(r as Recipient).isGroup };
    if (typeof (r as Recipient).name === 'string' && (r as Recipient).name)
      rec.name = (r as Recipient).name;
    out.push(rec);
  }
  return out;
}

/** undefined = field absent; null = clear; rule = validated; 'invalid' = reject. */
function parseRepeat(value: unknown): RepeatRule | null | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object') return 'invalid';
  const { freq, until } = value as { freq?: unknown; until?: unknown };
  if (!REPEAT_FREQS.includes(freq as RepeatFreq)) return 'invalid';
  if (until !== undefined) {
    if (typeof until !== 'string' || Number.isNaN(new Date(until).getTime())) return 'invalid';
    return { freq: freq as RepeatFreq, until };
  }
  return { freq: freq as RepeatFreq };
}

/** undefined = field absent; null = clear; rule = validated; 'invalid' = reject. */
function parseBatch(value: unknown): BatchRule | null | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object') return 'invalid';
  const { size, pauseMin, pauseAt, resumeAt, pauseMinMax, coldCap, delay } = value as Record<
    string,
    unknown
  >;
  // A batch size is optional: a rule may be nothing but a sending window
  // ("run until 21:00, continue at 09:00"), which is the control most campaigns
  // actually want — batching is the extra, not the point.
  if (size !== undefined && size !== null && (!Number.isInteger(size) || (size as number) < 1))
    return 'invalid';
  const pause = pauseMin === undefined ? 0 : pauseMin;
  if (!Number.isInteger(pause) || (pause as number) < 0 || (pause as number) > MAX_BATCH_PAUSE_MIN)
    return 'invalid';
  const out: BatchRule = { pauseMin: pause as number };
  if (size !== undefined && size !== null) out.size = size as number;
  for (const [key, v] of [
    ['pauseAt', pauseAt],
    ['resumeAt', resumeAt],
  ] as const) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !HHMM.test(v)) return 'invalid';
    out[key] = v;
  }
  // a continue-time without a stop-time has nothing to continue from
  if (out.resumeAt && !out.pauseAt) return 'invalid';
  // randomized batch wait: a range on top of pauseMin, only meaningful when
  // there is a batch wait to randomize in the first place
  if (pauseMinMax !== undefined && pauseMinMax !== null) {
    if (
      !Number.isInteger(pauseMinMax) ||
      (pauseMinMax as number) < 0 ||
      (pauseMinMax as number) > MAX_BATCH_PAUSE_MIN
    )
      return 'invalid';
    if ((pause as number) === 0) return 'invalid'; // a manual wait can't be randomized
    if ((pauseMinMax as number) <= (pause as number)) return 'invalid'; // must be a real range
    out.pauseMinMax = pauseMinMax as number;
  }
  // per-compose cold-contact cap override: a flat daily ceiling for this run only
  if (coldCap !== undefined && coldCap !== null) {
    if (typeof coldCap !== 'object') return 'invalid';
    const { dailyCap } = coldCap as Record<string, unknown>;
    if (!Number.isInteger(dailyCap) || (dailyCap as number) < 1) return 'invalid';
    out.coldCap = { dailyCap: dailyCap as number };
  }
  // per-compose delay override: this run's own gap between messages, in seconds
  if (delay !== undefined && delay !== null) {
    if (typeof delay !== 'object') return 'invalid';
    const { minSec, maxSec } = delay as Record<string, unknown>;
    if (typeof minSec !== 'number' || !Number.isFinite(minSec) || minSec < 0) return 'invalid';
    if (typeof maxSec !== 'number' || !Number.isFinite(maxSec) || maxSec < minSec) return 'invalid';
    out.delay = { minSec, maxSec };
  }
  // ...and a rule that paces nothing — no batching, no hour, no cap or delay override — is not one
  if (!out.size && !out.pauseAt && !out.coldCap && !out.delay) return 'invalid';
  return out;
}

/**
 * @param wake Pokes the scheduler so a job saved with a due time (immediate
 * "send now", rerun) fires right away instead of waiting out the poll interval.
 */
export function registerJobs(
  app: FastifyInstance,
  jobs: JobStore,
  wake?: () => void,
  /** Live flag (Settings toggle) — repeat rules are rejected while disabled. */
  recurringEnabled: () => boolean = () => false,
  cfg?: Config,
  /** Enables the approval flow (rule + approve/reject routes) when provided. */
  agents?: AgentsStore,
  /** JOB_APPROVAL events to browsers (wired to the SSE relay). */
  emit: (event: string, data: unknown) => void = () => {},
  /** Per-agent Evolution instance grants (absent in older tests = allow). */
  access?: InstanceAccess,
  /** Saved lists — enables "keep the ones that were not sent" (absent = off). */
  lists?: ListsStore,
): void {
  // A job acts on its instance when it FIRES — so the grant is checked on
  // every path that queues one (create/edit, restore, rerun), like approval.
  const instanceAllowed = (req: FastifyRequest, instance: string | null): boolean =>
    !access || access.isAllowed(req, instance || (cfg?.evo.instance ?? ''));
  // Agent identification (Settings toggle): who is creating this job.
  const sentBy = (req: FastifyRequest): string | undefined =>
    cfg?.agentsEnabled ? (emailFromRequest(req) ?? undefined) : undefined;

  /**
   * The approval rule, evaluated against the REQUESTER on every path that can
   * queue a job (create/edit, restore, rerun) so none of them bypasses it.
   * "Bulk" = more recipients than the configurable threshold. No Access
   * identity (LAN, automation) = exempt — Cloudflare Access is the perimeter
   * and approval is a workflow guardrail, not a security boundary.
   */
  const needsApproval = (req: FastifyRequest, recipients: Recipient[]): boolean => {
    if (!cfg?.agentsEnabled || !agents) return false;
    const email = emailFromRequest(req);
    if (!email) return false;
    const agent = agents.byEmail(email);
    if (!agent) return false;
    if (can(agent, 'jobs.sendWithoutApproval')) return false;
    return recipients.length > Math.max(1, cfg.approvalThreshold || 1);
  };

  const queueStatus = (req: FastifyRequest, recipients: Recipient[]): JobStatus =>
    needsApproval(req, recipients) ? 'pending_approval' : 'pending';
  // Bare GET keeps the legacy full-array shape (ChatPage ghost bubbles need
  // cross-job filtering); ?scope= returns one page so big lists never ship whole.
  // Confine the list to the active line: a blank-instance (legacy) job belongs
  // to the server default, so eff = the requested instance, or that default.
  const instanceFilter = (q: Record<string, string | undefined>) => {
    const def = cfg?.evo.instance ?? '';
    return { eff: (q.instance ?? '').trim() || def, def };
  };
  app.get('/api/jobs', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.scope) return jobs.all(instanceFilter(q));
    if (!SCOPES.includes(q.scope as JobScope))
      return reply.code(400).send({ error: `scope must be one of: ${SCOPES.join(', ')}` });
    if (q.status && !ALL_STATUSES.includes(q.status as JobStatus))
      return reply.code(400).send({ error: `status must be one of: ${ALL_STATUSES.join(', ')}` });
    return jobs.page(
      q.scope as JobScope,
      {
        status: q.status as JobStatus | undefined,
        limit: Math.min(Math.max(1, Number(q.limit) || 50), 200),
        offset: Math.max(0, Number(q.offset) || 0),
        q: q.q,
        dir: q.sort === 'asc' ? 'asc' : 'desc',
      },
      instanceFilter(q),
    );
  });

  // Job counts per day (History only) for the volume-strip navigation aid.
  // ?tz = minutes to add to UTC to reach the viewer's local time (i.e.
  // -Date().getTimezoneOffset()), so "day" matches the same local day the
  // list itself groups by.
  app.get('/api/jobs/volume', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.scope && q.scope !== 'history')
      return reply.code(400).send({ error: 'scope must be history' });
    const days = Math.min(Math.max(1, Number(q.days) || 30), 90);
    const tz = Math.min(Math.max(-720, Number(q.tz) || 0), 840);
    return jobs.volumePerDay(days, tz, instanceFilter(q));
  });

  app.get('/api/jobs/:id', async (req, reply) => {
    const j = jobs.byId((req.params as { id: string }).id);
    return j ?? reply.code(404).send({ error: 'not found' });
  });

  // Create or update (upsert by id; omit id to create).
  app.post('/api/jobs', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!b.scheduledAt || Number.isNaN(new Date(String(b.scheduledAt)).getTime()))
      return reply.code(400).send({ error: 'valid scheduledAt required' });
    if (!Array.isArray(b.items) || !b.items.length)
      return reply.code(400).send({ error: 'items required' });
    const recipients = parseRecipients(b.recipients);
    if (!recipients)
      return reply.code(400).send({ error: 'recipients required: non-empty [{ id, isGroup? }]' });
    if (b.status != null && !SETTABLE_STATUSES.includes(b.status as JobStatus))
      return reply.code(400).send({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
    // Validate items with the same builder the send path uses, so a bad item
    // fails at save time instead of when the job fires.
    for (const item of b.items as JobItem[]) {
      try {
        buildEvoRequest(item ?? { type: '', data: {} }, '0', 'validate');
      } catch (e) {
        return reply.code(400).send({ error: `invalid item: ${(e as Error).message}` });
      }
    }
    const existing = typeof b.id === 'string' ? jobs.byId(b.id) : null;
    if (existing?.status === 'running')
      return reply.code(409).send({ error: 'job is running — pause it before editing' });
    // A partly-sent campaign CAN be edited (that is the point of pausing one),
    // but its ledger rows key on the item INDEX, so the sequence must keep its
    // shape — otherwise the remaining recipients would get the wrong message
    // and the sent rows would describe something that never went out.
    if (existing?.startedAt && (b.items as JobItem[]).length !== existing.items.length)
      return reply.code(409).send({
        error:
          'this campaign has already sent — you can edit the messages, but not add or remove one. Stop it and compose a new job for the rest.',
      });

    // Which instance the job will send through: explicit > existing > default.
    if (b.instance !== undefined && b.instance !== null && typeof b.instance !== 'string')
      return reply.code(400).send({ error: 'instance must be a string' });
    const instance =
      b.instance === undefined
        ? (existing?.instance ?? null)
        : typeof b.instance === 'string' && b.instance.trim()
          ? b.instance.trim()
          : null;
    if (!instanceAllowed(req, instance))
      return reply.code(403).send({ error: 'instance not allowed' });

    const batch = parseBatch(b.batch);
    if (batch === 'invalid')
      return reply.code(400).send({
        error:
          'batch must be { size?: >=1, pauseMin?: 0..10080, pauseMinMax?: >pauseMin, pauseAt?: "HH:MM", resumeAt?: "HH:MM", coldCap?: { dailyCap: >=1 }, delay?: { minSec: >=0, maxSec: >=minSec } } — needs a size, a pauseAt, a coldCap, or a delay; resumeAt needs pauseAt; pauseMinMax needs pauseMin > 0',
      });

    const repeat = parseRepeat(b.repeat);
    if (repeat === 'invalid')
      return reply
        .code(400)
        .send({ error: `repeat must be { freq: ${REPEAT_FREQS.join('|')}, until? }` });
    if (repeat && !recurringEnabled())
      return reply
        .code(400)
        .send({ error: 'recurring jobs are disabled — enable them in Settings first' });

    // The approval rule re-evaluates on every save that (re-)queues the job:
    // an edit by a non-permitted agent stays held, an edit/save by a permitted
    // one releases it. Terminal statuses pass through untouched.
    const base = (b.status as JobStatus | undefined) ?? existing?.status ?? 'pending';
    const status =
      base === 'pending' || base === 'pending_approval' ? queueStatus(req, recipients) : base;

    const saved = jobs.upsert({
      id: typeof b.id === 'string' ? b.id : undefined,
      scheduledAt: String(b.scheduledAt),
      status,
      type: typeof b.type === 'string' ? b.type : undefined,
      recipients,
      items: b.items as never,
      result: typeof b.result === 'string' ? b.result : undefined,
      createdAt: typeof b.createdAt === 'string' ? b.createdAt : undefined,
      repeat,
      sentBy: sentBy(req),
      instance,
      batch,
    });
    if (saved.status === 'pending_approval' && existing?.status !== 'pending_approval')
      emit('JOB_APPROVAL', { action: 'submitted', jobId: saved.id, by: sentBy(req) ?? '' });
    if (isDue(saved)) wake?.();
    return saved;
  });

  // Per-recipient send ledger — the structured truth behind a job's result.
  app.get('/api/jobs/:id/sends', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!jobs.byId(id)) return reply.code(404).send({ error: 'not found' });
    return jobs.allSends(id);
  });

  // One page of the same ledger, filtered server-side — what the campaign
  // panel reads so a 1000-recipient job never ships whole to a browser.
  app.get('/api/jobs/:id/sends/page', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!jobs.byId(id)) return reply.code(404).send({ error: 'not found' });
    const q = req.query as Record<string, string | undefined>;
    if (q.status && !SEND_STATUSES.includes(q.status as SendStatus))
      return reply.code(400).send({ error: `status must be one of: ${SEND_STATUSES.join(', ')}` });
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const offset = Math.max(0, Number(q.offset) || 0);
    return jobs.sendsPage(id, {
      status: q.status as SendStatus | undefined,
      // digits only: the stored recipient is a normalized number/jid
      q: (q.q ?? '').replace(/\D/g, ''),
      limit,
      offset,
    });
  });

  // Campaign progress: how far along, how fast, how much is left — read off
  // the ledger, so it survives a refresh, a restart, or a pause of days.
  app.get('/api/jobs/:id/progress', async (req, reply) => {
    const { id } = req.params as { id: string };
    // read per request, so a gap changed in Settings shows up on the next poll
    const assumedDelayMs = cfg ? (cfg.delayMinMs + cfg.delayMaxMs) / 2 : 0;
    const p = jobs.progress(id, assumedDelayMs, cfg?.delayMinMs ?? 0);
    if (!p) return reply.code(404).send({ error: 'not found' });
    return p;
  });

  // The same ledger as a downloadable CSV (reporting outside the app). Takes the
  // table's filter, so "failed only" in the UI downloads the failed only.
  app.get('/api/jobs/:id/ledger.csv', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!jobs.byId(id)) return reply.code(404).send({ error: 'not found' });
    const query = req.query as Record<string, string | undefined>;
    if (query.status && !SEND_STATUSES.includes(query.status as SendStatus))
      return reply.code(400).send({ error: `status must be one of: ${SEND_STATUSES.join(', ')}` });
    const rows = jobs.sendsFiltered(id, {
      status: query.status as SendStatus | undefined,
      q: (query.q ?? '').replace(/\D/g, ''),
    });
    const csv = toCsv(
      ['recipient', 'is_group', 'item_index', 'status', 'attempts', 'message_id', 'sent_at', 'delivered_at', 'read_at', 'error'],
      rows.map((s) => [
        s.recipient, s.isGroup ? 1 : 0, s.itemIndex, s.status, s.attempts,
        s.messageId ?? '', s.sentAt ?? '', s.deliveredAt ?? '', s.readAt ?? '', s.lastError ?? '',
      ]),
    );
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="${id}${query.status ? `-${query.status}` : ''}-ledger.csv"`,
      )
      .send(csv);
  });

  app.post('/api/jobs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const j = jobs.byId(id);
    if (!j) return reply.code(404).send({ error: 'not found' });
    // 'running' too: the scheduler checks for the cancel between sends.
    // 'pending_approval': the submitter withdrawing their request.
    // 'paused': stopping a held campaign for good instead of continuing it.
    if (
      j.status === 'pending' ||
      j.status === 'running' ||
      j.status === 'pending_approval' ||
      j.status === 'paused'
    )
      jobs.setStatus(id, 'cancelled');
    return jobs.byId(id);
  });

  // Hold a campaign. Running: it stops after the send in flight. Pending: it
  // never starts. Unsent ledger rows stay pending, so /resume continues from
  // exactly there — and a paused campaign is the safe moment to edit it.
  app.post('/api/jobs/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string };
    const j = jobs.byId(id);
    if (!j) return reply.code(404).send({ error: 'not found' });
    if (!jobs.pause(id))
      return reply.code(409).send({ error: `job is ${j.status} — only a queued or running job can be paused` });
    return jobs.byId(id);
  });

  // Continue where the ledger left off — also the way back from a Stop that
  // landed mid-campaign. Deliberately NOT re-approved: the job was released
  // once already and is half-sent; re-holding it would strand the remainder.
  app.post('/api/jobs/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };
    const j = jobs.byId(id);
    if (!j) return reply.code(404).send({ error: 'not found' });
    if (!instanceAllowed(req, j.instance))
      return reply.code(403).send({ error: 'instance not allowed' });
    if (!jobs.resume(id))
      return reply
        .code(409)
        .send({ error: `job is ${j.status} — only a paused (or stopped, part-sent) campaign continues` });
    // read the job back BEFORE waking the scheduler: the poke fires the tick
    // that claims it, and the caller asked what resuming did, not who won that
    // race (the SSE progress events report the run itself)
    const resumed = jobs.byId(id);
    wake?.();
    return resumed;
  });

  // Un-cancel, only while the scheduled time is still in the future. The
  // approval rule re-runs — restoring a rejected job re-enters the queue.
  app.post('/api/jobs/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string };
    const j = jobs.byId(id);
    if (!j) return reply.code(404).send({ error: 'not found' });
    if (j.status === 'cancelled' && new Date(j.scheduledAt).getTime() > Date.now()) {
      if (!instanceAllowed(req, j.instance))
        return reply.code(403).send({ error: 'instance not allowed' });
      const status = queueStatus(req, j.recipients);
      jobs.setStatus(id, status);
      if (status === 'pending_approval')
        emit('JOB_APPROVAL', { action: 'submitted', jobId: id, by: sentBy(req) ?? '' });
    }
    return jobs.byId(id);
  });

  // Resend: clone a finished job as an immediate send. The clone gets a fresh
  // id (and so a fresh ledger) — the original stays in history untouched. The
  // approval rule applies to the clone like to any new job.
  app.post('/api/jobs/:id/rerun', async (req, reply) => {
    const { id } = req.params as { id: string };
    const j = jobs.byId(id);
    if (!j) return reply.code(404).send({ error: 'not found' });
    if (j.status === 'pending' || j.status === 'running' || j.status === 'pending_approval')
      return reply.code(409).send({ error: 'job is still queued or running' });
    if (!instanceAllowed(req, j.instance))
      return reply.code(403).send({ error: 'instance not allowed' });
    const clone = jobs.upsert({
      scheduledAt: new Date().toISOString(),
      status: queueStatus(req, j.recipients),
      type: 'immediate',
      recipients: j.recipients,
      items: j.items,
      sentBy: sentBy(req),
      instance: j.instance,
    });
    if (clone.status === 'pending_approval')
      emit('JOB_APPROVAL', { action: 'submitted', jobId: clone.id, by: sentBy(req) ?? '' });
    else wake?.();
    return clone;
  });

  // "Send to the ones that failed." Failed rows go back to pending and the job
  // is re-queued, so continuing reaches exactly them — sent rows are untouched,
  // so nobody hears from us twice. Refused while it is running: the run would
  // race the rows it is already retrying internally.
  app.post('/api/jobs/:id/retry-failed', async (req, reply) => {
    const { id } = req.params as { id: string };
    const j = jobs.byId(id);
    if (!j) return reply.code(404).send({ error: 'not found' });
    if (!instanceAllowed(req, j.instance))
      return reply.code(403).send({ error: 'instance not allowed' });
    if (j.status === 'running' || j.status === 'pending_approval')
      return reply.code(409).send({ error: `job is ${j.status} — pause it first` });
    const retried = jobs.requeueFailed(id);
    if (!retried) return reply.code(409).send({ error: 'nothing failed on this job' });
    // due now, whatever state it had finished in
    jobs.upsert({
      id,
      scheduledAt: new Date().toISOString(),
      status: 'pending',
      recipients: j.recipients,
      items: j.items,
      type: j.type ?? undefined,
    });
    wake?.();
    return { retried, job: jobs.byId(id) };
  });

  // "Keep the ones that were not sent." Turns the failed + not-yet-sent
  // recipients into a saved list, so they can be sent to later from Compose —
  // days later, from a different sequence, however the operator wants. This is
  // the deliberate alternative to retrying in place: the campaign itself stays
  // exactly as it ended, and the list is an ordinary audience with names intact
  // (taken from the job, so {{name}} keeps working).
  if (lists) {
    app.post('/api/jobs/:id/unsent-list', async (req, reply) => {
      const { id } = req.params as { id: string };
      const job = jobs.byId(id);
      if (!job) return reply.code(404).send({ error: 'not found' });
      const unsent = jobs.unsentRecipients(id);
      if (!unsent.length)
        return reply.code(409).send({ error: 'everyone on this job was sent to (or skipped)' });

      const raw = ((req.body ?? {}) as { name?: unknown }).name;
      const name =
        typeof raw === 'string' && raw.trim()
          ? raw.trim().slice(0, 120)
          : `Not sent — ${new Date(job.scheduledAt).toLocaleDateString()} (${unsent.length})`;
      // names come from the job's own recipients, so the list feeds {{name}}
      const named = new Map(job.recipients.map((r) => [r.id, r.name ?? '']));
      const list = lists.create(name);
      const saved = lists.setMembers(
        list.id,
        unsent.map((u) => ({ recipient: u.recipient, name: named.get(u.recipient) ?? '' })),
      );
      return { list: lists.byId(list.id), members: saved.members, invalid: saved.invalid };
    });

    // The generic version: whichever status chip is selected becomes a saved
    // list, same names-preserved shape as unsent-list. This is the "create as
    // a list" counterpart to /recipients' "open in Compose" — pick a chip,
    // pick an action.
    app.post('/api/jobs/:id/status-list', async (req, reply) => {
      const { id } = req.params as { id: string };
      const job = jobs.byId(id);
      if (!job) return reply.code(404).send({ error: 'not found' });
      const body = (req.body ?? {}) as { status?: unknown; name?: unknown };
      if (typeof body.status !== 'string' || !SEND_STATUSES.includes(body.status as SendStatus))
        return reply.code(400).send({ error: `status must be one of: ${SEND_STATUSES.join(', ')}` });
      const status = body.status as SendStatus;
      const recipients = jobs.recipientsByStatus(id, [status]);
      if (!recipients.length) return reply.code(409).send({ error: `no ${status} recipients` });

      const name =
        typeof body.name === 'string' && body.name.trim()
          ? body.name.trim().slice(0, 120)
          : `${status.charAt(0).toUpperCase()}${status.slice(1)} — ${new Date(job.scheduledAt).toLocaleDateString()} (${recipients.length})`;
      const named = new Map(job.recipients.map((r) => [r.id, r.name ?? '']));
      const list = lists.create(name);
      const saved = lists.setMembers(
        list.id,
        recipients.map((u) => ({ recipient: u.recipient, name: named.get(u.recipient) ?? '' })),
      );
      return { list: lists.byId(list.id), members: saved.members, invalid: saved.invalid };
    });
  }

  // The recipients behind one ledger status chip, with names filled in from
  // the job — the "open Compose to just these" hand-off. Unlike unsent-list
  // this doesn't persist anything; Compose holds the draft until it's sent.
  app.get('/api/jobs/:id/recipients', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = jobs.byId(id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    const status = (req.query as Record<string, string | undefined>).status;
    if (!status || !SEND_STATUSES.includes(status as SendStatus))
      return reply.code(400).send({ error: `status must be one of: ${SEND_STATUSES.join(', ')}` });
    const named = new Map(job.recipients.map((r) => [r.id, r.name]));
    const recipients = jobs
      .recipientsByStatus(id, [status as SendStatus])
      .map((r) => ({ id: r.recipient, isGroup: r.isGroup, name: named.get(r.recipient) }));
    return { recipients };
  });

  app.delete('/api/jobs/:id', async (req) => {
    jobs.delete((req.params as { id: string }).id);
    return { ok: true };
  });

  // Bulk-clearing finished/cancelled jobs wipes their ledger irreversibly —
  // admins only by default (jobs.clearHistory). No-op guard in older tests
  // that don't wire cfg/agents.
  const requireClear =
    cfg && agents ? requirePerm('jobs.clearHistory', { cfg, agents }) : undefined;
  app.post('/api/jobs/clear-done', { preHandler: requireClear }, async (req, reply) => {
    const scope = ((req.body ?? {}) as { scope?: string }).scope;
    if (scope != null && !SCOPES.includes(scope as JobScope))
      return reply.code(400).send({ error: `scope must be one of: ${SCOPES.join(', ')}` });
    return { ok: true, removed: jobs.clearDone(scope as JobScope | undefined) };
  });

  // Bulk-deleting a chosen set of jobs is the same irreversible action as
  // clear-done, just id-scoped instead of status-scoped — same permission bar.
  app.post('/api/jobs/bulk-delete', { preHandler: requireClear }, async (req, reply) => {
    const ids = ((req.body ?? {}) as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string'))
      return reply.code(400).send({ error: 'ids must be a non-empty array of strings' });
    if (ids.length > 500) return reply.code(400).send({ error: 'ids: at most 500 at a time' });
    return { ok: true, removed: jobs.deleteMany(ids as string[]) };
  });

  // Approval queue actions — holders of jobs.approve only.
  if (cfg && agents) {
    const requireApprover = requirePerm('jobs.approve', { cfg, agents });

    app.post('/api/jobs/:id/approve', { preHandler: requireApprover }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const j = jobs.byId(id);
      if (!j) return reply.code(404).send({ error: 'not found' });
      // approve() also bumps an already-due scheduled_at to now, so the
      // overdue guard can't finalize the released job 'missed'
      if (!jobs.approve(id)) return reply.code(409).send({ error: 'job is not awaiting approval' });
      emit('JOB_APPROVAL', { action: 'approved', jobId: id, by: emailFromRequest(req) ?? '' });
      wake?.();
      return jobs.byId(id);
    });

    app.post('/api/jobs/:id/reject', { preHandler: requireApprover }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const j = jobs.byId(id);
      if (!j) return reply.code(404).send({ error: 'not found' });
      if (j.status !== 'pending_approval')
        return reply.code(409).send({ error: 'job is not awaiting approval' });
      const reason = String(((req.body ?? {}) as { reason?: unknown }).reason ?? '').trim();
      const by = emailFromRequest(req) ?? '';
      jobs.finish(id, 'cancelled', `rejected${by ? ` by ${by}` : ''}${reason ? `: ${reason}` : ''}`);
      emit('JOB_APPROVAL', { action: 'rejected', jobId: id, by, reason });
      return jobs.byId(id);
    });
  }
}
