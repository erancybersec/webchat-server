/**
 * Chat domain model — pure functions ported from the proven v1 app.
 * The v1 file paid for these in production debugging; treat them as spec:
 *  - numeric timestamp coercion (string timestamps made sorting NaN-break)
 *  - 3-pass @lid ↔ phone-JID deduplication building an alias map
 *  - message parsing across Evolution's many message shapes
 */

export interface Conv {
  id: string;
  name: string;
  profilePicUrl: string;
  lastMessage: string;
  lastMsgTimestamp: number;
  unreadCount: number;
  /** unread, but with no real count — render a plain dot, not a number (WhatsApp-style). */
  unreadDot: boolean;
  isGroup: boolean;
  fromMe: boolean;
  pinned: boolean;
  /** remoteJidAlt of the last message — used by dedup pass 0. */
  altJid: string;
}

export interface QuotedMsg {
  id: string;
  text: string;
  fromMe: boolean;
  participant: string;
}

export type MsgType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'reaction'
  | 'edit'
  | 'delete';

/** Live tally for a poll, aggregated server-side from its vote records. */
export interface PollTally {
  /** number of distinct voters with a current selection */
  total: number;
  options: { name: string; count: number; voters: PollVoter[] }[];
}

/** One voter under a poll option: display name + phone number (either may be ''). */
export interface PollVoter {
  name: string;
  number: string;
}

export interface ChatMsg {
  id: string;
  remoteJid: string;
  fromMe: boolean;
  /** seconds since epoch */
  timestamp: number;
  type: MsgType;
  text: string;
  caption: string;
  mimetype: string;
  fileName: string;
  /** true when the record carries media fetchable via /api/media */
  hasMedia: boolean;
  quoted: QuotedMsg | null;
  status: string;
  /**
   * seconds since epoch when the recipient READ (or PLAYED) this own message,
   * if Evolution reported a timestamp on that status update; 0 when read but
   * untimed, and absent/0 when not yet read. Read-receipt-disabled contacts
   * never send a READ ack, so 0 here is not proof a message is unread.
   */
  readAt?: number;
  /** true when the message was edited (EDITED in status history, or a folded-in edit record) */
  edited: boolean;
  pushName: string;
  senderJid: string;
  /** for type 'reaction': the id of the message being reacted to */
  reactionTargetId: string;
  /** for type 'edit'/'delete': the id of the original message this control record targets */
  editTargetId: string;
  /** previous versions of an edited message (original first, latest excluded); empty when never edited */
  editHistory: string[];
  /** true when the sender deleted this message for everyone (content is kept, just flagged) */
  deletedBySender: boolean;
  /**
   * For a delete-for-everyone, the original content recovered from the
   * server-side cache (Evolution nulls it on its side). Empty when we never
   * captured it — older deletes, or one that happened while the server was down.
   */
  deletedOriginalText?: string;
  deletedOriginalCaption?: string;
  /** ChatMsg-style type of the deleted original (image/video/…), for a label when there's no text. */
  deletedOriginalType?: string;
  /** client-only: an optimistic, not-yet-confirmed local send (temp id) */
  optimistic?: boolean;
  /** client-only: local data:/blob URL preview for a pending media/voice bubble (no Evolution media yet) */
  localPreviewUrl?: string;
  /** for type 'poll': live results, aggregated by the backend (gateway.applyPollVotes) */
  pollVotes?: PollTally;
  /** for type 'poll': the option names in order — present even before any vote (pollVotes is absent until the first vote) */
  pollOptions?: string[];
  /** for type 'poll': true when voters may pick more than one option (selectableOptionsCount !== 1) */
  pollMultiple?: boolean;
}

/** One sender's surviving reaction on a message, after the WhatsApp collapse. */
export interface CollapsedReaction {
  emoji: string;
  fromMe: boolean;
  senderJid: string;
  pushName: string;
  /** seconds since epoch */
  at: number;
}

/**
 * Collapse standalone reaction records onto their target messages with
 * WhatsApp semantics: ONE reaction per sender per message (the latest wins),
 * and an empty emoji means the sender removed theirs. Records may arrive in
 * any order — the latest by timestamp is kept; removals drop the sender's
 * entry. Returns target message id → its surviving reactions (targets with
 * none are omitted). Pure, so the dedup is unit-tested directly.
 */
