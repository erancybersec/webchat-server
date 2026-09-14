import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { batchProgress, clockLabel, holdInfo, paceSummary, progressLine } from '../lib/campaign';
import type { CampaignProgress, Job, JobProgress } from '../types';

/** Statuses where the ledger is still moving (or about to) — poll while so. */
const ACTIVE: readonly Job['status'][] = ['running', 'pending', 'paused'];

/** The four ledger outcomes as one bar, in the order a campaign fills them. */
function SegmentedBar({ p }: { p: CampaignProgress }) {
  const pct = (n: number) => (p.total ? (n / p.total) * 100 : 0);
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-gray-100" role="presentation">
      <div className="bg-wa transition-all" style={{ width: `${pct(p.sent)}%` }} title={`${p.sent} sent`} />
      <div
        className="bg-amber-400 transition-all"
        style={{ width: `${pct(p.skipped)}%` }}
        title={`${p.skipped} skipped (blacklisted)`}
      />
      <div
        className="bg-red-400 transition-all"
        style={{ width: `${pct(p.failed)}%` }}
        title={`${p.failed} failed`}
      />
    </div>
  );
}

/**
 * The live picture of a big send: how far along it is, and — only while it
 * actually matters — why it isn't moving right now and when that changes.
 * The numbers come from the server's LEDGER (`/progress`), so they are right
 * after a refresh, a restart, or a pause of days — the SSE event only makes
 * them arrive sooner. Pause / Continue / Stop live in the row's action
 * button above, so they work the same for every job, campaign or not.
 *
 * Deliberately NOT shown here: the sending-window rule as anything louder
 * than a subdued footer line — that's implementation detail, not campaign
 * progress. The within-batch counter is the one exception, and only while a
 * batch is actually mid-flight: "18 of 30 this batch" answers "is it still
 * going?" the instant a batch starts running long, which the overall bar
 * alone can't (it barely moves for one more send out of hundreds).
 */
export default function CampaignPanel({
  job,
  live,
}: {
  job: Job;
  /** Latest JOB_PROGRESS for this job, when one has arrived this session. */
  live?: JobProgress;
}) {
  const active = ACTIVE.includes(job.status);
  const progress = useQuery({
    queryKey: ['progress', job.id],
    queryFn: () => api.jobs.progress(job.id),
    // a running campaign moves between polls; a finished one never does
    refetchInterval: job.status === 'running' ? 3_000 : active ? 15_000 : false,
  });

  const p = progress.data;
  // Hooks run every render regardless of whether `p` has arrived yet, so
  // `shown` is computed unconditionally (undefined until the ledger loads)
  // rather than after an early return.
  const shown: CampaignProgress | undefined =
    p &&
    (live && !live.done && live.total === p.total && live.sent + live.skipped + live.failed > p.sent + p.skipped + p.failed
      ? {
          ...p,
          sent: live.sent,
          skipped: live.skipped,
          failed: live.failed,
          pending: live.pending ?? p.pending,
          batchSent: live.batchSent ?? p.batchSent,
        }
      : p);

  // A routine hold's countdown ticks off this clock — recomputing `hold`
  // every second while (and only while) one is actually on screen. Nothing
  // else in this component reads `now`; a paused/attention/no-hold card
  // never starts the interval at all.
  const [now, setNow] = useState(() => new Date());
  const hold = shown ? holdInfo(shown, now) : null;
  useEffect(() => {
    if (!(job.status === 'pending' && hold?.kind === 'routine')) return;
    const id = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.status, hold?.kind]);

  if (!shown || shown.total === 0) return null;

  const pace = paceSummary(shown.batch);
  const bp = batchProgress(shown);
  // The within-batch counter earns its place only while a batch is actually
  // in flight — the moment it hits a boundary this gives way to the hold
  // block above, so the two never compete for the same line.
  const showBatchLive = job.status === 'running' && !!shown.batch?.size && shown.batchSent != null;
  // "Last sent" only earns its place once there's a hold to explain — while
  // actually running it's obvious, and it never competes with the hold text.
  const showLastSent = shown.lastSentAt && shown.pending > 0 && job.status !== 'running';

  return (
    <div className="space-y-1.5 px-3 pb-2">
      <SegmentedBar p={shown} />
      <p className="text-[11px] text-gray-500">{progressLine(shown)}</p>
      {showBatchLive && (
        <div className="rounded-md border border-wa/20 bg-green-50/60 px-2.5 py-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-wa-dark">
              {bp ? `Batch ${bp.current} of ${bp.total}` : 'This batch'}
            </span>
            <span className="text-[11px] tabular-nums text-gray-500">
              {shown.batchSent} of {shown.batch!.size} this batch
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-wa-dark transition-all"
              style={{ width: `${Math.min(100, (shown.batchSent! / shown.batch!.size!) * 100)}%` }}
            />
          </div>
        </div>
      )}
      {hold &&
        (hold.kind === 'attention' ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5">
            <p className="text-[12px] font-semibold text-amber-800">⚠ {hold.headline}</p>
            <p className="text-[11px] text-amber-700">{hold.detail}</p>
          </div>
        ) : (
          // routine: visible, but calm — a quiet rule, no card-in-card
          <div className="border-l-2 border-gray-200 pl-2.5">
            <p className="text-[12px] font-medium text-gray-600">{hold.headline}</p>
            <p className="text-[11px] tabular-nums text-gray-400">{hold.detail}</p>
          </div>
        ))}
      {job.status === 'paused' && (
        <p className="text-[11px] text-gray-400">
          {shown.sent.toLocaleString()} already received this — editing now only changes what the
          remaining {shown.pending.toLocaleString()}
          {shown.contacts.pending !== shown.pending
            ? ` (${shown.contacts.pending.toLocaleString()} contacts)`
            : ''}{' '}
          get.
        </p>
      )}
      {(pace || showLastSent) && (
        <p className="text-[10.5px] leading-relaxed text-gray-400/80">
          {pace}
          {pace && showLastSent ? <br /> : null}
          {showLastSent ? `Last sent ${clockLabel(shown.lastSentAt!)}` : null}
        </p>
      )}
    </div>
  );
}
