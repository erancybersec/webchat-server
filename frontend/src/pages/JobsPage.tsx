import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import CampaignPanel from '../components/CampaignPanel';
import { useConfirm } from '../components/Confirm';
import SequenceView from '../components/SequenceView';
import { useToast } from '../components/Toast';
import { agentBadgeClass, agentLabel, useAgents, useMe, usePerm } from '../lib/agents';
import { api } from '../lib/api';
import { clockLabel, isCampaign } from '../lib/campaign';
import { setComposeDraft } from '../lib/composeDraft';
import { jobOriginLabel } from '../lib/jobLabels';
import { useJobProgress } from '../lib/useJobProgress';
import { recipientLabel, recipientName, useRecipientNames } from '../lib/useRecipientNames';
import type { Agent, Job, JobItem, JobProgress, JobScope, JobSend, JobStatus, SendStatus } from '../types';

const PAGE_SIZE = 50;

const STATUS_STYLE: Record<JobStatus, string> = {
  pending_approval: 'bg-purple-100 text-purple-700',
  pending: 'bg-blue-100 text-blue-700',
  running: 'bg-amber-100 text-amber-700',
  paused: 'bg-indigo-100 text-indigo-700',
  done: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-100 text-gray-500',
  missed: 'bg-orange-100 text-orange-700',
};

/** Chip text — statuses read as labels ('pending_approval' would leak the enum). */
const STATUS_LABEL: Partial<Record<JobStatus, string>> = {
  pending_approval: 'awaiting approval',
};
const statusLabel = (s: JobStatus): string => STATUS_LABEL[s] ?? s;

const ALL_STATUSES = Object.keys(STATUS_STYLE) as JobStatus[];
const RESENDABLE: readonly JobStatus[] = ['done', 'failed', 'cancelled', 'missed'];
/** Statuses whose job is edited IN PLACE (rather than copied into a new one). */
const EDIT_IN_PLACE: readonly JobStatus[] = ['pending', 'paused'];

/** One item as "icon + snippet" for the always-visible preview strip. */
function itemSnippet(item: JobItem): string {
  const d = item.data as Record<string, any>;
  switch (item.type) {
    case 'text':
      return `💬 ${d.text ?? ''}`;
    case 'media': {
      const icon =
        d.mediatype === 'video' ? '🎞' : d.mediatype === 'audio' ? '🎵' : d.mediatype === 'image' ? '🖼' : '📄';
      return `${icon} ${d.caption || d.filename || d.url || 'media'}`;
    }
    case 'voice':
      return '🎤 voice';
    case 'poll':
      return `📊 ${d.question ?? 'poll'}`;
    case 'buttons':
      return `⬜ ${d.title ?? 'buttons'}`;
    default:
      return `(${item.type}) ${String(d.text ?? d.caption ?? '')}`;
  }
}

/** "in 2h" / "3d ago" next to the absolute timestamp. */
function relTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const [n, u] =
    abs >= 86_400_000
      ? [Math.round(abs / 86_400_000), 'd']
      : abs >= 3_600_000
        ? [Math.round(abs / 3_600_000), 'h']
        : [Math.max(1, Math.round(abs / 60_000)), 'm'];
  return diff > 0 ? `in ${n}${u}` : `${n}${u} ago`;
}

const SEND_STATUS_STYLE: Record<SendStatus, string> = {
  pending: 'bg-blue-100 text-blue-700',
  sent: 'bg-green-100 text-green-700',
  skipped: 'bg-amber-100 text-amber-700',
  failed: 'bg-red-100 text-red-700',
};

/** Above this many ledger rows the search box and scroll cap kick in. */
const LEDGER_CONTROLS_AT = 15;

/** WhatsApp-style ticks: ✓ sent, ✓✓ delivered, blue ✓✓ read. */
function DeliveryTicks({ s }: { s: JobSend }) {
  if (s.status !== 'sent') return null;
  const read = !!s.readAt;
  const delivered = read || !!s.deliveredAt;
  return (
    <span
      title={read ? 'Read' : delivered ? 'Delivered' : 'Sent'}
      className={`font-semibold ${read ? 'text-sky-500' : 'text-gray-400'}`}
    >
      {delivered ? '✓✓' : '✓'}
    </span>
  );
}

/** How many ledger rows arrive per request — a campaign's ledger is thousands. */
const LEDGER_PAGE = 100;