export function collapseReactions(records: ChatMsg[]): Map<string, CollapsedReaction[]> {
  const byTarget = new Map<string, Map<string, CollapsedReaction>>();
  for (const m of records) {
    if (m.type !== 'reaction' || !m.reactionTargetId) continue;
    // Identify the reactor. In a 1:1 the only other party is the chat jid, so
    // dedup by remoteJid; in a group each participant is a distinct reactor, so
    // dedup by senderJid — falling back to the reaction's own id (never the
    // group jid) so an unidentifiable participant can't swallow everyone else's
    // reaction. fromMe collapses to a single "me" key.
    const senderKey = m.fromMe
      ? '__me__'
      : isGroupJid(m.remoteJid)
        ? m.senderJid || m.id
        : m.remoteJid || m.senderJid || m.id;
    const perSender = byTarget.get(m.reactionTargetId) ?? new Map<string, CollapsedReaction>();
    const existing = perSender.get(senderKey);
    if (!existing || m.timestamp >= existing.at) {
      perSender.set(senderKey, {
        emoji: m.text,
        fromMe: m.fromMe,
        senderJid: m.senderJid,
        pushName: m.pushName,
        at: m.timestamp,
      });
    }
    byTarget.set(m.reactionTargetId, perSender);
  }
  const out = new Map<string, CollapsedReaction[]>();
  for (const [target, perSender] of byTarget) {
    const live = [...perSender.values()].filter((r) => r.emoji); // empty = removed
    if (live.length) out.set(target, live);
  }
  return out;
}

/**
 * Fold edit and delete control records onto the messages they target. Both
 * arrive as their own protocolMessage record (carrying the original message's
 * id under editTargetId) because Evolution does not rewrite the original row:
 *  - 'edit'   → the target shows the LATEST version's text/caption, is marked
 *               edited, and keeps every PRIOR version (original first, latest
 *               excluded) in editHistory so the UI can reveal the pre-edit text.
 *  - 'delete' → the target keeps its content but is flagged deletedBySender so
 *               the UI can note it was deleted for everyone.
 *
 * Evolution frequently stores the edit row but NOT the original (the target id
 * has zero stored rows — verified in prod). An 'edit' whose target is absent is
 * rendered as its OWN normal-text bubble carrying the new text/caption, so the
 * edited text is never silently lost. A target is present (folded → one bubble)
 * XOR absent (standalone → one bubble), never both, so no duplicate. A
 * contentless orphan edit is dropped (nothing to show); an orphan delete is
 * ignored. The standalone keeps editTargetId set and forces fromMe:false so the
 * renderer treats it as read-only (no Edit action against a non-resendable id).
 * Pure + unit-tested.
 */
export function applyEdits(records: ChatMsg[]): ChatMsg[] {
  const editsByTarget = new Map<string, ChatMsg[]>(); // editTargetId → its edit records
  const deletedTargets = new Set<string>();
  const presentIds = new Set<string>();
  for (const m of records) {
    if (m.type === 'edit') {
      if (m.editTargetId) editsByTarget.set(m.editTargetId, [...(editsByTarget.get(m.editTargetId) ?? []), m]);
    } else if (m.type === 'delete') {
      if (m.editTargetId) deletedTargets.add(m.editTargetId);
    } else {
      presentIds.add(m.id);
    }
  }
  const out: ChatMsg[] = [];
  for (const m of records) {
    if (m.type === 'edit' || m.type === 'delete') continue; // control records, never shown alone
    let next = m;
    const edits = editsByTarget.get(m.id);
    if (edits?.length) {
      const ordered = [...edits].sort((a, b) => a.timestamp - b.timestamp); // oldest → newest
      const latest = ordered[ordered.length - 1]!;
      // history = the original plus every superseded edit, current version excluded
      const editHistory = [m, ...ordered.slice(0, -1)].map((v) => v.text || v.caption).filter(Boolean);
      next = { ...m, text: latest.text || m.text, caption: latest.caption || m.caption, edited: true, editHistory };
    }
    if (deletedTargets.has(m.id)) next = { ...next, deletedBySender: true };
    out.push(next);
  }
  // Orphan edits: the original was never stored, so the edit row is the only
  // carrier of the new text — render the LATEST per missing target standalone
  // rather than dropping it. fetchThread re-sorts by timestamp afterward.
  for (const [target, edits] of editsByTarget) {
    if (presentIds.has(target)) continue;
    const ordered = [...edits].sort((a, b) => a.timestamp - b.timestamp);
    const latest = ordered[ordered.length - 1]!;
    if (!(latest.text || latest.caption)) continue; // contentless → nothing to show
    const editHistory = ordered.slice(0, -1).map((v) => v.text || v.caption).filter(Boolean);
    // type 'text' so MessageBubble renders it; fromMe:false + editTargetId kept
    // so the renderer treats it as a read-only (non-editable) incoming bubble.
    out.push({ ...latest, type: 'text', fromMe: false, edited: true, editHistory });
  }
  return out;
}

