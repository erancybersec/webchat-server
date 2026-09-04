import type { BatchRule, CampaignProgress, Job } from '../types';

/** A campaign is a send big enough to be worth pacing and watching. */
export const CAMPAIGN_AT = 20;

/** Whether the campaign panel (progress, Pause/Continue) belongs on a job. */
export function isCampaign(job: Pick<Job, 'recipients' | 'batch' | 'startedAt'>): boolean {
  return !!job.batch || !!job.startedAt || job.recipients.length >= CAMPAIGN_AT;
}

/**
 * Whether a job is still "in play" from one recipient's chat — worth a ghost
 * bubble / scheduled-indicator, and a candidate for "remove me from this
 * campaign". Includes 'paused' (a human-held campaign is very much ongoing)
 * and an 'immediate' send only when it has more than one recipient — a
 * single-recipient "send now" finishes in seconds and was never "scheduled
 * work"; a multi-recipient one can stay pending/paused for hours (batch
 * pacing, a sending window) and is exactly the case worth surfacing here.
 */
export function isOngoingForChat(job: Pick<Job, 'status' | 'type' | 'recipients'>): boolean {
  if (job.status !== 'pending' && job.status !== 'paused') return false;
  return job.type !== 'immediate' || job.recipients.length > 1;
}

/** "3h 20m" / "12m" / "under a minute" — a duration as an operator reads it. */
export function humanMinutes(min: number): string {
  if (!Number.isFinite(min) || min < 1) return 'under a minute';
  const total = Math.round(min);
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  const days = Math.floor(h / 24);
  if (days >= 1) return m || h % 24 ? `${days}d ${h % 24}h` : `${days}d`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Wall-clock time, dropping the date when it's still today. */
export function clockLabel(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** "312 of 1,043 · 18/min · about 40m left" — the line under the bar. */
export function progressLine(p: CampaignProgress): string {
  const done = p.sent + p.skipped + p.failed;
  const parts = [`${done.toLocaleString()} of ${p.total.toLocaleString()}`];
  // A pace and a finish time are only honest while the campaign is actually
  // going (or due to continue by itself). One that waits for a human has no
  // finish time to promise — waitingLabel says what it needs instead.
  const moving = p.status === 'running' || p.status === 'pending';
  if (p.pending > 0 && moving && p.ratePerMin)
    parts.push(`${p.ratePerMin >= 10 ? Math.round(p.ratePerMin) : p.ratePerMin.toFixed(1)}/min`);
  if (p.pending > 0 && moving && p.etaMinutes != null)
    parts.push(p.etaMinutes < 1 ? 'under a minute left' : `about ${humanMinutes(p.etaMinutes)} left`);
  return parts.join(' · ');
}

/**
 * A hold the operator configured on purpose (a batch boundary, the sending
 * window closing for the day) vs one that means the campaign hit something
 * unplanned (the daily cold-contact cap, a dead line) — the first is already
 * explained by the pacing chips next to it and needs no further comment; the
 * second is the one thing on this row worth a second look.
 */
export type HoldKind = 'routine' | 'attention';
const ROUTINE_HOLD = /^(batch of \d+ sent|reached \d{1,2}:\d{2})$/;
function classifyHold(holdReason: string | null): HoldKind {
  return holdReason && !ROUTINE_HOLD.test(holdReason) ? 'attention' : 'routine';
}

/**
 * What the campaign is waiting for, in words — null while it is simply running
 * (the bar already says that).
 */
export function waitingLabel(p: CampaignProgress): { text: string; kind: HoldKind } | null {
  if (p.pending === 0) return null;
  const kind = classifyHold(p.holdReason ?? null);
  // Routine holds are self-explanatory from the pacing chips ("46 per batch",
  // "until 18:00") sitting right next to this text — repeating the scheduler's
  // internal reason string there would just be noise. An attention-worthy hold
  // has no chip to explain it, so it gets spelled out in full.
  const why = kind === 'attention' && p.holdReason ? ` — ${p.holdReason}` : '';
  // a sequence sends several messages per contact — spell out the people
  // count too whenever it differs from the message-row count
  const toContacts =
    p.contacts.pending !== p.pending ? ` (${p.contacts.pending.toLocaleString()} contacts)` : '';
  if (p.status === 'paused')
    return { text: `Paused${why} · ${p.pending.toLocaleString()} still to send${toContacts}`, kind };
  if (p.status === 'cancelled')
    return { text: `Stopped · ${p.pending.toLocaleString()} never sent${toContacts}`, kind: 'routine' };
  if (p.status === 'pending' && p.nextRunAt && new Date(p.nextRunAt).getTime() > Date.now()) {
    if (kind === 'attention') return { text: `Continues ${clockLabel(p.nextRunAt)}${why}`, kind };
    // "next batch" only means something when there ARE batches; a campaign
    // waiting out its sending window is simply continuing at an hour
    const text = p.batch?.size ? `Next batch ${clockLabel(p.nextRunAt)}` : `Continues ${clockLabel(p.nextRunAt)}`;
    return { text, kind };
  }
  return null;
}

/** The sending window in words: "sends until 21:00, continues 09:00". */
function windowSummary(rule: BatchRule): string | null {
  if (!rule.pauseAt) return null;
  return rule.resumeAt
    ? `sends until ${rule.pauseAt}, then continues at ${rule.resumeAt}`
    : `sends until ${rule.pauseAt}, then waits for your Continue`;
}

/** "30m" or, ranged, "20–40m" — mirrors backend BatchRule.pauseMinMax. */
export function pauseLabel(rule: BatchRule): string {
  return rule.pauseMinMax && rule.pauseMinMax > rule.pauseMin
    ? `${rule.pauseMin}–${rule.pauseMinMax}m`
    : `${rule.pauseMin}m`;
}

function parseHHMM(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes < 24 * 60 ? minutes : null;
}

/** `now` inside the HH:MM..HH:MM window; supports overnight (mirrors backend services/time.ts). */
function inQuietHours(now: Date, start: string, end: string): boolean {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s == null || e == null || s === e) return false;
  const n = now.getHours() * 60 + now.getMinutes();
  return s < e ? n >= s && n < e : n >= s || n < e;
}

/** The next moment the local clock reads 'HH:MM' (mirrors backend services/time.ts). */
function nextClockTime(now: Date, hhmm: string): Date {
  const t = parseHHMM(hhmm) ?? 0;
  const out = new Date(now);
  out.setHours(Math.floor(t / 60), t % 60, 0, 0);
  if (out.getTime() <= now.getTime()) out.setDate(out.getDate() + 1);
  return out;
}

/**
 * When a paced campaign would actually finish — honoring both the batch wait
 * and the sending-hours window, which a plain `messages*avgDelaySec` never
 * subtracts (an overnight window pause is real elapsed time, not free).
 * `null` means no honest finish exists: the pacing ahead depends on a human
 * (a manual batch wait, or a window with no auto-resume) — guessing when a
 * human will act would only look precise. Mirrors `estimatePendingMinutes` in
 * backend/src/services/jobs.ts, which the live campaign card's ETA uses.
 */
export function estimateFinish(
  rule: BatchRule,
  messages: number,
  avgDelaySec: number,
  now = new Date(),
): { finishAt: Date; totalMinutes: number } | null {
  if (messages <= 0 || avgDelaySec <= 0) return null;
  const hasBatch = !!rule.size;
  const hasWindow = !!rule.pauseAt;
  if (hasBatch && rule.pauseMin === 0) return null;
  if (hasWindow && !rule.resumeAt) return null;
  if (!hasBatch && !hasWindow)
    return {
      finishAt: new Date(now.getTime() + messages * avgDelaySec * 1000),
      totalMinutes: (messages * avgDelaySec) / 60,
    };

  const waitPerBoundaryMin = hasBatch
    ? rule.pauseMinMax && rule.pauseMinMax > rule.pauseMin
      ? (rule.pauseMin + rule.pauseMinMax) / 2
      : rule.pauseMin
    : 0;
  const msPerMsg = avgDelaySec * 1000;

  let cursor = now.getTime();
  let remaining = messages;
  let sinceBoundary = 0;
  let guard = 0; // a pathological rule (e.g. a window that never opens) must not hang
  while (remaining > 0 && guard++ < 100_000) {
    if (hasWindow && inQuietHours(new Date(cursor), rule.pauseAt!, rule.resumeAt!)) {
      // a fresh run starts counting its own batch from zero, exactly as a real
      // resume after a window pause is a new run
      cursor = nextClockTime(new Date(cursor), rule.resumeAt!).getTime();
      sinceBoundary = 0;
    }
    const windowEnd = hasWindow ? nextClockTime(new Date(cursor), rule.pauseAt!).getTime() : Infinity;
    const capByWindow = hasWindow ? Math.max(0, Math.floor((windowEnd - cursor) / msPerMsg)) : Infinity;
    const capByBatch = hasBatch ? rule.size! - sinceBoundary : Infinity;
    const chunk = Math.min(remaining, capByWindow, capByBatch);
    if (chunk <= 0) {
      cursor = windowEnd;
      continue;
    }
    cursor += chunk * msPerMsg;
    remaining -= chunk;
    sinceBoundary += chunk;
    if (remaining <= 0) break;
    if (hasBatch && sinceBoundary >= rule.size!) {
      cursor += waitPerBoundaryMin * 60_000;
      sinceBoundary = 0;
    }
  }
  return { finishAt: new Date(cursor), totalMinutes: (cursor - now.getTime()) / 60_000 };
}

/**
 * Compose's plain-English read-back of the pacing, so the sender sees what they
 * just set up before 1000 people do. `avgDelaySec` is the server's send gap.
 */
export function batchSummary(
  rule: BatchRule,
  messages: number,
  avgDelaySec: number,
  now = new Date(),
): string {
  const head = `${messages.toLocaleString()} message${messages === 1 ? '' : 's'}`;
  const window = windowSummary(rule);
  const est = estimateFinish(rule, messages, avgDelaySec, now);
  // a window with no batching: the hours are the whole story. The window's
  // overnight gap already folds into `est.totalMinutes` when it applies — no
  // separate finish clause needed here, the "about X of sending" total says it.
  if (!rule.size) {
    const runMinutes = est?.totalMinutes ?? (messages * avgDelaySec) / 60;
    const sending = `about ${humanMinutes(runMinutes)} of sending`;
    return window ? `${head} — ${window} · ${sending}` : `${head} — ${sending}`;
  }
  const batches = Math.max(1, Math.ceil(messages / rule.size));
  const batchPart =
    batches === 1
      ? `${head} in one batch of up to ${rule.size.toLocaleString()} — no batch pause`
      : rule.pauseMin === 0
        ? `${head} in ${batches} batches of up to ${rule.size.toLocaleString()} — each waits for your Continue`
        : (() => {
            const naiveTotal = (messages * avgDelaySec) / 60 + (batches - 1) * rule.pauseMin;
            const totalMinutes = est?.totalMinutes ?? naiveTotal;
            return `${head} in ${batches} batches of up to ${rule.size.toLocaleString()}, ${pauseLabel(rule)} apart — about ${humanMinutes(totalMinutes)} in total`;
          })();
  return window ? `${batchPart} · ${window}` : batchPart;
}

/** One line of `/api/sending-limits`' coldContacts — see frontend/src/lib/api.ts. */
interface ColdContactsLimit {
  spent: number;
  cap: number;
  remaining: number | null;
  enabled: boolean;
}

/**
 * An honest caveat for when a recipient list is bigger than today's
 * first-contact ration — never merged into the main ETA, since Compose can't
 * know in advance how many of these recipients are actually cold (that's
 * decided per-recipient at send time). Worst-case assumes every recipient is
 * new, and holds the daily cap flat across projected days rather than
 * simulating the warm-up ramp continuing to climb — simpler, and never
 * overstates how fast this will go. `null` when the list comfortably fits.
 */
export function coldCapCaveat(
  recipientCount: number,
  coldContacts: ColdContactsLimit,
  override?: { dailyCap: number },
): string | null {
  if (!override && !coldContacts.enabled) return null;
  const dailyCap = override?.dailyCap ?? coldContacts.cap;
  const firstDay = override ? Math.max(0, override.dailyCap - coldContacts.spent) : (coldContacts.remaining ?? Infinity);
  if (recipientCount <= firstDay || dailyCap <= 0) return null;
  const extraDays = Math.ceil((recipientCount - firstDay) / dailyCap);
  const totalDays = 1 + extraDays;
  return `If every recipient turns out to be new, the cap alone would take about ${totalDays} day${totalDays === 1 ? '' : 's'} — depends how many are already known.`;
}
