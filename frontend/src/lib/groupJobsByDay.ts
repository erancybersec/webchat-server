import type { Job } from '../types';

export interface JobDayGroup {
  key: string;
  label: string;
  jobs: Job[];
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Which bucket a date falls into, relative to `now` — granularity tapers
 * from per-day (recent) to per-month (older) in either direction. */
function bucketFor(date: Date, now: Date): { key: string; label: string } {
  const diff = Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000);
  if (diff === 0) return { key: 'today', label: 'Today' };
  if (diff === -1) return { key: 'yesterday', label: 'Yesterday' };
  if (diff === 1) return { key: 'tomorrow', label: 'Tomorrow' };

  const future = diff > 0;
  const ad = Math.abs(diff);
  // distinct keys for the future/past variants — a job list is normally all
  // one direction, but an overdue "pending" scheduled job could land in the
  // past, and it must not merge into a future "This week" bucket
  if (ad <= 6) return { key: future ? 'week+' : 'week-', label: 'This week' };
  if (ad <= 13) return { key: future ? 'nextweek' : 'lastweek', label: future ? 'Next week' : 'Last week' };

  const monthName = MONTH_NAMES[date.getMonth()];
  const sameMonth = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  if (sameMonth) {
    return future
      ? { key: 'later-this-month', label: `Later in ${monthName}` }
      : { key: 'earlier-this-month', label: `Earlier in ${monthName}` };
  }
  const label = date.getFullYear() === now.getFullYear() ? monthName : `${monthName} ${date.getFullYear()}`;
  return { key: `month-${date.getFullYear()}-${date.getMonth()}`, label };
}

/**
 * Groups jobs by day, tapering to per-month for anything more than ~2 weeks
 * out — a job from 4 months ago gets one "April 2026" header, not its own
 * day. Preserves the caller's row order (bucket-of-first-appearance order),
 * so flipping the upstream sort direction flips group order too, with no
 * re-sorting here.
 */
export function groupJobsByDay(jobs: Job[], now: Date = new Date()): JobDayGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, JobDayGroup>();
  for (const job of jobs) {
    const { key, label } = bucketFor(new Date(job.scheduledAt), now);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label, jobs: [] };
      byKey.set(key, group);
      order.push(key);
    }
    group.jobs.push(job);
  }
  return order.map((k) => byKey.get(k)!);
}