/** Coerce Evolution timestamps (ISO string | seconds | millis | protobuf Long) to millis. */
export function tsNum(v: unknown): number {
  if (v == null) return 0;
  // protobuf Long ({low, high, unsigned}) leaks through some webhook payloads
  if (typeof v === 'object') {
    const o = v as { low?: unknown; high?: unknown };
    if (typeof o.low === 'number' && typeof o.high === 'number')
      return scaleToMillis(o.high * 2 ** 32 + (o.low >>> 0));
    return 0;
  }
  if (typeof v === 'number') return scaleToMillis(v);
  const parsed = Date.parse(String(v));
  if (!Number.isNaN(parsed)) return parsed;
  return scaleToMillis(Number(v));
}

// epoch seconds stay < 1e12 until the year 33658; millis passed 1e12 in 2001
function scaleToMillis(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : n;
}

export const isGroupJid = (jid: string): boolean => jid.includes('@g.us');

const hasRealName = (name: string): boolean => !!name && !/^[\d\s+-]+$/.test(name);

export function displayNumber(jid: string): string {
  const local = jid.split('@')[0] ?? '';
  return /^\d+$/.test(local) ? `+${local}` : local;
}

/**
 * Subtitle number for a conversation. Lid digits are NOT a phone number —
 * prefer the real number from the remoteJidAlt link, else show them bare.
 */
export function displayConvNumber(conv: Pick<Conv, 'id' | 'altJid'>): string {
  if (!conv.id.endsWith('@lid')) return displayNumber(conv.id);
  if (conv.altJid && !conv.altJid.endsWith('@lid')) return displayNumber(conv.altJid);
  return conv.id.split('@')[0]!;
}

/** name lookup map from /api/contacts records */
export function buildContactNames(contacts: Array<Record<string, any>>): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of contacts ?? []) {
    const jid = c.remoteJid ?? c.id ?? '';
    const name = c.savedName || c.displayName || c.pushName || '';
    if (jid && hasRealName(name)) map.set(jid, name);
  }
  return map;
}

const PREVIEW_LABELS: Record<string, string> = {
  imageMessage: '📷 Photo',
  videoMessage: '🎥 Video',
  audioMessage: '🎤 Audio',
  documentMessage: '📄 Document',
  stickerMessage: '🏷 Sticker',
  reactionMessage: '❤️ Reaction',
  pollCreationMessage: '📊 Poll',
  contactMessage: '👤 Contact',
  locationMessage: '📍 Location',
};

function lastMessagePreview(lastMsg: Record<string, any>): string {
  const m = lastMsg?.message ?? {};
  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    (m.imageMessage && '📷 Photo') ||
    (m.videoMessage && '🎥 Video') ||
    (m.audioMessage && '🎤 Audio') ||
    (m.documentMessage && '📄 Document') ||
    (m.stickerMessage && '🏷 Sticker') ||
    '';
  if (text) return text;
  return PREVIEW_LABELS[lastMsg?.messageType as string] ?? '';
}

/** Millis timestamp of a raw findChats record (shared with App's unread total). */
export function convTimestamp(c: Record<string, any>): number {
  return tsNum(c.lastMsgTimestamp ?? c.updatedAt ?? c.lastMessage?.messageTimestamp);
}

function parseConv(c: Record<string, any>, names: Map<string, string>): Conv | null {
  const jid: string = c.remoteJid ?? c.id ?? '';
  if (!jid || jid === 'status@broadcast') return null;
  const lastMsg = c.lastMessage ?? {};
  // for groups, findChats pushName is the LAST SENDER, never the group — a
  // person's name on a group row is worse than no name at all
  const rawName = names.get(jid) || (isGroupJid(jid) ? c.name : c.pushName || c.name) || '';
  return {
    id: jid,
    name: hasRealName(rawName) ? rawName : '',
    profilePicUrl: c.profilePicUrl ?? c.profilePictureUrl ?? '',
    lastMessage: lastMessagePreview(lastMsg),
    lastMsgTimestamp: convTimestamp(c),
    unreadCount: c.unreadCount ?? 0,
    unreadDot: !!c.unreadDot,
    isGroup: isGroupJid(jid),
    fromMe: !!lastMsg?.key?.fromMe,
    pinned: !!(c.pinned ?? c.pin),
    altJid: lastMsg?.key?.remoteJidAlt ?? '',
  };
}

