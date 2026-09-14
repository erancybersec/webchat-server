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

/**
 * "152 of 230 sent · 6 skipped · 72 remaining · 2.6/min, about 25m left" — the
 * one line that answers "how much has been sent" at a glance. A pace and a
 * finish time are only honest while the campaign is actually going (or due to
 * continue by itself) — one that waits for a human has no finish time to
 * promise, `holdInfo` says what it needs instead. It's also dishonest while
 * an ATTENTION hold is active (the cap, say): the server's ETA math paces
 * off `ratePerMin` alone and has no idea a multi-hour hold is coming, so
 * showing "under a minute left" next to a block that says "resumes in 7
 * hours" would flatly contradict it.
 */
export function progressLine(p: CampaignProgress): string {
  const parts = [`${p.sent.toLocaleString()} of ${p.total.toLocaleString()} sent`];
  if (p.skipped > 0) parts.push(`${p.skipped.toLocaleString()} skipped`);
  if (p.failed > 0) parts.push(`${p.failed.toLocaleString()} failed`);
  if (p.pending > 0) parts.push(`${p.pending.toLocaleString()} remaining`);
  const moving = (p.status === 'running' || p.status === 'pending') && classifyHold(p.holdReason ?? null).kind !== 'attention';
  if (p.pending > 0 && moving && (p.ratePerMin || p.etaMinutes != null)) {
    const pace: string[] = [];
    if (p.ratePerMin) pace.push(`${p.ratePerMin >= 10 ? Math.round(p.ratePerMin) : p.ratePerMin.toFixed(1)}/min`);
    if (p.etaMinutes != null)
      pace.push(p.etaMinutes < 1 ? 'under a minute left' : `about ${humanMinutes(p.etaMinutes)} left`);
    parts.push(pace.join(', '));
  }
  return parts.join(' · ');
}

/**
 * A hold the operator configured on purpose (a batch boundary, the sending
 * window closing for the day) vs one that means the campaign hit something
 * unplanned (the daily cold-contact cap, a dead line) — the first is calm,
 * everyday pacing; the second is the one thing on this row worth a second
 * look. `scenario` further tells the routine holds apart from each other, so
 * "batch of 30 sent" and "reached 21:00" never collapse into the same
 * mislabel — but none of these scenario names, or the server's own
 * hold-reason string, are meant to reach the card: `holdInfo` below is the
 * only thing allowed to translate one into what the operator actually reads.
 */
export type HoldKind = 'routine' | 'attention';
type HoldScenario = 'batch' | 'window' | 'day' | 'cap' | 'other';
function classifyHold(holdReason: string | null): { kind: HoldKind; scenario: HoldScenario } {
  if (holdReason && /^batch of \d+ sent$/.test(holdReason)) return { kind: 'routine', scenario: 'batch' };
  if (holdReason && /^reached \d{1,2}:\d{2}$/.test(holdReason)) return { kind: 'routine', scenario: 'window' };
  if (holdReason === 'not an active day for this campaign') return { kind: 'routine', scenario: 'day' };
  if (holdReason && /^daily cold-contact cap reached/.test(holdReason)) return { kind: 'attention', scenario: 'cap' };
  return { kind: holdReason ? 'attention' : 'routine', scenario: 'other' };
}

/**
 * Whether pressing "Continue now" would actually do anything — false for the
 * one hold the scheduler can't be talked out of early: the daily cold-contact
 * cap re-evaluates itself the moment the job wakes up, so continuing before
 * the cap resets just re-hits the same limit and reschedules for nothing.
 * Every other hold (a batch pause, a closed sending window, an inactive day,
 * a plain hand pause) genuinely fires early on request.
 */
export function canContinueNow(holdReason: string | null): boolean {
  return classifyHold(holdReason).scenario !== 'cap';
}

/** "today at 14:00" / "tomorrow at 09:00" / "Mon at 09:00" — how an operator
 *  reads a resume moment relative to now, not just its bare clock time. Falls
 *  back to `clockLabel`'s month/day form more than a week out. */
function dayRelativeLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 0) return `today at ${time}`;
  if (diffDays === 1) return `tomorrow at ${time}`;
  if (diffDays > 1 && diffDays < 7) return `${DAY_NAMES[d.getDay()]} at ${time}`;
  return clockLabel(iso);
}

