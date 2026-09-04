import { useQueries, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useBusEvent } from './eventBus';
import { phoneKey } from './phone';
import type { Job, JobProgress } from '../types';

/**
 * Which of a multi-recipient campaign's own recipients are STILL pending,
 * keyed by job id. Job-level status (pending/paused) only says the campaign
 * as a whole isn't finished — a mid-run campaign can already have reached
 * some of its recipients while others wait, so "the job is ongoing" is not
 * "this particular recipient is still owed a message". Single-recipient jobs
 * are skipped: being job-level ongoing already implies not yet sent (the job
 * would be 'done' otherwise), so this only spends a request on jobs that
 * actually need the ledger to answer the question. The value maps each still-
 * pending recipient to the item index they're next owed — a multi-item
 * sequence (e.g. text then voice note) can have already sent this recipient
 * item 0 while item 1 is what's actually still queued for them.
 */
export function usePendingRecipientKeys(jobs: Job[]): Map<string, Map<string, number>> {
  const qc = useQueryClient();
  const multi = jobs.filter((j) => j.recipients.length > 1);
  const results = useQueries({
    queries: multi.map((j) => ({
      queryKey: ['job-pending-recipients', j.id],
      queryFn: () => api.jobs.recipientsByStatus(j.id, 'pending'),
      staleTime: 15_000,
    })),
  });
  // Every send — not just a batch boundary — moves one recipient off the
  // pending ledger, and that's exactly what decides whether this chat still
  // shows the "Scheduled" bubble for them. Without this, a campaign left open
  // in a chat keeps showing a just-sent recipient as pending until something
  // else happens to refetch (tab refocus, staleTime lapsing).
  useBusEvent('JOB_PROGRESS', (data) => {
    const p = data as JobProgress | null;
    if (p?.jobId) void qc.invalidateQueries({ queryKey: ['job-pending-recipients', p.jobId] });
  });
  const map = new Map<string, Map<string, number>>();
  multi.forEach((j, i) => {
    const recipients = results[i]?.data?.recipients ?? [];
    map.set(j.id, new Map(recipients.map((r) => [phoneKey(r.id), r.itemIndex ?? 0])));
  });
  return map;
}