/** Merge `secondary` into `primary` and record the alias. */
function merge(primary: Conv, secondary: Conv, aliases: Map<string, string>): void {
  if (!primary.name && secondary.name) primary.name = secondary.name;
  if (!primary.profilePicUrl && secondary.profilePicUrl) primary.profilePicUrl = secondary.profilePicUrl;
  // Combine unread across aliases. A "dot" carries no real count (synthetic 1),
  // so summing two of them would wrongly show "2": instead a real numeric count
  // wins (and absorbs the flag), and two flags collapse back to a single dot.
  const pReal = primary.unreadDot ? 0 : primary.unreadCount;
  const sReal = secondary.unreadDot ? 0 : secondary.unreadCount;
  const real = pReal + sReal;
  const anyUnread = primary.unreadCount > 0 || secondary.unreadCount > 0;
  if (real > 0) {
    primary.unreadCount = real;
    primary.unreadDot = false;
  } else {
    primary.unreadCount = anyUnread ? 1 : 0;
    primary.unreadDot = anyUnread;
  }
  if (secondary.lastMsgTimestamp > primary.lastMsgTimestamp) {
    primary.lastMsgTimestamp = secondary.lastMsgTimestamp;
    primary.lastMessage = secondary.lastMessage;
    primary.fromMe = secondary.fromMe;
  }
  aliases.set(secondary.id, primary.id);
}

function pickPrimary(a: Conv, b: Conv): [Conv, Conv] {
  if (hasRealName(a.name) && !hasRealName(b.name)) return [a, b];
  if (hasRealName(b.name) && !hasRealName(a.name)) return [b, a];
  return a.lastMsgTimestamp >= b.lastMsgTimestamp ? [a, b] : [b, a];
}

export interface ChatList {
  convs: Conv[];
  /** secondary jid → primary jid (@lid aliases etc.) */
  aliases: Map<string, string>;
}

/**
 * Parse + dedup the findChats records. WhatsApp assigns both @lid and
 * @s.whatsapp.net JIDs to the same contact; four passes merge them:
 *   0. remoteJidAlt of the last message (authoritative link)
 *   1. identical profile-picture URL (sans query) joining lid+phone entries
 *   2. identical numeric local part
 *   3. the server-learned alias map (recovers links the first three can't —
 *      a lid row with no remoteJidAlt, no shared pic, and a non-matching local)
 */
