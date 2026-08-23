import type { BatchRule, JobItem, Recipient, RepeatRule } from '../types';

/**
 * Hand-off from the Scheduled/History lists into the Compose tab ("edit before
 * resend"). A module-level slot instead of lifted state: ComposePage remounts
 * on every tab switch, so it just peeks the slot in its initializers.
 */
export interface ComposeDraft {
  recipients: Recipient[];
  items: JobItem[];
  /** Set when editing a still-pending (or paused) job — Compose updates it in place. */
  jobId?: string;
  scheduledAt?: string;
  repeat?: RepeatRule | null;
  batch?: BatchRule | null;
  /**
   * The job being edited has already sent to some of its recipients (a paused
   * campaign). Compose warns, and keeps the sequence's shape: its ledger rows
   * key on the item index, so the server refuses an added or removed message.
   */
  partlySent?: boolean;
}

let pending: ComposeDraft | null = null;

export function setComposeDraft(d: ComposeDraft): void {
  pending = d;
}

/** Read without consuming — StrictMode runs initializers twice. */
export function peekComposeDraft(): ComposeDraft | null {
  return pending;
}

/** Idempotent clear, called from a mount effect once the draft is loaded. */
export function clearComposeDraft(): void {
  pending = null;
}
