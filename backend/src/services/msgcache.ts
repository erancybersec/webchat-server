import type { Db } from '../db/index.js';
import { unwrapEvent } from './envelope.js';
import type { EventRelay } from './events.js';

export interface CachedContent {
  /** the ChatMsg-style type label: text | image | video | audio | … */
  type: string;
  text: string;
  caption: string;
}

/**
 * Pull renderable content out of one raw Evolution message record. Returns
 * null for control / contentless records — a delete-for-everyone nulls
 * `message`; reactions, edit/revoke protocolMessages and E2E stubs carry
 * nothing worth showing. Skipping them is what guarantees a delete event can
 * never overwrite the original content we captured when the message arrived.
 * Mirrors the content cases in the frontend's parseMessage (chatModel.ts).
 */
export function extractCacheContent(record: unknown): CachedContent | null {
  const rec = record as { message?: Record<string, any> } | null;
  const root = rec?.message;
  if (!root || typeof root !== 'object') return null;
  // An edit arrives on the live stream as a protocolMessage whose new content
  // sits under `editedMessage` (same shape as a top-level message) and which
  // targets the original id — NOT as a plain re-upsert of the row. Unwrap it so
  // the new version is cached (and diffed against the stored original → pushed
  // to message_edits). Without this, every edit looks contentless and the
  // version history never accumulates. Mirrors parseMessage in chatModel.ts.
  const edited = root.protocolMessage?.editedMessage;
  const msg: Record<string, any> = edited && typeof edited === 'object' ? edited : root;
  if (typeof msg.conversation === 'string' && msg.conversation)
    return { type: 'text', text: msg.conversation, caption: '' };
  if (msg.extendedTextMessage?.text)
    return { type: 'text', text: String(msg.extendedTextMessage.text), caption: '' };
  if (msg.imageMessage) return { type: 'image', text: '', caption: String(msg.imageMessage.caption ?? '') };
  if (msg.videoMessage) return { type: 'video', text: '', caption: String(msg.videoMessage.caption ?? '') };
  if (msg.audioMessage) return { type: 'audio', text: '', caption: '' };
  if (msg.stickerMessage) return { type: 'sticker', text: '', caption: '' };
  if (msg.documentMessage)
    return { type: 'document', text: '', caption: String(msg.documentMessage.caption ?? '') };
  if (msg.locationMessage)
    return { type: 'location', text: String(msg.locationMessage.name ?? ''), caption: '' };
  if (msg.contactMessage)
    return { type: 'contact', text: String(msg.contactMessage.displayName ?? ''), caption: '' };
  const poll = msg.pollCreationMessage ?? msg.pollCreationMessageV3;
  if (poll) return { type: 'poll', text: String(poll.name ?? ''), caption: '' };
  return null;
}

const sameContent = (a: CachedContent, b: CachedContent): boolean =>
  a.type === b.type && a.text === b.text && a.caption === b.caption;

/**
 * Server-side cache of message content keyed by Evolution message id. Fed by
 * the event relay; read by the findMessages proxy to (a) restore the original
 * text of a delete-for-everyone — Evolution nulls it on its side, so a later
 * fetch cannot recover it — and (b) reveal the previous versions of an edited
 * message, which this Evolution build overwrites in place.
 *
 * The current row holds the latest content. When `record()` sees content that
 * differs from what's stored, it pushes the OLD copy into message_edits before
 * overwriting — so the version history accumulates oldest-first. The eventual
 * delete (no content, never recorded) leaves everything intact.
 */
export class MessageCacheStore {
  private readonly q;
  private readonly recordTxn: (args: {
    id: string;
    jid: string;
    instance: string;
    content: CachedContent;
    now: string;
  }) => void;