export function buildChatList(
  records: Array<Record<string, any>>,
  contacts: Array<Record<string, any>> = [],
  groupSubjects: Map<string, string> = new Map(),
  /**
   * Server-learned alias map (alt jid → primary jid, from /api/chat-meta).
   * Recovers the phone number of a `@lid`-only contact: WhatsApp's LID-first
   * addressing means the chat row has no phone twin to dedup against and its
   * recent messages may carry no `remoteJidAlt`, so the digits shown would
   * otherwise be the opaque LID. The server learns the real number from the
   * thread's older messages; we borrow it here for display only.
   */
  serverAliases: Record<string, string> = {},
): ChatList {
  const names = buildContactNames(contacts);
  let convs = (records ?? []).map((c) => parseConv(c, names)).filter((c): c is Conv => !!c);
  const aliases = new Map<string, string>();
  const removed = new Set<string>();

  // pass 0 — remoteJidAlt
  const byId = new Map(convs.map((c) => [c.id, c]));
  for (const c of convs) {
    if (c.isGroup || removed.has(c.id) || !c.altJid || c.altJid === c.id) continue;
    const other = byId.get(c.altJid);
    // never alias a group into a contact, whatever remoteJidAlt claims
    if (!other || other.isGroup || removed.has(other.id)) continue;
    const [primary, secondary] = pickPrimary(c, other);
    merge(primary, secondary, aliases);
    removed.add(secondary.id);
  }

  // pass 1 — same profile picture, lid + phone pair
  const byPic = new Map<string, Conv[]>();
  for (const c of convs) {
    if (c.isGroup || removed.has(c.id) || !c.profilePicUrl) continue;
    const key = c.profilePicUrl.split('?')[0]!;
    byPic.set(key, [...(byPic.get(key) ?? []), c]);
  }
  for (const group of byPic.values()) {
    const lids = group.filter((c) => c.id.endsWith('@lid') && !removed.has(c.id));
    const phones = group.filter((c) => c.id.endsWith('@s.whatsapp.net') && !removed.has(c.id));
    for (const lid of lids) {
      for (const phone of phones) {
        if (removed.has(lid.id) || removed.has(phone.id)) continue;
        const [primary, secondary] = pickPrimary(lid, phone);
        merge(primary, secondary, aliases);
        removed.add(secondary.id);
      }
    }
  }

  // pass 2 — same numeric local part
  const byLocal = new Map<string, Conv[]>();
  for (const c of convs) {
    if (c.isGroup || removed.has(c.id)) continue;
    const local = c.id.split('@')[0]!;
    if (/^\d+$/.test(local)) byLocal.set(local, [...(byLocal.get(local) ?? []), c]);
  }
  for (const group of byLocal.values()) {
    const alive = group.filter((c) => !removed.has(c.id));
    if (alive.length < 2) continue;
    alive.sort((a, b) => {
      const an = hasRealName(a.name) ? 1 : 0;
      const bn = hasRealName(b.name) ? 1 : 0;
      if (an !== bn) return bn - an;
      return b.lastMsgTimestamp - a.lastMsgTimestamp;
    });
    const [primary, ...secondaries] = alive;
    for (const s of secondaries) {
      merge(primary!, s, aliases);
      removed.add(s.id);
    }
  }

  // pass 3 — server-learned aliases. The server recovers lid↔phone pairs from
  // opened-thread history (enrichMessages → /api/chat-meta), which catches a
  // duplicate the first three passes can't: a @lid row whose last message
  // dropped the remoteJidAlt link, with no shared profile pic and a lid local
  // part that never matches the phone's digits. Without this the contact shows
  // twice — once named (the phone row), once as the bare recovered number.
  for (const c of convs) {
    if (c.isGroup || removed.has(c.id)) continue;
    const linked = serverAliases[c.id];
    if (!linked || linked === c.id) continue;
    const other = byId.get(linked);
    if (!other || other.isGroup || removed.has(other.id) || other.id === c.id) continue;
    const [primary, secondary] = pickPrimary(c, other);
    merge(primary, secondary, aliases);
    removed.add(secondary.id);
  }

  // flatten alias chains (A→B then B→C) so lookups and threadJids see roots
  for (const [from, to] of aliases) {
    let root = to;
    while (aliases.has(root)) root = aliases.get(root)!;
    if (root !== to) aliases.set(from, root);
  }

  convs = convs.filter((c) => !removed.has(c.id));

  // Seed a missing lid→phone link from the server's learned alias map. A
  // lid-only chat (no phone twin to dedup against, last message missing the
  // remoteJidAlt link) otherwise has nothing but the opaque LID to show. Fill
  // altJid only when it's absent/also-lid, so working rows are never altered —
  // and both the name fallback below and displayConvNumber (the subtitle) then
  // render the real number with no further change.
  for (const c of convs) {
    if (!c.id.endsWith('@lid') || (c.altJid && !c.altJid.endsWith('@lid'))) continue;
    const phone = serverAliases[c.id];
    if (phone && !phone.endsWith('@lid')) c.altJid = phone;
  }

  // authoritative group subjects (findChats pushName is the last sender, not the group)
  for (const c of convs) {
    if (c.isGroup) {
      const subject = groupSubjects.get(c.id);
      if (subject) c.name = subject;
    }
    // lid-only chats: the lid digits are NOT a phone number — show the real
    // number from the remoteJidAlt link (or server-learned alias) when we have it
    if (!c.name && c.id.endsWith('@lid'))
      c.name = c.altJid ? displayNumber(c.altJid) : c.id.split('@')[0]!;
    if (!c.name) c.name = displayNumber(c.id);
  }

  convs.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastMsgTimestamp - a.lastMsgTimestamp;
  });

  return { convs, aliases };
}

export function resolveName(
  jid: string,
  names: Map<string, string>,
  aliases: Map<string, string>,
): string {
  const primary = aliases.get(jid) ?? jid;
  const named = names.get(primary) ?? names.get(jid);
  if (named) return named;
  // lid digits are NOT a phone number — never render them as +…
  if (primary.endsWith('@lid')) return primary.split('@')[0]!;
  return displayNumber(primary);
}

const STATUS_RANK: Record<string, number> = {
  PENDING: 1,
  SERVER_ACK: 2,
  DELIVERY_ACK: 3,
  READ: 4,
  PLAYED: 5,
};

/**
 * Evolution records message edits/deletes in the `MessageUpdate` status-history
 * array, NOT as separate protocolMessage rows. Derive the best delivery status
 * (for ticks) plus the edited/deleted flags from that history + the top-level
 * `status` (which can be missing).
 *
 * Deletes (verified against prod): a delete-for-everyone NULLS `message` to
 * literal null and marks the history `EDITED` — there is NO 'DELETED' status in
 * this Evolution build. So the authoritative delete signal is the nulled
 * content, not a status string. (We still honour a 'DELETED' status if a
 * future/other build emits one.) The generic `EDITED` marker rides along on a
 * delete, so a nulled record is treated as deleted, never as edited.
 */
