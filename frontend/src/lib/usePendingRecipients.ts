import { useQueries } from '@tanstack/react-query';
import { api } from './api';
import { phoneKey } from './phone';
import type { Job } from '../types';

/**
 * Which of a multi-recipient campaign's own recipients are STILL pending,
 * keyed by job id. Job-level status (pending/paused) only says the campaign
 * as a whole isn't finished — a mid-run campaign can already have reached
 * some of its recipients while others wait, so "the job is ongoing" is not
 * "this particular recipient is still owed a message". Single-recipient jobs
 * are skipped: being job-level ongoing already implies not yet sent (the job
 * would be 'done' otherwise), so this only spends a request on jobs that
 * actually need the ledger to answer the question.
 */
export function usePendingRecipientKeys(jobs: Job[]): Map<string, Set<string>> {
  const multi = jobs.filter((j) => j.recipients.length > 1);
  const results = useQueries({
    queries: multi.map((j) => ({
      queryKey: ['job-pending-recipients', j.id],
      queryFn: () => api.jobs.recipientsByStatus(j.id, 'pending'),
      staleTime: 15_000,
    })),
  });
  const map = new Map<string, Set<string>>();
  multi.forEach((j, i) => {
    const recipients = results[i]?.data?.recipients ?? [];
    map.set(j.id, new Set(recipients.map((r) => phoneKey(r.id))));
  });
  return map;
}
