import { unwrapEvent } from './envelope.js';
import type { EventRelay } from './events.js';
import type { JobStore } from './jobs.js';

/**
 * Delivery/read tracking: Evolution's MESSAGES_UPDATE acks are matched by
 * message id against sent ledger rows, upgrading them to delivered/read.
 * Acks for messages we didn't send through a job simply match zero rows.
 */

// Evolution emits either string statuses or raw WhatsApp ack numbers.
const DELIVERED = new Set(['DELIVERY_ACK', '3']);
const READ = new Set(['READ', 'PLAYED', '4', '5']);

interface AckRecord {
  keyId?: string;
  messageId?: string;
  key?: { id?: string };
  status?: unknown;
  update?: { status?: unknown };
}

export function attachAckTracker(
  relay: EventRelay,
  jobs: JobStore,
  /**
   * Stamp the read time of any sent message the moment its READ/PLAYED ack
   * arrives — the only chance to capture it (the stored MessageUpdate history
   * has no timestamp). Independent of the job ledger: covers chat-screen sends
   * too, not just job sends.
   */
  onRead?: (messageId: string) => void,
): void {
  relay.subscribe((e) => {
    if (e.event !== 'MESSAGES_UPDATE' && e.event !== 'messages.update') return;
    const records = unwrapEvent(e.data).records as AckRecord[];
    for (const r of records) {
      const id = r.keyId ?? r.key?.id ?? r.messageId;
      if (typeof id !== 'string' || !id) continue;
      const status = String(r.status ?? r.update?.status ?? '').toUpperCase();
      if (READ.has(status)) {
        jobs.markAck(id, 'read');
        onRead?.(id);
      } else if (DELIVERED.has(status)) jobs.markAck(id, 'delivered');
    }
  });
}