function deriveStatus(m: Record<string, any>): {
  status: string;
  edited: boolean;
  deleted: boolean;
  readAt: number;
} {
  const updates: Array<Record<string, any>> = Array.isArray(m.MessageUpdate) ? m.MessageUpdate : [];
  const history: string[] = updates.map((u) => u?.status).filter(Boolean);
  if (m.status) history.push(m.status);
  let status = '';
  for (const s of history) if ((STATUS_RANK[s] ?? 0) > (STATUS_RANK[status] ?? 0)) status = s;
  // when the recipient read (or played) the message, surface WHEN — Evolution
  // stamps each update entry with a dateTime; field name/shape varies by build,
  // so coerce defensively and fall back to 0 (read but untimed).
  let readAt = 0;
  for (const u of updates) {
    if (u?.status !== 'READ' && u?.status !== 'PLAYED') continue;
    const t = Math.round(tsNum(u.dateTime ?? u.datetime ?? u.timestamp ?? u.messageTimestamp) / 1000);
    if (t > readAt) readAt = t;
  }
  // content nulled in place = delete-for-everyone (the original text is gone on
  // Evolution's side and cannot be recovered). E2E sub-payloads keep an object
  // under `message` (e.g. {messageContextInfo}), so == null isolates real deletes.
  const deleted = history.includes('DELETED') || m.message == null;
  return { status, edited: history.includes('EDITED') && !deleted, deleted, readAt };
}

// Baileys serializes ProtocolMessage.Type.REVOKE (enum 0) as the number 0, the
// string '0', or 'REVOKE' depending on the Evolution build — accept all three.
const REVOKE_TYPES: ReadonlySet<unknown> = new Set([0, '0', 'REVOKE']);
function isRevoke(pm: any): boolean {
  return !!pm && pm.editedMessage == null && REVOKE_TYPES.has(pm.type);
}

