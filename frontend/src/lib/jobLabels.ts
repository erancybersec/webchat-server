import type { Job } from '../types';

/** Which tab composed a send — the History chip's first half. */
export type JobKind = 'contacts' | 'groups' | 'tools';

/**
 * Item types only the Tools tab produces. Compose and Groups build their
 * sequences from the QueueEditor set (text/media/voice/poll/buttons), so the
 * two sets never overlap.
 */
const TOOL_ITEMS = new Set(['location', 'contact', 'reaction', 'list', 'status']);

const KIND_PREFIX: Record<JobKind, string> = {
  contacts: '',
  groups: 'group · ',
  tools: 'tool · ',
};

/**
 * Derived, not stored: an immediate send carries `type: 'immediate'` whichever
 * tab composed it, so the recipients and item types are the only honest signal
 * — and they read correctly for rows written before this label existed.
 * Tools is checked first because its sends can be addressed to groups too
 * (a Status/Story goes to the synthetic `status@broadcast` group).
 */
export function jobKind(job: Pick<Job, 'recipients' | 'items'>): JobKind {
  if (job.items.length && job.items.every((i) => TOOL_ITEMS.has(i.type))) return 'tools';
  if (job.recipients.length && job.recipients.every((r) => r.isGroup)) return 'groups';
  return 'contacts';
}

/**
 * History chip text: what kind of send it was, and whether it fired on the
 * spot ("sent now") or off the schedule. Plain contact sends keep the bare
 * origin they've always shown.
 */
export function jobOriginLabel(job: Pick<Job, 'recipients' | 'items' | 'type'>): string {
  const origin = job.type === 'immediate' ? 'sent now' : 'scheduled';
  return `${KIND_PREFIX[jobKind(job)]}${origin}`;
}