/**
 * Who has been sent to and who hasn't. Filtering, searching and paging all
 * happen server-side: at 1000+ recipients the whole ledger is too much to ship
 * to a browser, and the chip counts have to be the true totals, not the totals
 * of whatever page happens to be loaded.
 */
function SendsDetail({
  jobId,
  names,
  items,
  onCompose,
}: {
  jobId: string;
  names: Map<string, string>;
  items: JobItem[];
  onCompose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [statusF, setStatusF] = useState<SendStatus | 'all'>('all');
  // typing in a 1000-row ledger shouldn't fire a request per keystroke
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  // the campaign progress doubles as the ledger's totals (one shared query)
  const totals = useQuery({ queryKey: ['progress', jobId], queryFn: () => api.jobs.progress(jobId) });
  const pages = useInfiniteQuery({
    queryKey: ['sends', jobId, statusF, query],
    queryFn: ({ pageParam }) =>
      api.jobs.sendsPage(jobId, {
        status: statusF === 'all' ? undefined : statusF,
        q: query,
        limit: LEDGER_PAGE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.sends.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });

  // Keeping the not-sent as a saved list is the "send to them later" path — a
  // different day, a different message — where Retry re-sends this job's own
  // sequence now. Declared with the other hooks: the early returns below mean
  // anything hook-shaped has to come first (React error #310 otherwise).
  const saveUnsent = useMutation({
    mutationFn: (name?: string) => api.jobs.unsentList(jobId, name),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['lists'] });
      toast(`Saved ${r.members} recipients as “${r.list.name}” — pick it in Compose`);
    },
    onError: (e) => toast(String((e as Error).message), 'err'),
  });

  // The one-click path: whichever chip is selected becomes the Compose
  // audience, with this job's own sequence prefilled as a starting point.
  const composeTo = useMutation({
    mutationFn: (status: SendStatus) => api.jobs.recipientsByStatus(jobId, status),
    onSuccess: (r, status) => {
      if (!r.recipients.length) {
        toast(`No ${status} recipients`, 'err');
        return;
      }
      setComposeDraft({ recipients: r.recipients, items });
      onCompose();
    },
    onError: (e) => toast(String((e as Error).message), 'err'),
  });

  // The "create as a list" counterpart to composeTo — same chip, saved instead
  // of jumped into Compose right away.
  const saveStatus = useMutation({
    mutationFn: (args: { status: SendStatus; name?: string }) =>
      api.jobs.statusList(jobId, args.status, args.name),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['lists'] });
      toast(`Saved ${r.members} recipients as “${r.list.name}” — pick it in Compose`);
    },
    onError: (e) => toast(String((e as Error).message), 'err'),
  });

  const counts: Record<SendStatus, number> = {
    sent: totals.data?.sent ?? 0,
    skipped: totals.data?.skipped ?? 0,
    failed: totals.data?.failed ?? 0,
    pending: totals.data?.pending ?? 0,
  };
  // distinct contacts behind each status — a sequence's per-status message
  // count double-counts a recipient with several items in that status
  const contacts: Record<SendStatus, number> = totals.data?.contacts ?? {
    sent: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
  };
  const ledgerTotal = totals.data?.total ?? 0;
  const rows = pages.data?.pages.flatMap((p) => p.sends) ?? [];
  const matching = pages.data?.pages[0]?.total ?? 0;

  if (pages.isLoading || totals.isLoading)
    return <div className="px-3 py-2 text-xs text-gray-400">Loading ledger…</div>;
  if (!ledgerTotal)
    return (
      <div className="px-3 py-2 text-xs text-gray-400">
        No sends yet — the per-recipient ledger appears once the job runs.
      </div>
    );
  const filtered = !!query || statusF !== 'all';
  // Distinct contacts, not message rows — this is exactly what unsentList
  // saves (server-dedupes the failed+pending union), so the label matches
  // the list it actually produces.
  const notSent = totals.data?.notSentContacts ?? 0;

  function askAndSave() {
    const suggested = `Not sent — ${new Date().toLocaleDateString()} (${notSent})`;
    const name = window.prompt('Save the ones that were not sent as a list, named:', suggested);
    if (name !== null) saveUnsent.mutate(name.trim() || undefined);
  }

  function askAndSaveStatus(status: SendStatus, suggestion?: string) {
    const n = contacts[status];
    const label = status[0].toUpperCase() + status.slice(1);
    const suggested = suggestion ?? `${label} — ${new Date().toLocaleDateString()} (${n})`;
    const name = window.prompt(`Save the ${status} recipients as a list, named:`, suggested);
    if (name !== null) saveStatus.mutate({ status, name: name.trim() || undefined });
  }

  // The scheduler holds a campaign at the daily first-contact ration rather
  // than failing it — from the ledger alone that reads as "978 pending" with
  // no clue why, so surface the job's own holdReason here instead of making
  // the operator go find it in the collapsed row above.
  const holdReason = totals.data?.holdReason ?? null;
  const coldCapped = !!holdReason && /cold-contact cap/i.test(holdReason);
  const nextRunAt = totals.data?.nextRunAt;

  return (
    <div>
      {coldCapped && contacts.pending > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          <span>
            🧊 {contacts.pending.toLocaleString()} contact{contacts.pending === 1 ? '' : 's'} pending — they're
            new numbers and today's first-contact limit was reached.
            {nextRunAt ? ` Resumes automatically ${clockLabel(nextRunAt)}.` : ''}
          </span>
          <button
            onClick={() =>
              askAndSaveStatus(
                'pending',
                `New contacts — cap reached — ${new Date().toLocaleDateString()} (${contacts.pending})`,
              )
            }
            disabled={saveStatus.isPending}
            title="Save these new, not-yet-reached contacts as their own list"
            className="ml-auto rounded px-2 py-0.5 text-xs font-medium text-amber-700 underline hover:bg-amber-100 disabled:opacity-50"
          >
            ⭳ Save as a pending list
          </button>
        </div>
      )}
      {/* who got it / who didn't, at a glance — chips filter, search digs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-100 px-3 py-1.5">
        {(Object.keys(SEND_STATUS_STYLE) as SendStatus[])
          .filter((st) => counts[st])
          .map((st) => {
            // a sequence sends several messages per contact — the chip counts
            // messages, so spell out the distinct-contact number wherever it differs
            const differs = contacts[st] !== counts[st];
            return (
              <>
                <button
                  key={st}
                  onClick={() => setStatusF(statusF === st ? 'all' : st)}
                  title={differs ? `${counts[st]} messages, to ${contacts[st]} contacts` : undefined}
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEND_STATUS_STYLE[st]} ${
                    statusF === st ? 'ring-2 ring-wa' : 'opacity-80 hover:opacity-100'
                  }`}
                >
                  {st} ({counts[st]}
                  {differs ? ` → ${contacts[st]} contacts` : ''})
                </button>
                {/* right beside the plain "pending" chip — the same rows, but
                    named for what's actually holding them back so the count
                    doesn't read as an unexplained backlog */}
                {st === 'pending' && coldCapped && (
                  <button
                    key="pending-coldcap"
                    onClick={() => setStatusF(statusF === 'pending' ? 'all' : 'pending')}
                    title="These are new numbers, held back by today's first-contact limit"
                    className={`rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 ${
                      statusF === 'pending' ? 'ring-2 ring-wa' : 'opacity-80 hover:opacity-100'
                    }`}
                  >
                    🧊 cap-held ({contacts.pending})
                  </button>
                )}
              </>
            );
          })}
        {ledgerTotal > LEDGER_CONTROLS_AT && (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a number…"
            dir="auto"
            inputMode="tel"
            className="ml-auto rounded-md border border-gray-300 px-2 py-0.5 text-xs"
          />
        )}
        {filtered && (
          <span className="text-xs text-gray-400">
            {matching} of {ledgerTotal}
          </span>
        )}
        <div className={`flex items-center gap-1 ${ledgerTotal > LEDGER_CONTROLS_AT && !filtered ? '' : 'ml-auto'}`}>
          {/* the export follows the chips + search: "failed only" downloads the
              failed only, which is the list someone actually wants to work from */}
          <a
            href={api.jobs.ledgerCsvUrl(jobId, {
              status: statusF === 'all' ? undefined : statusF,
              q: query,
            })}
            download
            title={filtered ? 'Download the rows shown' : 'Download the whole ledger'}
            className="rounded px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50"
          >
            ⬇ CSV{filtered ? ' (filtered)' : ''}
          </a>
          {notSent > 0 && (
            <button
              onClick={askAndSave}
              disabled={saveUnsent.isPending}
              title="Save the failed + not-yet-sent recipients as a list you can send to whenever"
              className="rounded px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
            >
              ⭳ Save {notSent} not-sent as list
            </button>
          )}
          {/* one chip selected → one click straight into Compose with just that
              audience, this job's sequence prefilled as a starting point. The
              count is CONTACTS (what Compose will actually get), not the
              chip's message-row count — a multi-item sequence has several
              ledger rows per recipient. */}
          {statusF !== 'all' && counts[statusF] > 0 && (
            <button
              onClick={() => composeTo.mutate(statusF)}
              disabled={composeTo.isPending}
              title={`Open Compose with just the ${statusF} recipients`}
              className="rounded px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
            >
              → Compose to {statusF} ({contacts[statusF]})
            </button>
          )}
          {/* same chip, saved instead of sent right away — a list to reuse later */}
          {statusF !== 'all' && counts[statusF] > 0 && (
            <button
              onClick={() => askAndSaveStatus(statusF)}
              disabled={saveStatus.isPending}
              title={`Save the ${statusF} recipients as a list you can send to whenever`}
              className="rounded px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
            >
              ⭳ Create as a list ({contacts[statusF]})
            </button>
          )}
        </div>
      </div>
      <div className={ledgerTotal > LEDGER_CONTROLS_AT ? 'max-h-64 overflow-y-auto' : ''}>
        <table className="w-full text-xs">
          <thead className="text-left text-gray-400">
            <tr>
              <th className="px-3 py-1">Recipient</th>
              <th className="px-3 py-1">Item</th>
              <th className="px-3 py-1">Status</th>
              <th className="px-3 py-1" title="✓ sent · ✓✓ delivered · blue ✓✓ read">
                Delivery
              </th>
              <th className="px-3 py-1">Sent</th>
              <th className="px-3 py-1">Attempts</th>
              <th className="px-3 py-1">Error</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={`${s.recipient}-${s.itemIndex}`} className="border-t border-gray-100">
                <td className="px-3 py-1" dir="auto">
                  {recipientName(s.recipient, names) && (
                    <span className="mr-1.5 font-medium text-gray-700">
                      {recipientName(s.recipient, names)}
                    </span>
                  )}
                  <span className="font-mono text-gray-500">{s.recipient}</span>
                </td>
                <td className="px-3 py-1">{s.itemIndex + 1}</td>
                <td className="px-3 py-1">{s.status}</td>
                <td className="px-3 py-1">
                  <DeliveryTicks s={s} />
                </td>
                <td className="px-3 py-1 text-gray-500">
                  {s.sentAt ? clockLabel(s.sentAt) : ''}
                </td>
                <td className="px-3 py-1">{s.attempts}</td>
                <td className="px-3 py-1 text-red-500">{s.lastError ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <div className="px-3 py-2 text-xs text-gray-400">Nothing matches that filter.</div>
        )}
        {pages.hasNextPage && (
          <button
            onClick={() => void pages.fetchNextPage()}
            disabled={pages.isFetchingNextPage}
            className="w-full border-t border-gray-100 py-1.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50"
          >
            {pages.isFetchingNextPage ? 'Loading…' : `Load more (${rows.length} of ${matching})`}
          </button>
        )}
      </div>
    </div>
  );
}