/** Parse one findMessages record into a renderable message. */
export function parseMessage(m: Record<string, any>): ChatMsg | null {
  try {
    const key = m.key ?? {};
    const id: string = key.id ?? '';
    const remoteJid: string = key.remoteJid ?? '';
    if (!id || !remoteJid) return null;
    const fromMe = !!key.fromMe;
    // through tsNum — string/Long timestamps must not NaN-break thread sorting
    const timestamp = Math.round(tsNum(m.messageTimestamp ?? m.timestamp) / 1000);
    const msg = m.message ?? {};
    // Poll votes (pollUpdateMessage) and result snapshots are not standalone
    // bubbles — like WhatsApp, they fold into the poll's live tally (aggregated
    // server-side onto the poll-creation record as `pollVotes`). Dropping them
    // here is what removes the raw [pollUpdateMessage] placeholder rows.
    if (msg.pollUpdateMessage || msg.pollResultSnapshotMessage) return null;
    // edited/deleted come from the MessageUpdate history; a delete-for-everyone
    // also nulls the content, so we need `deleted` before the content parsing
    // below decides whether an empty message is droppable.
    const { status, edited, deleted, readAt } = deriveStatus(m);

    let type: MsgType = 'text';
    let text = '';
    let caption = '';
    let mimetype = '';
    let fileName = '';
    let hasMedia = false;
    let reactionTargetId = '';
    let editTargetId = '';

    if (msg.conversation) text = msg.conversation;
    else if (msg.extendedTextMessage?.text) text = msg.extendedTextMessage.text;
    else if (msg.imageMessage) {
      type = 'image';
      caption = msg.imageMessage.caption ?? '';
      mimetype = msg.imageMessage.mimetype ?? 'image/jpeg';
      hasMedia = true;
    } else if (msg.videoMessage) {
      type = 'video';
      caption = msg.videoMessage.caption ?? '';
      mimetype = msg.videoMessage.mimetype ?? 'video/mp4';
      hasMedia = true;
    } else if (msg.audioMessage) {
      type = 'audio';
      mimetype = msg.audioMessage.mimetype ?? 'audio/ogg';
      hasMedia = true;
    } else if (msg.stickerMessage) {
      type = 'sticker';
      mimetype = msg.stickerMessage.mimetype ?? 'image/webp';
      hasMedia = true;
    } else if (msg.documentMessage) {
      type = 'document';
      fileName = msg.documentMessage.fileName ?? 'document';
      caption = msg.documentMessage.caption ?? '';
      mimetype = msg.documentMessage.mimetype ?? 'application/octet-stream';
      hasMedia = true;
    } else if (msg.locationMessage) {
      type = 'location';
      text = msg.locationMessage.name || '📍 Location';
    } else if (msg.contactMessage) {
      type = 'contact';
      text = `👤 ${msg.contactMessage.displayName ?? 'Contact'}`;
    } else if (msg.reactionMessage) {
      type = 'reaction';
      text = msg.reactionMessage.text ?? '';
      reactionTargetId = msg.reactionMessage.key?.id ?? '';
      // empty text = the sender REMOVED their reaction. Keep the record (don't
      // drop it) so the per-sender dedup downstream can supersede an earlier
      // reaction from the same sender instead of leaving a ghost chip.
    } else if (msg.pollCreationMessage || msg.pollCreationMessageV3) {
      const poll = msg.pollCreationMessage ?? msg.pollCreationMessageV3;
      type = 'poll';
      text = poll.name ?? '';
      caption = (poll.options ?? [])
        .map((o: any) => o.optionName ?? o.name ?? '')
        .filter(Boolean)
        .join(' · ');
    } else if (msg.protocolMessage?.editedMessage) {
      // A message was edited. Evolution delivers the edit as its OWN
      // protocolMessage record (new content under editedMessage) rather than
      // rewriting the original row — so carry the new text + the original id
      // and let applyEdits (in fetchThread) fold it onto the target. Other
      // protocolMessage types (revoke/delete) have no editedMessage and stay
      // hidden via the skip set below.
      const em = msg.protocolMessage.editedMessage;
      type = 'edit';
      editTargetId = msg.protocolMessage.key?.id ?? '';
      text = em.conversation ?? em.extendedTextMessage?.text ?? '';
      caption =
        em.imageMessage?.caption ?? em.videoMessage?.caption ?? em.documentMessage?.caption ?? '';
    } else if (isRevoke(msg.protocolMessage)) {
      // Delete-for-everyone. Like edits, Evolution sends this as its own
      // protocolMessage record (type REVOKE) pointing at the deleted message's
      // id — we keep the original content visible and just flag it deleted.
      type = 'delete';
      editTargetId = msg.protocolMessage.key?.id ?? '';
    } else {
      text = m.body || msg.text || '';
      if (!text) {
        const skip = new Set([
          'messageContextInfo',
          'messageSecret',
          'senderKeyDistributionMessage',
          'deviceSentMessage',
          'protocolMessage',
          'secretEncryptedMessage', // E2E sub-payload (poll votes, event RSVPs) Evolution can't decrypt
        ]);
        const mainKey = Object.keys(msg).find((k) => !skip.has(k));
        // a deleted message has its content nulled by Evolution — keep it
        // (empty text) so the "deleted" note still renders; otherwise drop the
        // contentless record as before.
        if (!mainKey) {
          if (!deleted) return null;
        } else {
          text = `[${mainKey}]`;
        }
      }
    }

    let quoted: QuotedMsg | null = null;
    // A quoted REPLY's contextInfo can live in two places depending on the
    // Evolution build: nested under the content type (message.extendedTextMessage
    // .contextInfo, …) on some builds, OR — on this v2.3.7 instance — as a plain
    // `conversation` message with a RECORD-level `contextInfo` sibling (m.contextInfo).
    // Without the record-level fallback, an outgoing text reply renders as plain
    // text with no quote chip (the optimistic bubble shows the quote, then it
    // vanishes once the real echo reconciles in).
    const ctx =
      msg.extendedTextMessage?.contextInfo ??
      msg.imageMessage?.contextInfo ??
      msg.videoMessage?.contextInfo ??
      msg.audioMessage?.contextInfo ??
      msg.documentMessage?.contextInfo ??
      m.contextInfo;
    if (ctx?.quotedMessage) {
      const qm = ctx.quotedMessage;
      quoted = {
        id: ctx.stanzaId ?? '',
        text: qm.conversation ?? qm.extendedTextMessage?.text ?? qm.imageMessage?.caption ?? '📷 Photo',
        fromMe: !ctx.participant,
        participant: ctx.participant ?? '',
      };
    }

    // pushName that is actually a JID is an API bug — treat it as senderJid
    let pushName: string = m.pushName ?? '';
    let senderJid: string = key.participant ?? m.participant ?? '';
    if (pushName.includes('@')) {
      if (!senderJid) senderJid = pushName;
      pushName = '';
    }
    if (!senderJid && key.participantAlt) senderJid = key.participantAlt;

    // original content of a delete-for-everyone, restored by the backend cache
    // (see gateway.enrichMessages). Present only on content-nulled deletes.
    const orig =
      m.deletedOriginal && typeof m.deletedOriginal === 'object'
        ? (m.deletedOriginal as { type?: string; text?: string; caption?: string })
        : null;

    // prior versions of an edited message, restored by the backend cache (this
    // Evolution build overwrites edits in place, so they're lost from the live
    // record). Oldest first; applyEdits leaves this untouched when there are no
    // separate edit records to fold (the production path).
    const cachedHistory: string[] = Array.isArray(m.editHistory)
      ? (m.editHistory as Array<{ text?: string; caption?: string }>)
          .map((v) => v?.text || v?.caption || '')
          .filter(Boolean)
      : [];

    return {
      id,
      remoteJid,
      fromMe,
      timestamp,
      type,
      text,
      caption,
      mimetype,
      fileName,
      hasMedia,
      quoted,
      status,
      // when the recipient read this: from the update entry's own timestamp if
      // the build provides one, else the backend's live-ack cache (m.readAt,
      // attached by the findMessages proxy). 0 = read but untimed; undefined =
      // not read yet.
      readAt:
        readAt ||
        (m.readAt ? Math.round(tsNum(m.readAt) / 1000) : 0) ||
        (status === 'READ' || status === 'PLAYED' ? 0 : undefined),
      // a cached prior version is itself proof the message was edited, even if
      // the live record's EDITED marker didn't survive the round-trip
      edited: edited || cachedHistory.length > 0,
      pushName,
      senderJid,
      reactionTargetId,
      editTargetId,
      editHistory: cachedHistory,
      deletedBySender: deleted,
      deletedOriginalText: orig?.text ?? '',
      deletedOriginalCaption: orig?.caption ?? '',
      deletedOriginalType: orig?.type ?? '',
      // live poll results: the backend tallies all vote records onto the
      // poll-creation record (record-level `pollVotes`), present only on polls
      pollVotes:
        type === 'poll' && m.pollVotes && typeof m.pollVotes === 'object'
          ? (m.pollVotes as PollTally)
          : undefined,
      // the poll's options/mode straight off the creation record, so the bubble
      // can show every option (WhatsApp-style) even before the first vote, when
      // pollVotes is still absent.
      pollOptions:
        type === 'poll'
          ? ((msg.pollCreationMessageV3 ?? msg.pollCreationMessage)?.options ?? [])
              .map((o: any) => o.optionName ?? o.name ?? '')
              .filter(Boolean)
          : undefined,
      pollMultiple:
        type === 'poll'
          ? (msg.pollCreationMessageV3 ?? msg.pollCreationMessage)?.selectableOptionsCount !== 1
          : undefined,
    };
  } catch {
    return null;
  }
}

