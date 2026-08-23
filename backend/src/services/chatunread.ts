import type { Db } from '../db/index.js';
import { unwrapEvent } from './envelope.js';
import type { EventRelay } from './events.js';

/**
 * Shared server-side unread state per chat per Evolution line. Evolution's
 * findChats unreadCount is unreliable here (null/0 even for fresh incoming —
 * the number is also read on the phone), so this is the team's source of truth:
 *   - the relay bumps last_incoming_ts when an incoming message arrives;
 *   - the read endpoint moves last_read_ts up to the latest incoming (any agent);
 *   - a chat is unread when last_incoming_ts > last_read_ts — the SAME for every
 *     agent, so one agent opening it clears the badge for the whole team.
 * Timestamps are in millis. Keyed by the CANONICAL chat jid (callers resolve
 * @lid/phone aliases before calling), so a chat collapses to one row.
 */
export class ChatUnreadStore {
  private readonly q;
  private readonly bumpIncomingTxn: (a: { instance: string; jid: string; ts: number; now: string }) => void;

  constructor(db: Db) {
    this.q = {
      get: db.prepare(
        `SELECT last_incoming_ts AS inc, last_read_ts AS read FROM chat_unread
          WHERE instance = ? AND chat_jid = ?`,
      ),
      upsertIncoming: db.prepare(`INSERT INTO chat_unread
          (instance, chat_jid, last_incoming_ts, last_read_ts, updated_at)
        VALUES (@instance, @jid, @ts, 0, @now)
        ON CONFLICT(instance, chat_jid) DO UPDATE SET
          last_incoming_ts = MAX(last_incoming_ts, excluded.last_incoming_ts),
          updated_at = excluded.updated_at`),
      markRead: db.prepare(`INSERT INTO chat_unread
          (instance, chat_jid, last_incoming_ts, last_read_ts, updated_at)
        VALUES (@instance, @jid, 0, @ts, @now)
        ON CONFLICT(instance, chat_jid) DO UPDATE SET
          -- catch the read cursor up to whatever incoming we know (or the caller's
          -- explicit ts) so the chat goes read until a NEWER message arrives
          last_read_ts = MAX(last_read_ts, last_incoming_ts, @ts),
          updated_at = excluded.updated_at`),
      markUnread: db.prepare(`INSERT INTO chat_unread
          (instance, chat_jid, last_incoming_ts, last_read_ts, updated_at)
        VALUES (@instance, @jid, @ts, 0, @now)
        ON CONFLICT(instance, chat_jid) DO UPDATE SET
          -- force unread: keep an incoming newer than the read cursor
          last_incoming_ts = MAX(last_incoming_ts, @ts),
          last_read_ts = 0,
          updated_at = excluded.updated_at`),
    };
    this.bumpIncomingTxn = db.transaction((a) => {
      this.q.upsertIncoming.run({ instance: a.instance, jid: a.jid, ts: a.ts, now: a.now });
    });
  }

  /** An incoming message arrived for `jid` at `ts` (millis). Monotonic. */
  recordIncoming(instance: string, jid: string, ts: number, now: string = new Date().toISOString()): void {
    if (!jid || !ts) return;
    this.bumpIncomingTxn({ instance: instance ?? '', jid, ts, now });
  }

  /** Mark the chat read for the whole team (catches the cursor up to the latest incoming). */
  markRead(instance: string, jid: string, upToTs = 0, now: string = new Date().toISOString()): void {
    if (!jid) return;
    this.q.markRead.run({ instance: instance ?? '', jid, ts: upToTs, now });
  }

  /** Force the chat unread for the whole team (operator "mark unread"). */
  markUnread(instance: string, jid: string, ts: number, now: string = new Date().toISOString()): void {
    if (!jid) return;
    this.q.markUnread.run({ instance: instance ?? '', jid, ts: ts || 1, now });
  }

  /**
   * Shared unread for a chat: 1 when unread, 0 when read, or null when we've
   * never tracked it (caller should fall back to Evolution's own count).
   */
  unreadFor(instance: string, jid: string): number | null {
    if (!jid) return null;
    const row = this.q.get.get(instance ?? '', jid) as { inc: number; read: number } | undefined;
    if (!row) return null;
    return row.inc > row.read ? 1 : 0;
  }
}

// Edits/reactions/deletes/status-acks must not bump unread — only genuine new
// incoming messages do. We skip protocolMessage (edit/revoke) and reaction
// records explicitly, then require renderable content.
function isIncomingMessage(record: unknown): boolean {
  const rec = record as { key?: { fromMe?: boolean }; message?: Record<string, any> } | null;
  if (!rec || rec.key?.fromMe) return false;
  const msg = rec.message;
  if (!msg || typeof msg !== 'object') return false;
  if (msg.protocolMessage || msg.reactionMessage) return false;
  return (
    !!msg.conversation ||
    !!msg.extendedTextMessage ||
    !!msg.imageMessage ||
    !!msg.videoMessage ||
    !!msg.audioMessage ||
    !!msg.stickerMessage ||
    !!msg.documentMessage ||
    !!msg.locationMessage ||
    !!msg.contactMessage ||
    !!msg.pollCreationMessage ||
    !!msg.pollCreationMessageV3
  );
}

function tsToMillis(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'object') {
    const o = v as { low?: number; high?: number };
    if (typeof o.low === 'number' && typeof o.high === 'number') return (o.high * 2 ** 32 + (o.low >>> 0)) * 1000;
    return 0;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // seconds (10 digits) → millis; already-millis values pass through
  return n < 1e12 ? n * 1000 : n;
}

const UNREAD_EVENTS: ReadonlySet<string> = new Set([
  'MESSAGES_UPSERT',
  'messages.upsert',
  'MESSAGES_UPDATE',
  'messages.update',
]);

/**
 * Relay listener: bump the shared unread cursor for every incoming message as it
 * arrives. `canon` collapses @lid/phone aliases so a chat keys to one row.
 */
export function attachChatUnread(
  relay: EventRelay,
  store: ChatUnreadStore,
  canon: (jid: string) => string,
  log: (msg: string) => void = () => {},
): void {
  relay.subscribe((e) => {
    if (!UNREAD_EVENTS.has(e.event)) return;
    const { instance, records } = unwrapEvent(e.data);
    for (const record of records) {
      try {
        if (!isIncomingMessage(record)) continue;
        const rec = record as { key?: { remoteJid?: string }; messageTimestamp?: unknown };
        const jid = rec.key?.remoteJid ?? '';
        if (!jid) continue;
        const ts = tsToMillis(rec.messageTimestamp);
        if (!ts) continue;
        store.recordIncoming(instance ?? '', canon(jid), ts);
      } catch (err) {
        log(`[chatunread] error: ${String(err)}`);
      }
    }
  });
}
