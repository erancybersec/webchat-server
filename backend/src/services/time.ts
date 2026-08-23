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
