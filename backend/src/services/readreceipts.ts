import type { Db } from '../db/index.js';

/**
 * Server-side record of WHEN the recipient read one of our sent messages.
 * Fed by the ack relay (see acks.ts: MESSAGES_UPDATE → READ/PLAYED) and read by
 * the findMessages proxy to attach a `readAt` onto each record. This is the only
 * place the read time survives: this Evolution build's stored MessageUpdate
 * history carries a status string but no timestamp, so once the live ack is gone
 * the time is unrecoverable from any later fetch — exactly the gap message_cache
 * fills for deleted content.
 *
 * First ack wins: the earliest READ is when they actually saw it; later acks
 * (a re-open of the chat) must not bump it.
 */
export class ReadReceiptStore {
  private readonly q;

  constructor(db: Db) {
    this.q = {
      // INSERT OR IGNORE → keep the first (earliest) read time per message
      mark: db.prepare(
        `INSERT OR IGNORE INTO message_reads (message_id, read_at) VALUES (?, ?)`,
      ),
      byId: db.prepare(`SELECT read_at FROM message_reads WHERE message_id = ?`),
    };
  }

  /** Stamp the read time for a message. No-op without an id; first ack wins. */
  markRead(messageId: string, at: string = new Date().toISOString()): void {
    if (!messageId) return;
    this.q.mark.run(messageId, at);
  }

  /** ISO time the recipient read this message, or null if we never saw a READ ack. */
  readAtFor(messageId: string): string | null {
    if (!messageId) return null;
    const row = this.q.byId.get(messageId) as { read_at?: string } | undefined;
    return row?.read_at ?? null;
  }
}
