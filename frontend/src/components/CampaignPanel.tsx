import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { clockLabel, pauseLabel, progressLine, waitingLabel } from '../lib/campaign';
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
 * The live picture of a big send: how far along it is, how fast, and what it is
 * waiting for. The numbers come from the server's LEDGER (`/progress`), so they
 * are right after a refresh, a restart, or a pause of days — the SSE event only
 * makes them arrive sooner. Pause / Continue / Stop live in the row's button
 * group above, so they work the same for every job, campaign or not.
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
  if (!p) return null;
  // the SSE counters are fresher mid-run, but only they know about a send that
  // landed a second ago — everything structural still comes from the ledger
  const shown: CampaignProgress =
    live && !live.done && live.total === p.total && live.sent + live.skipped + live.failed > p.sent + p.skipped + p.failed
      ? { ...p, sent: live.sent, skipped: live.skipped, failed: live.failed, pending: live.pending ?? p.pending }
      : p;
  if (shown.total === 0) return null;

  const waiting = waitingLabel(shown);

  return (
    <div className="space-y-1.5 px-3 pb-2">
      <SegmentedBar p={shown} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-500">
        <span>{progressLine(shown)}</span>
        {shown.sent > 0 && (
          <span title="Distinct recipients who received at least one message — a sequence sends several per contact">
            → {shown.contacts.sent.toLocaleString()} contact{shown.contacts.sent === 1 ? '' : 's'}
          </span>
        )}
        {shown.failed > 0 && <span className="text-red-500">{shown.failed} failed</span>}
        {shown.skipped > 0 && (
          <span className="text-amber-600">
            {shown.skipped} skipped
            {shown.contacts.skipped !== shown.skipped ? ` (${shown.contacts.skipped} contacts)` : ''}
          </span>
        )}
        {waiting &&
          (waiting.kind === 'attention' ? (
            <span
              title="Not routine pacing — this needs a look"
              className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700"
            >
              ⚠ {waiting.text}
            </span>
          ) : (
            <span className="font-medium text-gray-700">{waiting.text}</span>
          ))}
        {/* the pacing, as two separate facts: the hours it may send in, and
            (if set) the batch size — either can be absent */}
        {shown.batch?.pauseAt && (
          <span
            title="the campaign stops itself when the clock reaches this hour"
            className="rounded-full bg-gray-100 px-1.5 py-0.5"
          >
            🕐 until {shown.batch.pauseAt}
            {shown.batch.resumeAt ? ` · back at ${shown.batch.resumeAt}` : ' · then waits'}
          </span>
        )}
        {!!shown.batch?.size && (
          <span className="rounded-full bg-gray-100 px-1.5 py-0.5">
            ⏱ {shown.batch.size} per batch
            {shown.batch.pauseMin > 0 ? ` · ${pauseLabel(shown.batch)} apart` : ' · manual'}
          </span>
        )}
      </div>
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
      {shown.lastSentAt && shown.pending > 0 && job.status !== 'running' && (
        <p className="text-[11px] text-gray-400">Last message went out {clockLabel(shown.lastSentAt)}.</p>
      )}
    </div>
  );
}
