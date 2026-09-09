/**
 * Wall-clock helpers shared by everything that must respect the operator's
 * hours. They live apart from the scheduler because the verification sweep
 * needs them too, and importing the scheduler from a service the sender
 * already imports would close a cycle.
 */

function parseHHMM(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes < 24 * 60 ? minutes : null;
}

/** Whether `now` falls inside the quiet window; supports overnight windows. */
export function inQuietHours(now: Date, start: string, end: string): boolean {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s == null || e == null || s === e) return false;
  const n = now.getHours() * 60 + now.getMinutes();
  return s < e ? n >= s && n < e : n >= s || n < e;
}

/** The next moment the local clock reads 'HH:MM' — today if still ahead. */
export function nextClockTime(now: Date, hhmm: string): Date {
  const t = parseHHMM(hhmm) ?? 0;
  const out = new Date(now);
  out.setHours(Math.floor(t / 60), t % 60, 0, 0);
  if (out.getTime() <= now.getTime()) out.setDate(out.getDate() + 1);
  return out;
}

/** The moment the current quiet window ends (today or tomorrow). */
export function quietHoursEnd(now: Date, end: string): Date {
  return nextClockTime(now, end);
}

/** `date` at exactly 'HH:MM', that same calendar day — unlike `nextClockTime`,
 *  never rolls to tomorrow even if that moment is already past. */
export function atClockOnDate(date: Date, hhmm: string): Date {
  const t = parseHHMM(hhmm) ?? 0;
  const out = new Date(date);
  out.setHours(Math.floor(t / 60), t % 60, 0, 0);
  return out;
}

/** A rule's day-of-week gate: shaped like `BatchRule`'s day fields, kept
 *  structural (not imported from types.ts) so this file stays dependency-free. */
export interface DayGatedRule {
  activeDays?: number[];
  pauseAt?: string;
  resumeAt?: string;
  /** Per-day override keyed by day-of-week (0=Sun..6=Sat), same shape as the
   *  rule's own pauseAt/resumeAt; an absent field on a day falls back to it. */
  dayHours?: Record<number, { pauseAt?: string; resumeAt?: string }>;
}

/** Whether `date`'s day-of-week is one the campaign is allowed to run on.
 *  Absent/empty `activeDays` = every day (the feature is off). */
export function isActiveDay(activeDays: number[] | undefined, date: Date): boolean {
  return !activeDays?.length || activeDays.includes(date.getDay());
}

/** `date`'s effective pause/resume hours: that day's override if one exists,
 *  otherwise the rule's own — so a day-limited campaign with no per-day
 *  customization behaves exactly like the plain window it was built from. */
export function dayWindow(
  rule: DayGatedRule | null | undefined,
  date: Date,
): { pauseAt?: string; resumeAt?: string } {
  const override = rule?.dayHours?.[date.getDay()];
  return {
    pauseAt: override?.pauseAt ?? rule?.pauseAt,
    resumeAt: override?.resumeAt ?? rule?.resumeAt,
  };
}

/**
 * The next moment a day-limited campaign may resume, starting the search
 * tomorrow (never today — callers use this only once today's run is over).
 * Returns the found day's own resumeAt if it has an hour window with one,
 * that day's midnight if it has no hour window at all (nothing to wait for),
 * or `null` if the next active day's window needs a human Continue. Searches
 * up to a week ahead — `activeDays` is expected non-empty when this is called.
 */
export function nextActiveMoment(rule: DayGatedRule | null | undefined, from: Date): Date | null {
  for (let offset = 1; offset <= 7; offset++) {
    const d = new Date(from);
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    if (!isActiveDay(rule?.activeDays, d)) continue;
    const w = dayWindow(rule, d);
    if (!w.pauseAt) return d;
    return w.resumeAt ? atClockOnDate(d, w.resumeAt) : null;
  }
  return null;
}
