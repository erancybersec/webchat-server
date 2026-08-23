import type { SequenceProgress } from '../lib/useJobSend';

export default function SendProgress({ progress }: { progress: SequenceProgress }) {
  const done = progress.sent + progress.skipped + progress.failed;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 text-sm shadow-sm">
      <div className="mb-2 h-2 overflow-hidden rounded bg-gray-100">
        <div
          className="h-full bg-wa transition-all"
          style={{ width: `${progress.total ? (done / progress.total) * 100 : 0}%` }}
        />
      </div>
      <span className="font-medium">
        {progress.sent}/{progress.total} sent
      </span>
      {progress.skipped > 0 && (
        <span className="ml-2 text-amber-600">{progress.skipped} skipped (blacklisted)</span>
      )}
      {progress.failed > 0 && <span className="ml-2 text-red-600">{progress.failed} failed</span>}
      {progress.running && <span className="ml-2 text-gray-400">sending…</span>}
      {/* a batched campaign hands over to the Scheduled/History card here. The
          reason comes from the scheduler verbatim — "the cap", "the line is
          disconnected" and "a full batch" are three very different things to
          be told, and only the first two need the operator to do anything. */}
      {progress.paused && (
        <div className="mt-1 text-xs text-indigo-700">
          {progress.holdReason ? `Stopped — ${progress.holdReason}. ` : 'Batch done — '}
          {progress.pending?.toLocaleString() ?? ''} still to send.{' '}
          {progress.nextRunAt
            ? `Continues on its own at ${new Date(progress.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
            : 'Continue it from the History tab whenever you are ready.'}
        </div>
      )}
      {progress.errors.map((e) => (
        <div key={e} className="mt-1 text-xs text-red-500">
          {e}
        </div>
      ))}
    </div>
  );
}