/** Extract the records array from a findMessages response, oldest first. */
export function extractMessages(data: unknown): ChatMsg[] {
  const d = data as any;
  const records = d?.messages?.records ?? d?.records ?? (Array.isArray(d) ? d : []);
  return (Array.isArray(records) ? records : [])
    .map(parseMessage)
    .filter((m): m is ChatMsg => !!m)
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** Total pages reported by a findMessages response (50 records per page). */
export function extractTotalPages(data: unknown): number {
  const d = data as any;
  return Number(d?.messages?.pages ?? d?.pages ?? 1) || 1;
}

/**
 * All JIDs a conversation's messages can live under. On Evolution, incoming
 * messages are frequently stored under the contact's @lid JID while outgoing
 * ones sit under the phone JID — a thread MUST fetch and merge both, exactly
 * like the v1 app (its chatFetchMessages aliasJids logic).
 */
export function threadJids(jid: string, aliases: Map<string, string>): string[] {
  const set = new Set([jid]);
  for (const [secondary, primary] of aliases) {
    if (primary === jid) set.add(secondary);
    if (secondary === jid) set.add(primary);
  }
  return [...set];
}

export interface ThreadFetchResult {
  records: ChatMsg[];
  hasMore: boolean;
}

/**
 * Fetch a conversation across all its JIDs, `pageCount` pages deep per JID,
 * merged + deduped by message id, oldest first.
 */
export async function fetchThread(
  jids: string[],
  pageCount: number,
  fetchPage: (jid: string, page: number) => Promise<unknown>,
): Promise<ThreadFetchResult> {
  const byId = new Map<string, ChatMsg>();
  let hasMore = false;
  for (const jid of jids) {
    for (let page = 1; page <= pageCount; page++) {
      let data: unknown;
      try {
        data = await fetchPage(jid, page);
      } catch {
        break; // one jid failing must not blank the whole thread
      }
      for (const m of extractMessages(data)) byId.set(m.id, m);
      const total = extractTotalPages(data);
      if (total > pageCount) hasMore = true;
      if (page >= total) break;
    }
  }
  return {
    // fold edits onto their targets across ALL pages/jids before sorting —
    // an edit and its original can land on different pages
    records: applyEdits([...byId.values()]).sort((a, b) => a.timestamp - b.timestamp),
    hasMore,
  };
}