export interface HoldInfo {
  /** Short, bold statement of what's happening — never scheduler vocabulary. */
  headline: string;
  /** One supporting line: why, and/or when it resumes. */
  detail: string;
  kind: HoldKind;
}

/**
 * The one thing to say about why a campaign isn't sending right now — a
 * headline plus a single supporting line, collapsing every internal hold
 * reason down to a handful of user-facing scenarios. `null` while the
 * campaign is simply running (the bar already says that) or while nothing
 * is left to send. Every hold gets a block, batch boundaries included — a
 * "Waiting" pill with nothing under it to say why or when reads as broken,
 * not calm; a batch pause earns the routine (uncolored) treatment, same as
 * a sending-window wait, not a louder one.
 */
export function holdInfo(p: CampaignProgress): HoldInfo | null {
  if (p.pending === 0) return null;
  const { kind, scenario } = classifyHold(p.holdReason ?? null);
  if (p.status === 'cancelled')
    return { headline: 'Stopped', detail: `${p.pending.toLocaleString()} never sent`, kind: 'routine' };
  if (p.status === 'paused') {
    if (scenario === 'window')
      return { headline: 'Outside sending hours', detail: "Won't resume until you press Continue", kind: 'routine' };
    if (kind === 'attention' && p.holdReason)
      return { headline: 'Needs attention', detail: `${p.holdReason} — won't resume until you press Continue`, kind };
    return { headline: 'Paused', detail: "Won't resume until you press Continue", kind: 'routine' };
  }
  if (p.status === 'pending' && p.nextRunAt && new Date(p.nextRunAt).getTime() > Date.now()) {
    const when = dayRelativeLabel(p.nextRunAt);
    if (scenario === 'cap') {
      const held = /(\d+) first-time recipient/.exec(p.holdReason ?? '')?.[1];
      const detail = held
        ? `${held} new contact${held === '1' ? '' : 's'} held back — resumes ${when}`
        : `Resumes ${when}`;
      return { headline: 'Daily contact limit reached', detail, kind: 'attention' };
    }
    if (scenario === 'window') return { headline: 'Outside sending hours', detail: `Sending resumes ${when}`, kind: 'routine' };
    if (scenario === 'day') return { headline: 'Not an active day', detail: `Sending resumes ${when}`, kind: 'routine' };
    if (scenario === 'batch') return { headline: 'Between batches', detail: `Next batch ${when}`, kind: 'routine' };
    if (kind === 'attention') return { headline: 'Needs attention', detail: p.holdReason ?? `Resumes ${when}`, kind };
    // no recognized reason at all (older data, a caller that never set one) —
    // still say something rather than leaving "Waiting" unexplained
    return { headline: 'Waiting', detail: `Continues ${when}`, kind: 'routine' };
  }
  return null;
}

/** The sending window in words: "sends until 21:00, continues 09:00", plus the
 *  day gate when one is set — "on Sun, Mon, Tue, Wed, Thu" on its own if there's
 *  no hour window at all. */
function windowSummary(rule: BatchRule): string | null {
  const days = rule.activeDays?.length ? `on ${activeDaysLabel(rule.activeDays)}` : null;
  if (!rule.pauseAt) return days;
  const hours = rule.resumeAt
    ? `sends until ${rule.pauseAt}, then continues at ${rule.resumeAt}`
    : `sends until ${rule.pauseAt}, then waits for your Continue`;
  return days ? `${hours}, ${days}` : hours;
}

/** "30m" or, ranged, "20–40m" — mirrors backend BatchRule.pauseMinMax. */
export function pauseLabel(rule: BatchRule): string {
  return rule.pauseMinMax && rule.pauseMinMax > rule.pauseMin
    ? `${rule.pauseMin}–${rule.pauseMinMax}m`
    : `${rule.pauseMin}m`;
}

/**
 * "Sending hours 09:00–21:00 · batches of 30, 5–8 min apart" — the pacing
 * rule as one quiet sentence for a live campaign card's footer. Unlike
 * `windowSummary` (Compose's before-you-send readback, which frames the same
 * facts as a warning — "then waits for your Continue"), this is background
 * configuration, not something to react to; `null` when there's no pacing
 * rule at all. The within-batch counter (`batchSent`) deliberately isn't
 * part of this — it's implementation detail that competes with campaign
 * progress rather than explaining it.
 */