function JobRow({
  job,
  scope,
  names,
  agents,
  onCompose,
  progress,
  flash = false,
}: {
  job: Job;
  scope: JobScope;
  names: Map<string, string>;
  agents: Map<string, Agent>;
  onCompose: () => void;
  progress?: JobProgress;
  /** briefly ring-highlight this row after a notification deep-link */
  flash?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirmDlg = useConfirm();
  const [open, setOpen] = useState(false);
  const canApprove = usePerm('jobs.approve');
  const me = useMe();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['jobs'] });
  const cancel = useMutation({ mutationFn: () => api.jobs.cancel(job.id), onSuccess: invalidate });
  // Pause / Continue are ordinary row actions, not campaign-only ones: holding
  // a send and picking it back up is the control people reach for most.
  const refreshJob = () => {
    invalidate();
    void qc.invalidateQueries({ queryKey: ['progress', job.id] });
    void qc.invalidateQueries({ queryKey: ['sends', job.id] });
  };
  const pause = useMutation({
    mutationFn: () => api.jobs.pause(job.id),
    onSuccess: () => {
      refreshJob();
      toast(
        job.startedAt
          ? 'Paused — nothing more goes out until you continue it'
          : 'Paused — it will not fire at its scheduled time until you continue it',
      );
    },
    onError: (e) => toast(String((e as Error).message), 'err'),
  });
  // Continue picks up the not-yet-sent; the ones that FAILED are a separate
  // decision (a wrong number will just fail again), so they get their own action.
  const retryFailed = useMutation({
    mutationFn: () => api.jobs.retryFailed(job.id),
    onSuccess: (r) => {
      refreshJob();
      toast(`Retrying ${r.retried} failed ${r.retried === 1 ? 'recipient' : 'recipients'} — nobody else is messaged again`);
    },
    onError: (e) => toast(String((e as Error).message), 'err'),
  });
  const resume = useMutation({
    mutationFn: () => api.jobs.resume(job.id),
    onSuccess: () => {
      refreshJob();
      toast(job.startedAt ? 'Continuing where it stopped' : 'Back in the queue');
    },
    onError: (e) => toast(String((e as Error).message), 'err'),
  });
  const restore = useMutation({ mutationFn: () => api.jobs.restore(job.id), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: () => api.jobs.remove(job.id), onSuccess: invalidate });
  const rerun = useMutation({
    mutationFn: () => api.jobs.rerun(job.id),
    onSuccess: () => {
      invalidate();
      toast('Resending now — watch it at the top of History');
    },
    onError: (e) => toast(String((e as Error).message)),
  });
  const approve = useMutation({
    mutationFn: () => api.jobs.approve(job.id),
    onSuccess: () => {
      invalidate();
      toast('Approved — the job is queued');
    },
    onError: (e) => toast(String((e as Error).message), 'err'),
  });
  const reject = useMutation({
    mutationFn: (reason: string) => api.jobs.reject(job.id, reason),
    onSuccess: invalidate,
    onError: (e) => toast(String((e as Error).message), 'err'),
  });

  async function confirmApprove() {
    const ok = await confirmDlg({
      title: 'Approve this job?',
      body: `Releases ${job.items.length} item${job.items.length === 1 ? '' : 's'} to ${job.recipients.length} recipient${job.recipients.length === 1 ? '' : 's'}${job.sentBy ? `, submitted by ${job.sentBy}` : ''}.`,
      confirmLabel: 'Approve',
    });
    if (ok) approve.mutate();
  }

  function confirmReject() {
    // window.prompt keeps the optional reason a one-liner — a rejected job is
    // rare enough that a dedicated modal isn't worth its weight
    const reason = window.prompt('Reject this job — reason (optional):');
    if (reason !== null) reject.mutate(reason);
  }

  async function confirmDelete() {
    const ok = await confirmDlg({
      title: 'Delete this job?',
      body:
        job.status === 'pending'
          ? 'The job is still pending — deleting removes it without sending.'
          : 'The job and its send ledger are removed permanently.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) remove.mutate();
  }

  async function confirmResend() {
    const ok = await confirmDlg({
      title: 'Resend this sequence?',
      body: `Sends ${job.items.length} item${job.items.length === 1 ? '' : 's'} to ${job.recipients.length} recipient${job.recipients.length === 1 ? '' : 's'} again, right now.`,
      confirmLabel: 'Resend',
    });
    if (ok) rerun.mutate();
  }

  // How many failed, for the Retry action. Best source first: the ledger the
  // campaign panel already fetched (same query key, so this adds no request and
  // costs nothing on rows that have no panel), then a live event, then the
  // server's own result line — which is what rows from earlier sessions have.
  const ledger = useQuery({
    queryKey: ['progress', job.id],
    queryFn: () => api.jobs.progress(job.id),
    enabled: isCampaign(job) && !!job.startedAt,
    staleTime: 5_000,
  });
  const failedCount =
    ledger.data?.failed ??
    progress?.failed ??
    Number(/(\d+) failed/.exec(job.result ?? '')?.[1] ?? 0);

  // Prefill the Compose tab with this job's content. A still-pending job is
  // edited in place (id + time travel along); anything finished is a template
  // for a brand-new send.
  function editInCompose() {
    setComposeDraft({
      recipients: job.recipients,
      items: job.items,
      repeat: job.repeat,
      batch: job.batch,
      // pending and paused jobs are edited in place — a paused campaign keeps
      // its ledger, so the change lands on whoever hasn't been sent to yet
      ...(EDIT_IN_PLACE.includes(job.status)
        ? { jobId: job.id, scheduledAt: job.scheduledAt, partlySent: !!job.startedAt }
        : {}),
    });
    onCompose();
  }

  return (
    <div
      id={`job-${job.id}`}
      className={`rounded-lg border bg-white shadow-sm transition-shadow ${
        flash ? 'border-wa ring-2 ring-amber-400' : 'border-gray-200'
      }`}
    >
      {/* whole header + preview toggles the full detail — bigger target than a
          "Detail" button; action buttons stop the click from bubbling */}
      <div onClick={() => setOpen(!open)} className="cursor-pointer">
        <div className="flex flex-wrap items-center gap-3 px-3 pt-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[job.status]}`}>
            {statusLabel(job.status)}
          </span>
          {scope === 'history' && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
              {jobOriginLabel(job)}
            </span>
          )}
          {/* who sent it (agent identification) — jobs from before tracking carry no chip */}
          {job.sentBy && (
            <span
              title={job.sentBy}
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${agentBadgeClass(
                agents.get(job.sentBy)?.color ?? '',
              )}`}
            >
              by {agentLabel(agents.get(job.sentBy) ?? { email: job.sentBy })}
            </span>
          )}
          {job.repeat && (
            <span
              title={job.repeat.until ? `repeats ${job.repeat.freq} until ${new Date(job.repeat.until).toLocaleDateString()}` : `repeats ${job.repeat.freq}`}
              className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700"
            >
              🔁 {job.repeat.freq}
            </span>
          )}
          {/* which WhatsApp channel it sends through — only flagged when pinned */}
          {job.instance && (
            <span
              title={`sends through the "${job.instance}" channel`}
              className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700"
            >
              ☎ {job.instance}
            </span>
          )}
          <span className="text-sm font-medium">{new Date(job.scheduledAt).toLocaleString()}</span>
          <span className="text-xs text-gray-400">{relTime(job.scheduledAt)}</span>
          <span className="text-xs text-gray-500" dir="auto">
            to{' '}
            {job.recipients.slice(0, 2).map((r, i) => (
              <span key={r.id}>
                {i > 0 && ', '}
                {r.isGroup ? '👥 ' : ''}
                {recipientLabel(r.id, names)}
                {/* number stays visible next to a resolved name */}
                {!r.isGroup && recipientName(r.id, names) && (
                  <span className="font-mono text-[10px] text-gray-400">
                    {' '}
                    {r.id.split('@')[0]}
                  </span>
                )}
              </span>
            ))}
            {job.recipients.length > 2 && ` +${job.recipients.length - 2}`} ·{' '}
            {job.items.length} item{job.items.length === 1 ? '' : 's'}
          </span>
          <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {job.status === 'pending_approval' && canApprove && (
            <>
              <button
                onClick={() => void confirmApprove()}
                disabled={approve.isPending}
                className="rounded bg-wa px-2 py-1 text-xs font-medium text-white hover:bg-wa-dark disabled:opacity-50"
              >
                Approve
              </button>
              <button
                onClick={confirmReject}
                disabled={reject.isPending}
                className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Reject
              </button>
            </>
          )}
          {(job.status === 'running' || job.status === 'pending') && (
            <button
              onClick={() => pause.mutate()}
              disabled={pause.isPending}
              title={
                job.status === 'running'
                  ? 'Stop after the message being sent right now — the rest waits for you'
                  : 'Hold it: it will not fire at its scheduled time until you continue it'
              }
              className="rounded px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
            >
              ⏸ Pause
            </button>
          )}
          {(job.status === 'paused' ||
            (job.status === 'cancelled' && !!job.startedAt) ||
            (job.status === 'pending' &&
              !!job.startedAt &&
              new Date(job.scheduledAt).getTime() > Date.now())) && (
            <button
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
              title="Pick up exactly where the ledger left off — nobody is messaged twice"
              className="rounded bg-wa px-2 py-1 text-xs font-medium text-white hover:bg-wa-dark disabled:opacity-50"
            >
              ▶ Continue{job.status === 'pending' ? ' now' : ''}
            </button>
          )}
          {/* offered whenever the job reports failures and nothing is in flight.
              The count comes from the row's own result line (or the live event),
              so the list costs no extra request per row; the server re-checks
              the ledger and 409s if there is nothing left to retry. */}
          {!!failedCount && job.status !== 'running' && job.status !== 'pending_approval' && (
            <button
              onClick={() => retryFailed.mutate()}
              disabled={retryFailed.isPending}
              title="Send only to the recipients whose message failed — the rest are untouched"
              className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              ↻ Retry {failedCount} failed
            </button>
          )}
          {(RESENDABLE.includes(job.status) || EDIT_IN_PLACE.includes(job.status)) && (
            <button
              onClick={editInCompose}
              title={
                job.startedAt && EDIT_IN_PLACE.includes(job.status)
                  ? 'Edit the message — it applies to everyone still to be sent to'
                  : undefined
              }
              className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
            >
              {/* a job that has already sent is always edited "for the rest" */}
              {EDIT_IN_PLACE.includes(job.status)
                ? job.startedAt
                  ? 'Edit remaining'
                  : 'Edit'
                : 'Edit & resend'}
            </button>
          )}
          {RESENDABLE.includes(job.status) && (
            <button
              onClick={() => void confirmResend()}
              disabled={rerun.isPending}
              className="rounded px-2 py-1 text-xs text-wa-dark hover:bg-green-50 disabled:opacity-50"
            >
              Resend
            </button>
          )}
          {(job.status === 'pending' || job.status === 'running' || job.status === 'paused' ||
            (job.status === 'pending_approval' && (canApprove || !job.sentBy || job.sentBy === me.data?.email))) && (
            <button
              onClick={() => cancel.mutate()}
              title={job.startedAt ? 'Stop for good — what is already sent stays sent' : undefined}
              className="rounded px-2 py-1 text-xs text-amber-600 hover:bg-amber-50"
            >
              {job.status === 'pending_approval' ? 'Withdraw' : job.startedAt ? 'Stop' : 'Cancel'}
            </button>
          )}
          {job.status === 'cancelled' && new Date(job.scheduledAt).getTime() > Date.now() && (
            <button
              onClick={() => restore.mutate()}
              className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
            >
              Restore
            </button>
          )}
          <button
            onClick={() => void confirmDelete()}
            className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
          >
            Delete
          </button>
          <div className="mx-1 h-5 w-px shrink-0 self-stretch bg-gray-200" />
          <button
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={open ? 'Hide detail' : 'Show detail'}
            title={open ? 'Hide detail' : 'Show detail'}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-gray-300 bg-gray-100 text-gray-500 hover:border-wa hover:text-wa-dark"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          </div>
        </div>
        {/* the messages themselves, always visible — every item as icon +
            snippet, clamped to two lines so long blasts don't flood the list */}
        <div className="line-clamp-2 px-3 pt-1 pb-2 text-xs leading-5 text-gray-600" dir="auto">
          {job.items.map((it) => itemSnippet(it).slice(0, 160)).join('  ·  ')}
        </div>
        {/* A big send gets the campaign panel: ledger-accurate progress plus
            Pause / Continue. Anything smaller keeps the plain live bar. */}
        {isCampaign(job) ? (
          <div onClick={(e) => e.stopPropagation()}>
            <CampaignPanel job={job} live={progress} />
          </div>
        ) : (
          job.status === 'running' &&
          progress &&
          !progress.done &&
          progress.total > 0 && (
            <div className="px-3 pb-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full bg-wa transition-all"
                  style={{
                    width: `${Math.round(((progress.sent + progress.skipped + progress.failed) / progress.total) * 100)}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-[11px] text-gray-500">
                {progress.sent + progress.skipped + progress.failed} of {progress.total} processed
                {progress.failed > 0 && <span className="text-red-500"> · {progress.failed} failed</span>}
              </p>
            </div>
          )
        )}
        {job.result && <div className="px-3 pb-2 text-xs text-gray-500">{job.result}</div>}
      </div>
      {open && (
        <div className="space-y-3 border-t border-gray-100 bg-gray-50 p-3">
          <SequenceView items={job.items} recipients={job.recipients} names={names} />
          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-500">
                Send ledger — who got it, who didn't
              </p>
            </div>
            <div className="rounded-md border border-gray-200 bg-white">
              <SendsDetail jobId={job.id} names={names} items={job.items} onCompose={onCompose} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const COPY: Record<JobScope, { title: string; clear: string; empty: string }> = {
  scheduled: {
    title: 'Scheduled jobs',
    clear: 'Clear cancelled',
    empty: 'Nothing scheduled — create a job from the Compose tab',
  },
  history: {
    title: 'History',
    clear: 'Clear history',
    empty: 'No sends yet — send something from the Compose tab',
  },
};

/** Scheduled queue and send History — same list, different server-side scope. */
export default function JobsPage({
  scope,
  onCompose,
  focusJob,
  onJobFocused,
}: {
  scope: JobScope;
  onCompose: () => void;
  /** notification deep-link: scroll to + flash this job once it's loaded */
  focusJob?: string | null;
  onJobFocused?: () => void;
}) {
  const qc = useQueryClient();
  const confirmDlg = useConfirm();
  const [filter, setFilter] = useState<JobStatus | 'all'>('all');
  const status = filter === 'all' ? undefined : filter;
  const names = useRecipientNames();
  const progress = useJobProgress();
  const agentsQ = useAgents();
  const agents = new Map((agentsQ.data ?? []).map((a) => [a.email, a]));

  // Server-side pages: with hundreds of jobs only PAGE_SIZE rows travel per
  // request; "Load more" appends the next slice.
  const pages = useInfiniteQuery({
    queryKey: ['jobs', scope, filter],
    queryFn: ({ pageParam }) =>
      api.jobs.page(scope, { status, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.jobs.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    refetchInterval: 15_000,
  });
  const clearDone = useMutation({
    mutationFn: () => api.jobs.clearDone(scope),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });

  async function confirmClear() {
    const ok = await confirmDlg({
      title: scope === 'history' ? 'Clear all history?' : 'Clear cancelled jobs?',
      body:
        scope === 'history'
          ? 'Every finished send and its ledger is removed permanently. Pending and running sends are kept.'
          : 'Cancelled jobs are removed permanently. Pending and running jobs are kept.',
      confirmLabel: 'Clear',
      danger: true,
    });
    if (ok) clearDone.mutate();
  }

  const jobs = pages.data?.pages.flatMap((p) => p.jobs) ?? [];
  const counts = pages.data?.pages[0]?.counts ?? {};
  const total = pages.data?.pages[0]?.total ?? 0;
  const totalAll = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  const copy = COPY[scope];
  // Bulk-clearing wipes finished jobs + ledger irreversibly — admins only by
  // default. Hide the button (the server enforces with 403 regardless) until a
  // denial is KNOWN, so it doesn't flicker out while /api/me loads.
  const canClear = usePerm('jobs.clearHistory');

  // Notification deep-link: when a finished-job push is clicked, scroll to that
  // job and flash it once it's in the loaded pages (it's the most recent, so
  // it's on the first page). Flash auto-clears on its own timer so clearing the
  // App-level target doesn't cancel the highlight mid-show.
  const [flashJob, setFlashJob] = useState<string | null>(null);
  useEffect(() => {
    if (!focusJob || !jobs.some((j) => j.id === focusJob)) return;
    const el = document.getElementById(`job-${focusJob}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashJob(focusJob);
    onJobFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusJob, jobs]);
  useEffect(() => {
    if (!flashJob) return;
    const t = window.setTimeout(() => setFlashJob(null), 1600);
    return () => window.clearTimeout(t);
  }, [flashJob]);

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-600">
          {copy.title} {pages.data ? `(${totalAll})` : ''}
        </h2>
        {canClear !== false && (
          <button
            onClick={() => void confirmClear()}
            className="rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
          >
            {copy.clear}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => setFilter('all')}
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            filter === 'all' ? 'bg-wa text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
          }`}
        >
          All ({totalAll})
        </button>
        {ALL_STATUSES.filter((s) => (counts[s] ?? 0) > 0).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(filter === s ? 'all' : s)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              filter === s ? 'ring-2 ring-wa ' + STATUS_STYLE[s] : STATUS_STYLE[s] + ' opacity-80 hover:opacity-100'
            }`}
          >
            {statusLabel(s)} ({counts[s]})
          </button>
        ))}
      </div>
      {pages.isLoading && <div className="py-8 text-center text-sm text-gray-400">Loading…</div>}
      {pages.isError && (
        <div role="alert" className="py-8 text-center text-sm text-red-500">
          {String(pages.error)}
        </div>
      )}
      {!pages.isLoading && jobs.length === 0 && (
        <div className="py-8 text-center text-sm text-gray-400">
          {totalAll === 0 ? copy.empty : `No ${filter} jobs.`}
        </div>
      )}
      {jobs.map((j) => (
        <JobRow
          key={j.id}
          job={j}
          scope={scope}
          names={names}
          agents={agents}
          onCompose={onCompose}
          progress={progress[j.id]}
          flash={flashJob === j.id}
        />
      ))}
      {pages.hasNextPage && (
        <button
          onClick={() => void pages.fetchNextPage()}
          disabled={pages.isFetchingNextPage}
          className="w-full rounded-lg border border-gray-300 py-2 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50"
        >
          {pages.isFetchingNextPage ? 'Loading…' : `Load more (${jobs.length} of ${total})`}
        </button>
      )}
    </div>
  );
}
