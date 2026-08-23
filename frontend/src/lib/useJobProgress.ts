import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { JobProgress } from '../types';
import { useBusEvent } from './eventBus';

/**
 * Live per-job progress from the scheduler's JOB_PROGRESS events (shared SSE
 * bus). On a job's final event the jobs/ledger queries refresh, so lists
 * update without waiting out the poll interval.
 *
 * A batch boundary counts as such a moment too: the scheduler stamps `status`
 * on the event when a campaign leaves 'running' (paused, or queued for the next
 * batch), and that is exactly when the row's chip and its Pause/Continue
 * buttons change — waiting out the 15s list poll for those reads as a hang.
 */
export function useJobProgress(): Record<string, JobProgress> {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<Record<string, JobProgress>>({});

  useBusEvent('JOB_PROGRESS', (data) => {
    const p = data as JobProgress | null;
    if (!p?.jobId) return;
    setProgress((prev) => ({ ...prev, [p.jobId]: p }));
    if (p.done || p.status) {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['sends', p.jobId] });
      void qc.invalidateQueries({ queryKey: ['progress', p.jobId] });
    }
  });

  return progress;
}