  constructor(db: Db) {
    this.q = {
      upsert: db.prepare(`INSERT INTO message_cache
          (message_id, chat_jid, instance, type, text, caption, created_at, updated_at)
        VALUES (@id, @jid, @instance, @type, @text, @caption, @now, @now)
        ON CONFLICT(message_id) DO UPDATE SET
          type = excluded.type, text = excluded.text, caption = excluded.caption,
          chat_jid = excluded.chat_jid, instance = excluded.instance,
          updated_at = excluded.updated_at`),
      byId: db.prepare(`SELECT type, text, caption FROM message_cache WHERE message_id = ?`),
      nextSeq: db.prepare(`SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM message_edits WHERE message_id = ?`),
      pushEdit: db.prepare(`INSERT INTO message_edits
          (message_id, seq, type, text, caption, edited_at)
        VALUES (@id, @seq, @type, @text, @caption, @now)`),
      history: db.prepare(
        `SELECT type, text, caption FROM message_edits WHERE message_id = ? ORDER BY seq ASC`,
      ),
    };
    // One transaction so the old-copy snapshot and the overwrite can't tear:
    // a concurrent reader never sees the new current without its history row.
    this.recordTxn = db.transaction((args) => {
      const prev = this.q.byId.get(args.id) as CachedContent | undefined;
      // Content changed (an edit) → preserve the superseded copy before we
      // overwrite. Identical re-deliveries (socket replays) append nothing.
      if (prev && (prev.text || prev.caption) && !sameContent(prev, args.content)) {
        const { seq } = this.q.nextSeq.get(args.id) as { seq: number };
        this.q.pushEdit.run({
          id: args.id,
          seq,
          type: prev.type,
          text: prev.text,
          caption: prev.caption,
          now: args.now,
        });
      }
      this.q.upsert.run({
        id: args.id,
        jid: args.jid,
        instance: args.instance,
        type: args.content.type,
        text: args.content.text,
        caption: args.content.caption,
        now: args.now,
      });
    });
  }

  /** Snapshot one message's content. No-op without an id or content. */
  record(args: {
    id: string;
    chatJid?: string;
    instance?: string;
    content: CachedContent;
    at?: string;
  }): void {
    if (!args.id) return;
    this.recordTxn({
      id: args.id,
      jid: args.chatJid ?? '',
      instance: args.instance ?? '',
      content: args.content,
      now: args.at ?? new Date().toISOString(),
    });
  }

  /** The cached current copy for a message id, or null if we never saw its content. */
  originalFor(id: string): CachedContent | null {
    if (!id) return null;
    return (this.q.byId.get(id) as CachedContent | undefined) ?? null;
  }

  /**
   * Every version we've cached for a message, oldest first: the superseded
   * copies from message_edits followed by the current copy. The findMessages
   * enrichment diffs this against the live (edited) content to derive the
   * prior versions to show. Empty when the message was never seen.
   */
  versionsFor(id: string): CachedContent[] {
    if (!id) return [];
    const history = this.q.history.all(id) as CachedContent[];
    const current = this.originalFor(id);
    return current ? [...history, current] : history;
  }
}

// Edits in this Evolution build can arrive either as a fresh messages.upsert
// carrying the new content, or as a messages.update — so we snapshot on both.
// extractCacheContent returns null for nulled/contentless records (deletes,
// status-only acks), so those never reach the store or spawn a phantom version.
const CACHE_EVENTS: ReadonlySet<string> = new Set([
  'MESSAGES_UPSERT',
  'messages.upsert',
  'MESSAGES_UPDATE',
  'messages.update',
]);

/** Relay listener: snapshot the content of every message as it arrives or changes. */
export function attachMessageCache(
  relay: EventRelay,
  store: MessageCacheStore,
  log: (msg: string) => void = () => {},
): void {
  relay.subscribe((e) => {
    if (!CACHE_EVENTS.has(e.event)) return;
    const { instance, records } = unwrapEvent(e.data);
    for (const record of records) {
      try {
        const rec = record as {
          key?: { id?: string; remoteJid?: string };
          message?: { protocolMessage?: { key?: { id?: string } } };
        };
        // An edit targets the ORIGINAL message id (under protocolMessage.key),
        // not the edit record's own key.id — record against the original so the
        // new content overwrites the cached copy and the superseded one is
        // pushed to message_edits. Plain messages use their own key.id.
        const id = rec.message?.protocolMessage?.key?.id || rec.key?.id || '';
        if (!id) continue;
        const content = extractCacheContent(record);
        if (!content) continue;
        store.record({ id, chatJid: rec.key?.remoteJid ?? '', instance: instance ?? '', content });
      } catch (err) {
        log(`[msgcache] error: ${String(err)}`);
      }
    }
  });
}