export function paceSummary(rule: BatchRule | null): string | null {
  if (!rule) return null;
  const parts: string[] = [];
  if (rule.pauseAt) parts.push(rule.resumeAt ? `Sending hours ${rule.resumeAt}–${rule.pauseAt}` : `Sends until ${rule.pauseAt}`);
  if (rule.activeDays?.length) parts.push(`on ${activeDaysLabel(rule.activeDays)}`);
  if (rule.size) parts.push(rule.pauseMin > 0 ? `batches of ${rule.size}, ${pauseLabel(rule)} apart` : `batches of ${rule.size} — manual continue`);
  return parts.length ? parts.join(' · ') : null;
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

/** `date` at exactly 'HH:MM', that same calendar day (mirrors backend services/time.ts). */
function atClockOnDate(date: Date, hhmm: string): Date {
  const t = parseHHMM(hhmm) ?? 0;
  const out = new Date(date);
  out.setHours(Math.floor(t / 60), t % 60, 0, 0);
  return out;
}

/** Whether `date`'s day-of-week is allowed by `activeDays` (mirrors backend). */
function isActiveDay(activeDays: number[] | undefined, date: Date): boolean {
  return !activeDays?.length || activeDays.includes(date.getDay());
}

/** `date`'s effective pause/resume hours — a per-day override, or the rule's own (mirrors backend). */
function dayWindow(rule: BatchRule, date: Date): { pauseAt?: string; resumeAt?: string } {
  const override = rule.dayHours?.[date.getDay()];
  return { pauseAt: override?.pauseAt ?? rule.pauseAt, resumeAt: override?.resumeAt ?? rule.resumeAt };
}

/** The next moment a day-limited campaign may resume (mirrors backend `nextActiveMoment`). */
function nextActiveMoment(rule: BatchRule, from: Date): Date | null {
  for (let offset = 1; offset <= 7; offset++) {
    const d = new Date(from);
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    if (!isActiveDay(rule.activeDays, d)) continue;
    const w = dayWindow(rule, d);
    if (!w.pauseAt) return d;
    return w.resumeAt ? atClockOnDate(d, w.resumeAt) : null;
  }
  return null;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Sun, Mon, Tue, Wed, Thu" in calendar order, starting from Sunday. */
export function activeDaysLabel(activeDays: number[]): string {
  return [...activeDays]
    .sort((a, b) => a - b)
    .map((d) => DAY_NAMES[d])
    .join(', ');
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
  const hasDays = !!rule.activeDays?.length;
  const hasWindow = !!rule.pauseAt || hasDays;
  if (hasBatch && rule.pauseMin === 0) return null;
  if (!hasDays && hasWindow && !rule.resumeAt) return null;
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
    const cursorDate = new Date(cursor);
    if (hasDays && !isActiveDay(rule.activeDays, cursorDate)) {
      const next = nextActiveMoment(rule, cursorDate);
      if (!next) return null;
      cursor = next.getTime();
      sinceBoundary = 0;
      continue;
    }
    const win = hasDays ? dayWindow(rule, cursorDate) : { pauseAt: rule.pauseAt, resumeAt: rule.resumeAt };
    if (win.pauseAt && !win.resumeAt) return null;
    if (win.pauseAt && inQuietHours(cursorDate, win.pauseAt, win.resumeAt!)) {
      // a fresh run starts counting its own batch from zero, exactly as a real
      // resume after a window pause is a new run
      cursor = nextClockTime(cursorDate, win.resumeAt!).getTime();
      sinceBoundary = 0;
      continue;
    }
    let dayCloseMs = Infinity;
    if (hasDays) {
      const midnight = new Date(cursorDate);
      midnight.setDate(midnight.getDate() + 1);
      midnight.setHours(0, 0, 0, 0);
      dayCloseMs = midnight.getTime();
    }
    const windowEnd = win.pauseAt ? nextClockTime(cursorDate, win.pauseAt).getTime() : dayCloseMs;
    const capByWindow =
      win.pauseAt || hasDays ? Math.max(0, Math.floor((windowEnd - cursor) / msPerMsg)) : Infinity;
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
