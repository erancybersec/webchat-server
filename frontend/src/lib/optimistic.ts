import type { ChatMsg, MsgType } from './chatModel';

/**
 * Optimistic send support. Evolution sends block on a WhatsApp round-trip
 * (1-3s) and `fetchThread` rebuilds the messages array from scratch every poll
 * keyed by the REAL Evolution id — so a temp written into the React Query cache
 * would be wiped by the next refetch. Instead an optimistic send lives in a
 * separate client-held list (PendingSend[]) that survives refetches and is
 * merged into the rendered records, then dropped once the real row arrives.
 */
export interface PendingSend extends ChatMsg {
  /** the JobItem we sent — kept so a FAILED temp can be retried verbatim */
  item: { type: string; data: Record<string, unknown> };
  /** Evolution message id, captured from /api/send once it returns 'evo' */
  serverId?: string;
  /** ms epoch when the temp was created — for the safety prune window */
  createdAt: number;
}

const PENDING_TTL_MS = 120_000;
const TS_TOLERANCE_S = 300; // ±5 min: tolerant of browser↔server clock skew (fallback path only)

interface BuildArgs {
  tmpId: string;
  type: MsgType;
  text?: string;
  caption?: string;
  mimetype?: string;
  fileName?: string;
  hasMedia?: boolean;
  localPreviewUrl?: string;
  remoteJid: string;
  quoted?: ChatMsg['quoted'];
  item: PendingSend['item'];
  /** ms epoch; injected in tests (Date.now() is fine in the app) */
  now?: number;
}

/** Build a fully-populated optimistic ChatMsg for an in-flight send. */
export function buildOptimistic(a: BuildArgs): PendingSend {
  const nowMs = a.now ?? Date.now();
  return {
    id: a.tmpId,
    remoteJid: a.remoteJid,
    fromMe: true,
    timestamp: Math.round(nowMs / 1000),
    type: a.type,
    text: a.text ?? '',
    caption: a.caption ?? '',
    mimetype: a.mimetype ?? '',
    fileName: a.fileName ?? '',
    hasMedia: a.hasMedia ?? false,
    quoted: a.quoted ?? null,
    status: 'PENDING',
    edited: false,
    pushName: '',
    senderJid: '',
    reactionTargetId: '',
    editTargetId: '',
    editHistory: [],
    deletedBySender: false,
    optimistic: true,
    localPreviewUrl: a.localPreviewUrl,
    item: a.item,
    createdAt: nowMs,
  };
}

/**
 * Render-time merge: server records followed by still-unreconciled temps.
 *
 * In-flight temps are ALWAYS placed after the server rows (each group ordered by
 * timestamp internally), not interleaved by timestamp. A message you're sending
 * right now is the newest thing you did, so its optimistic bubble belongs at the
 * bottom — but the bubble is stamped from the DEVICE clock, and on a skewed
 * device (common on mobile) that timestamp can fall BELOW recent server rows, so
 * a plain timestamp sort dropped the bubble into the middle ("not good from the
 * start") and then re-sorted it a beat later when the real row arrived stamped
 * server-now. Appending pending keeps it pinned to the bottom; its real row is
 * the newest server row too, so it lands in the same slot — no re-arrange.
 */
export function mergePending(server: ChatMsg[], pending: PendingSend[]): ChatMsg[] {
  if (!pending.length) return server;
  const byTs = (a: ChatMsg, b: ChatMsg): number => a.timestamp - b.timestamp;
  return [...[...server].sort(byTs), ...[...pending].sort(byTs)];
}

/** Pre-delete content of a message the operator deleted via the app. */
export interface LocalDelete {
  text: string;
  caption: string;
  type: string;
  /** display name of the agent who clicked delete — shown instantly as "Deleted by …". */
  by: string;
  /** ISO time the operator clicked delete — shown as "deleted at HH:MM" before the server confirms. */
  at: string;
}

/**
 * Render-time overlay: flip messages the operator just deleted (via the app's
 * delete button) to a deleted tombstone IMMEDIATELY, carrying their pre-delete
 * content as the recovered original. Evolution nulls the content asynchronously
 * and emits no realtime delete event, so a plain refetch lags behind by up to a
 * poll — this shows the tombstone with zero wait. A no-op once the server's own
 * `deletedBySender` flag arrives (or the id isn't present). Returns the SAME
 * reference when nothing changed, so the render memo stays stable.
 */
