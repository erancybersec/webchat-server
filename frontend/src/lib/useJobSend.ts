import { useState } from 'react';
import { api } from './api';
import type { BatchRule, JobItem, JobStatus, Recipient } from '../types';

export interface SequenceProgress {
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  errors: string[];
  running: boolean;
  /** The job landed in the approval queue instead of sending. */
  held?: boolean;
  /** A batched campaign stopped at a batch boundary — the rest is queued. */
  paused?: boolean;
  /** Ledger rows still to send (batched campaigns). */
  pending?: number;
  /** When an unattended batch pause ends; null = waiting for a Continue. */
  nextRunAt?: string | null;
  /** Why it stopped, in the server's words — the cap, a dead line, a batch. */
  holdReason?: string | null;
}

const POLL_MS = 1200;
const MAX_POLL_ERRORS = 5;
/** Statuses where nothing more is going to happen without a person acting. */
const SETTLED: readonly JobStatus[] = ['done', 'failed', 'cancelled', 'missed', 'paused'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Immediate "send sequence" via a server-side job (type 'immediate',
 * scheduledAt now): the server records it in History, enforces the blacklist
 * and pacing, and resumes after a crash — the browser only watches.
 *
 * A batched send is watched the same way, but the watch ENDS at the first batch
 * boundary: from there the campaign belongs to the Scheduled/History card,
 * which can pause, continue and log it long after this tab is closed.
 */
export function useJobSend() {
  const [progress, setProgress] = useState<SequenceProgress | null>(null);

  async function run(
    recipients: Recipient[],
    items: JobItem[],
    batch: BatchRule | null = null,
  ): Promise<SequenceProgress> {
    // until the server builds the ledger, estimate the total for the bar
    const estimate = recipients.length * items.length;
    let p: SequenceProgress = { total: estimate, sent: 0, skipped: 0, failed: 0, errors: [], running: true };
    setProgress({ ...p });
    const job = await api.jobs.save({
      scheduledAt: new Date().toISOString(),
      type: 'immediate',
      recipients,
      items,
      ...(batch ? { batch } : {}),
    });
    // the approval rule held the job — nothing is sending, stop watching
    if (job.status === 'pending_approval') {
      const held: SequenceProgress = { ...p, running: false, held: true };
      setProgress(null);
      return held;
    }

    let pollErrors = 0;
    for (;;) {
      await sleep(POLL_MS);
      try {
        // one small ledger-derived summary per poll, not the whole ledger —
        // at 1000+ recipients that mattered
        const s = await api.jobs.progress(job.id);
        const waiting = s.status === 'pending' && !!s.nextRunAt;
        p = {
          total: s.total || estimate,
          sent: s.sent,
          skipped: s.skipped,
          failed: s.failed,
          errors: p.errors,
          running: !SETTLED.includes(s.status) && !waiting,
          paused: s.status === 'paused' || waiting,
          pending: s.pending,
          nextRunAt: s.nextRunAt,
          holdReason: s.holdReason,
        };
        pollErrors = 0;
      } catch (e) {
        // the job keeps sending server-side — only give up after repeated
        // poll failures (server restart, network drop)
        if (++pollErrors >= MAX_POLL_ERRORS)
          throw new Error(`lost track of the send — check the History tab (${(e as Error).message})`);
        continue;
      }
      setProgress({ ...p });
      if (!p.running) {
        // the errors are worth the one full ledger read, once, at the end
        if (p.failed > 0) {
          try {
            const sends = await api.jobs.sends(job.id);
            p = {
              ...p,
              errors: [...new Set(sends.flatMap((x) => (x.lastError ? [x.lastError] : [])))].slice(0, 5),
            };
            setProgress({ ...p });
          } catch {
            // a missing error list is not worth failing the send report over
          }
        }
        return p;
      }
    }
  }

  return { progress, setProgress, run };
}