export function applyLocalDeletes(records: ChatMsg[], deleted: Map<string, LocalDelete>): ChatMsg[] {
  if (!deleted.size) return records;
  let changed = false;
  const out = records.map((m) => {
    const d = deleted.get(m.id);
    if (!d || m.deletedBySender) return m;
    changed = true;
    return {
      ...m,
      deletedBySender: true,
      text: '',
      caption: '',
      hasMedia: false,
      deletedOriginalText: m.deletedOriginalText || d.text,
      deletedOriginalCaption: m.deletedOriginalCaption || d.caption,
      deletedOriginalType: m.deletedOriginalType || d.type,
    };
  });
  return changed ? out : records;
}

const norm = (s: string): string => s.trim();

/**
 * The real row a temp reconciled into, by the SAME rule reconcilePending uses
 * (serverId when present, else content+timestamp). Returned so the caller can
 * carry the temp's device-clock send-time onto the real row for stable sorting
 * — the messageId-based keyAlias misses the content-fallback path entirely
 * (some sends come back with no id on this Evolution build).
 */
export function matchReconciled(temp: PendingSend, server: ChatMsg[]): ChatMsg | undefined {
  if (temp.serverId) return server.find((r) => r.id === temp.serverId);
  return server.find((r) => contentMatch(temp, r));
}

/** Fallback content+timestamp match, used ONLY when a temp has no serverId. */
function contentMatch(temp: PendingSend, real: ChatMsg): boolean {
  if (real.optimistic || !real.fromMe) return false;
  if (real.type === 'reaction' || real.type === 'edit' || real.type === 'delete') return false;
  if (Math.abs(real.timestamp - temp.timestamp) > TS_TOLERANCE_S) return false;
  if (real.type !== temp.type) return false;
  if (temp.type === 'text') return norm(real.text) === norm(temp.text);
  return norm(real.caption) === norm(temp.caption);
}

/**
 * Return the temps still pending given the server set. Pure: drops temps a real
 * row now covers (by serverId, else by content+timestamp), and TTL-prunes stale
 * non-terminal temps. Reconciles the OLDEST matching temp first so one real
 * arrival can't orphan an older temp with identical fallback content. Returns
 * the SAME array reference when nothing changed, so the render memo stays stable.
 *
 * FAILED is NOT unconditionally sticky: a send can time out on the client (25s)
 * yet still go through on Evolution, so if a real row now covers a FAILED temp
 * it's dropped rather than stranding a false "failed" duplicate next to the
 * delivered copy. SKIPPED (blacklisted) stays sticky — no real row will arrive,
 * so only Retry/dismiss clears it.
 */
export function reconcilePending(
  pending: PendingSend[],
  server: ChatMsg[],
  now: number = Date.now(),
): PendingSend[] {
  if (!pending.length) return pending;
  const consumed = new Set<string>(); // server ids already claimed (fallback FIFO)
  const keep = new Set<PendingSend>();
  const covered = (t: PendingSend): boolean => {
    if (t.serverId) return server.some((r) => r.id === t.serverId);
    const hit = server.find((r) => !consumed.has(r.id) && contentMatch(t, r));
    if (hit) {
      consumed.add(hit.id);
      return true;
    }
    return false;
  };
  const ordered = [...pending].sort((a, b) => a.createdAt - b.createdAt); // oldest first
  for (const t of ordered) {
    if (t.status === 'SKIPPED') {
      keep.add(t);
      continue;
    }
    if (covered(t)) continue; // real row landed (incl. a timed-out-but-sent FAILED) → drop
    if (t.status === 'FAILED') {
      keep.add(t); // genuine failure with no delivered copy → sticky for Retry
      continue;
    }
    if (now - t.createdAt > PENDING_TTL_MS) continue; // safety net
    keep.add(t);
  }
  if (keep.size === pending.length) return pending; // unchanged → stable reference
  return pending.filter((p) => keep.has(p)); // preserve insertion order
}
