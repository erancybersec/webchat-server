import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EvoResponse, EvolutionApi } from '../services/evolution.js';
import type { InstanceAccess } from '../services/instances.js';
import type { CachedContent } from '../services/msgcache.js';
import { decryptEdit, normalizeJid, SECRET_ENC_TYPE_MESSAGE_EDIT } from '../services/secretedit.js';
import { decryptPollVote, hashPollOption } from '../services/pollvote.js';

/** Just the read side of MessageCacheStore the gateway needs. */
export interface OriginalLookup {
  originalFor(id: string): CachedContent | null;
  /** every cached version of a message, oldest first (history + current). */
  versionsFor(id: string): CachedContent[];
}

/** Read side of ReadReceiptStore: when the recipient read a sent message. */
export interface ReadLookup {
  readAtFor(id: string): string | null;
}

/**
 * Shared unread state for the chat list. Implementations canonicalise the jid
 * (@lid/phone) themselves. `unreadFor` returns 1 (unread) / 0 (read) / null
 * (never tracked → fall back to Evolution's own count).
 */
export interface ChatUnreadGateway {
  unreadFor(instance: string, jid: string): number | null;
  markRead(instance: string, jid: string): void;
  markUnread(instance: string, jid: string): void;
}

/**
 * Override findChats' unreadCount with the shared, server-tracked state. Evolution's
 * own count is unreliable on this deployment (null/0 even for fresh incoming), so for
 * any chat we've tracked we replace it: 0 clears the badge for everyone once an agent
 * reads it; unread shows max(Evolution's count, 1) so lines where Evolution DOES count
 * keep their number. Chats we've never tracked keep Evolution's value untouched. Both
 * the chat's own jid and its lastMessage alt jid are consulted (events can land under
 * either). Returns the response unchanged on any non-JSON / unexpected shape.
 */
export function enrichChats(r: EvoResponse, unread: ChatUnreadGateway, instance: string): EvoResponse {
  if (!r.ok || !(r.contentType ?? '').includes('json')) return r;
  let data: any;
  try {
    data = JSON.parse(r.text);
  } catch {
    return r;
  }
  const records: unknown[] = Array.isArray(data?.records)
    ? data.records
    : Array.isArray(data?.chats)
      ? data.chats
      : Array.isArray(data)
        ? data
        : [];
  let changed = false;
  for (const rec of records as Array<Record<string, any>>) {
    if (!rec || typeof rec !== 'object') continue;
    const jid: string = rec.remoteJid ?? rec.id ?? '';
    if (!jid) continue;
    const alt: string = rec.lastMessage?.key?.remoteJidAlt ?? '';
    // unread if EITHER alias says so; read only when a tracked row says read and
    // none says unread; untracked (both null) → leave Evolution's value
    const states = [unread.unreadFor(instance, jid), alt ? unread.unreadFor(instance, alt) : null];
    const tracked = states.filter((s): s is number => s !== null);
    if (!tracked.length) continue;
    const anyUnread = tracked.some((s) => s > 0);
    const evoCount = Number(rec.unreadCount) || 0;
    const next = anyUnread ? Math.max(evoCount, 1) : 0;
    // WhatsApp-style: when a chat is unread but Evolution reports no real count
    // (the operator flagged it, or this line simply never counts), the client
    // shows a plain green dot instead of a misleading number.
    const dot = anyUnread && evoCount === 0;
    if (rec.unreadCount !== next || !!rec.unreadDot !== dot) {
      rec.unreadCount = next;
      rec.unreadDot = dot;
      changed = true;
    }
  }
  return changed ? { ...r, text: JSON.stringify(data) } : r;
}

/** The renderable text of one cached version (caption stands in for media). */
const versionText = (c: CachedContent): string => c.text || c.caption || '';

/** True when a findMessages record's status history marks it edited-in-place. */
function isEditedRecord(rec: Record<string, any>): boolean {
  const history = Array.isArray(rec.MessageUpdate) ? rec.MessageUpdate : [];
  return history.some((u: any) => u?.status === 'EDITED') || rec.status === 'EDITED';
}

/** The live (current) content of a findMessages record, for diffing vs the cache. */
function liveText(rec: Record<string, any>): string {
  const msg = rec.message ?? {};
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    ''
  );
}

/** Structured live content of a record (type + text/caption), for edit history. */
function liveContentOf(rec: Record<string, any>): CachedContent | null {
  const msg = rec.message ?? {};
  if (typeof msg.conversation === 'string' && msg.conversation)
    return { type: 'text', text: msg.conversation, caption: '' };
  if (msg.extendedTextMessage?.text)
    return { type: 'text', text: String(msg.extendedTextMessage.text), caption: '' };
  if (msg.imageMessage) return { type: 'image', text: '', caption: String(msg.imageMessage.caption ?? '') };
  if (msg.videoMessage) return { type: 'video', text: '', caption: String(msg.videoMessage.caption ?? '') };
  if (msg.documentMessage)
    return { type: 'document', text: '', caption: String(msg.documentMessage.caption ?? '') };
  return null;
}

/** Write recovered edit content back onto the live record's existing content holder. */
function applyLiveContent(rec: Record<string, any>, c: CachedContent): void {
  const msg = rec.message;
  if (!msg) return;
  if (msg.imageMessage) msg.imageMessage.caption = c.caption;
  else if (msg.videoMessage) msg.videoMessage.caption = c.caption;
  else if (msg.documentMessage) msg.documentMessage.caption = c.caption;
  else if (msg.extendedTextMessage) msg.extendedTextMessage.text = c.text;
  else if (typeof msg.conversation === 'string') msg.conversation = c.text || c.caption;
  else msg.conversation = c.text || c.caption;
}

/** Sender JIDs a record's key can carry (lid + phone forms), for the secret-key derivation. */
function recordSenders(key: Record<string, any> | undefined): string[] {
  const k = key ?? {};
  return [k.remoteJid, k.remoteJidAlt, k.participant, k.participantAlt].filter(
    (s): s is string => typeof s === 'string' && !!s,
  );
}

/**
 * Recover edits that arrived END-TO-END ENCRYPTED. Some WhatsApp edits (media
 * captions, HD photos) are delivered as a `secretEncryptedMessage`
 * (secretEncType MESSAGE_EDIT) that Evolution stores raw and cannot decrypt — so
 * the original record keeps its pre-edit text with no EDITED marker. The new
 * text is derivable from the ORIGINAL message's `messageContextInfo.messageSecret`
 * (Evolution does keep that on the original record). For each such edit whose
 * original is present in the same response, we decrypt the new content, overwrite
 * the live record in place, and attach the pre-edit text as `editHistory` so the
 * chat shows the current text with a clickable "Edited" — matching how the
 * already-decrypted in-place edits render. Mutates `records`; returns true if any
 * record changed. Edits whose original (and thus secret) isn't on this page are
 * left untouched (the chat keeps showing the original, as before).
 */
function applyEncryptedEdits(records: Array<Record<string, any>>): boolean {
  const byId = new Map<string, Record<string, any>>();
  const secretById = new Map<string, Buffer>();
  for (const rec of records) {
    const id = rec?.key?.id;
    if (typeof id !== 'string' || !id) continue;
    byId.set(id, rec);
    const s = rec.message?.messageContextInfo?.messageSecret;
    if (typeof s === 'string' && s) {
      try {
        secretById.set(id, Buffer.from(s, 'base64'));
      } catch {
        /* malformed base64 — skip */
      }
    }
  }
  interface EncEdit {
    iv: Buffer;
    payload: Buffer;
    ts: number;
    senders: string[];
  }
  const editsByTarget = new Map<string, EncEdit[]>();
  for (const rec of records) {
    const sem = rec?.message?.secretEncryptedMessage;
    if (!sem || Number(sem.secretEncType) !== SECRET_ENC_TYPE_MESSAGE_EDIT) continue;
    const targetId = sem.targetMessageKey?.id;
    if (typeof targetId !== 'string' || !targetId) continue;
    if (typeof sem.encIv !== 'string' || typeof sem.encPayload !== 'string') continue;
    let iv: Buffer;
    let payload: Buffer;
    try {
      iv = Buffer.from(sem.encIv, 'base64');
      payload = Buffer.from(sem.encPayload, 'base64');
    } catch {
      continue;
    }
    const senders = [...recordSenders(rec.key), ...recordSenders(sem.targetMessageKey)];
    const arr = editsByTarget.get(targetId) ?? [];
    arr.push({ iv, payload, ts: Number(rec.messageTimestamp) || 0, senders });
    editsByTarget.set(targetId, arr);
  }
  if (!editsByTarget.size) return false;
  let changed = false;
  for (const [targetId, edits] of editsByTarget) {
    const target = byId.get(targetId);
    const secret = secretById.get(targetId);
    if (!target?.message || !secret) continue; // no original (or its secret) on this page → can't decrypt
    const original = liveContentOf(target);
    const candidates = [...new Set([...recordSenders(target.key), ...edits.flatMap((e) => e.senders)])];
    const decoded: CachedContent[] = [];
    for (const e of [...edits].sort((a, b) => a.ts - b.ts)) {
      const c = decryptEdit(secret, { origMsgId: targetId, encIv: e.iv, encPayload: e.payload }, candidates);
      if (c) decoded.push(c);
    }
    if (!decoded.length) continue;
    const current = decoded[decoded.length - 1]!;
    applyLiveContent(target, current);
    // history = the pre-edit original plus any superseded edits, current excluded, deduped
    const cur = versionText(current);
    const seen = new Set<string>();
    const history: CachedContent[] = [];
    for (const p of [original, ...decoded.slice(0, -1)]) {
      const t = p ? versionText(p) : '';
      if (!t || t === cur || seen.has(t)) continue;
      seen.add(t);
      history.push(p!);
    }
    if (history.length) target.editHistory = history;
    changed = true;
  }
  return changed;
}

/** Per-option tally + voters attached to a poll-creation record. */
export interface PollTally {
  total: number;
  options: { name: string; count: number; voters: PollVoter[] }[];
}

/** One voter under a poll option: display name + phone number (either may be ''). */
export interface PollVoter {
  /** the voter's pushName; '' when WhatsApp gave none (then the number stands in) */
  name: string;
  /** the voter's phone number (digits, no @-suffix); '' when only an opaque @lid is known */
  number: string;
}

/** The option names of a poll-creation record, in order (V3 or legacy). */
function pollOptions(rec: Record<string, any>): string[] {
  const poll = rec?.message?.pollCreationMessageV3 ?? rec?.message?.pollCreationMessage;
  const opts = Array.isArray(poll?.options) ? poll.options : [];
  return opts.map((o: any) => String(o?.optionName ?? o?.name ?? '')).filter(Boolean);
}

/**
 * The caster's phone number for a vote (digits only, no @-suffix), or '' when
 * only an opaque @lid is known. WhatsApp keys a vote by @lid but rides the real
 * number alongside as its `@s.whatsapp.net` twin: in a GROUP that's
 * participant/participantAlt (remoteJid is the group jid), in a 1:1 it's
 * remoteJid/remoteJidAlt. WhatsApp shows this number beside the voter, so we
 * surface it on the tally (recoverable for ~98% of votes on prod).
 */
function voterNumber(key: Record<string, any> | undefined): string {
  const pair =
    key?.participant || key?.participantAlt
      ? [key.participant, key.participantAlt]
      : [key?.remoteJid, key?.remoteJidAlt];
  for (const j of pair) {
    if (typeof j === 'string' && j.endsWith('@s.whatsapp.net')) {
      const local = j.split('@')[0]!.split(':')[0]!; // strip any :device suffix
      if (local) return local;
    }
  }
  return '';
}

/**
 * Tally poll votes onto each poll-creation record as `pollVotes`. A vote
 * (`pollUpdateMessage`) reaches us one of two ways:
 *  - Evolution already decrypted it → `vote.selectedOptions` holds the chosen
 *    option NAMES; we use them directly.
 *  - it arrived encrypted (empty `selectedOptions`, just `encIv`/`encPayload`) —
 *    these are the freshest live votes and the `[pollUpdateMessage]` placeholders
 *    the user sees. We decrypt them against the poll's `messageSecret` (on the
 *    poll-creation record) into option-name hashes and map those back to options.
 * A voter can revote, so only their LATEST vote (by timestamp) counts. Mutates the
 * poll records (adds `pollVotes`); the vote records themselves are left for the
 * client to drop. Returns true if any poll gained a tally.
 */
function applyPollVotes(
  records: Array<Record<string, any>>,
  /** extra creator-side jids for vote decryption (e.g. group participant lids) */
  creatorJids?: string[],
): boolean {
  interface Poll {
    /** every copy of this poll seen (page + off-page mirror) — tally lands on all */
    recs: Array<Record<string, any>>;
    options: string[];
    nameToIdx: Map<string, number>;
    hashToIdx: Map<string, number>;
    secret: Buffer | null;
    creatorSenders: string[];
    /** voterKey → { ts, idxs, name, number } — latest vote wins */
    votes: Map<string, { ts: number; idxs: number[]; name: string; number: string }>;
  }
  const polls = new Map<string, Poll>();
  for (const rec of records) {
    if (!(rec?.message?.pollCreationMessageV3 || rec?.message?.pollCreationMessage)) continue;
    const id = rec.key?.id;
    if (typeof id !== 'string' || !id) continue;
    let secret: Buffer | null = null;
    const s = rec.message?.messageContextInfo?.messageSecret;
    if (typeof s === 'string' && s) {
      try {
        secret = Buffer.from(s, 'base64');
      } catch {
        /* malformed — leave null, encrypted votes for this poll stay hidden */
      }
    }
    // A poll is stored as SEVERAL copies of the same key.id, and no single copy
    // is complete: our own group poll's fromMe:true copy carries NO participant
    // (so the creator's @lid — which vote decryption needs — is missing from its
    // key), while the fromMe:false mirror copy has it. Merge every copy: union
    // the sender jids, keep the first secret found, attach the tally to all.
    const existing = polls.get(id);
    if (existing) {
      existing.recs.push(rec);
      existing.creatorSenders.push(...recordSenders(rec.key));
      if (!existing.secret) existing.secret = secret;
      continue;
    }
    const options = pollOptions(rec);
    if (!options.length) continue;
    // Voting clients don't hash the option name uniformly: iOS hashes the
    // TRIMMED name while others hash it verbatim (verified on prod — an option
    // authored "אני!! " with a trailing space made every iPhone vote
    // unmatchable, for Evolution AND the real WhatsApp app). Index both forms;
    // verbatim names win when a trimmed twin would collide.
    const nameToIdx = new Map(options.map((o, i) => [o, i] as const));
    const hashToIdx = new Map(options.map((o, i) => [hashPollOption(o), i] as const));
    options.forEach((o, i) => {
      const t = o.trim();
      if (t === o) return;
      if (!nameToIdx.has(t)) nameToIdx.set(t, i);
      const th = hashPollOption(t);
      if (!hashToIdx.has(th)) hashToIdx.set(th, i);
    });
    polls.set(id, {
      recs: [rec],
      options,
      nameToIdx,
      hashToIdx,
      secret,
      creatorSenders: recordSenders(rec.key),
      votes: new Map(),
    });
  }
  if (!polls.size) return false;

  // Collapse multi-device duplicates of a vote: in a 1:1 the SAME vote (same
  // key.id) is stored once under the voter's @lid and once under our own
  // account's @lid (different remoteJid → different voterKey → would otherwise
  // count twice). Keep one record per id, preferring the remote (fromMe:false)
  // copy so the vote is attributed to the voter, not us. Group votes and
  // revotes carry distinct ids, so this only removes true duplicates.
  const voteRecs = new Map<string, Record<string, any>>();
  let idless = 0;
  for (const rec of records) {
    if (!rec?.message?.pollUpdateMessage) continue;
    const vid =
      typeof rec.key?.id === 'string' && rec.key.id ? rec.key.id : ` idless${idless++}`;
    const cur = voteRecs.get(vid);
    if (!cur || (cur.key?.fromMe === true && rec.key?.fromMe === false)) voteRecs.set(vid, rec);
  }

  for (const rec of voteRecs.values()) {
    const upd = rec?.message?.pollUpdateMessage;
    if (!upd) continue;
    const pollId = upd.pollCreationMessageKey?.id;
    const poll = typeof pollId === 'string' ? polls.get(pollId) : undefined;
    if (!poll) continue; // poll creation not on this page → nothing to attach to
    const voterSenders = recordSenders(rec.key);
    // identify the voter for revote-dedup: in a GROUP that's the participant (the
    // shared group remoteJid would collapse everyone into one), in a 1:1 it's the
    // remoteJid. Fall back to pushName so an id-less vote still counts once.
    const voterKey =
      normalizeJid(rec.key?.participant ?? rec.key?.participantAlt ?? rec.key?.remoteJid ?? '') ||
      (rec.pushName ?? '') ||
      '?';
    const ts = Number(rec.messageTimestamp) || 0;
    const prev = poll.votes.get(voterKey);
    if (prev && prev.ts > ts) continue; // an even-later vote already recorded

    let idxs: number[] | null = null;
    const selected: unknown = upd.vote?.selectedOptions;
    if (Array.isArray(selected) && selected.length) {
      // Evolution already decrypted → option names (trimmed fallback for the
      // same client-side whitespace drift the hash index covers)
      idxs = selected
        .map((n) => poll.nameToIdx.get(String(n)) ?? poll.nameToIdx.get(String(n).trim()))
        .filter((i): i is number => i != null);
    } else if (poll.secret && typeof upd.vote?.encIv === 'string' && typeof upd.vote?.encPayload === 'string') {
      try {
        const hashes = decryptPollVote(
          poll.secret,
          {
            encIv: Buffer.from(upd.vote.encIv, 'base64'),
            encPayload: Buffer.from(upd.vote.encPayload, 'base64'),
            pollMsgId: pollId,
          },
          [...poll.creatorSenders, ...voterSenders],
          creatorJids,
        );
        if (hashes) idxs = hashes.map((h) => poll.hashToIdx.get(h)).filter((i): i is number => i != null);
      } catch {
        /* decryption failed — treat as no recoverable selection */
      }
    }
    if (!idxs) continue; // couldn't recover this vote — leave prior (if any) in place
    poll.votes.set(voterKey, {
      ts,
      idxs,
      name: String(rec.pushName ?? '').trim(),
      number: voterNumber(rec.key),
    });
  }

  let changed = false;
  for (const poll of polls.values()) {
    if (!poll.votes.size) continue;
    const buckets = poll.options.map((name) => ({ name, count: 0, voters: [] as PollVoter[] }));
    let total = 0;
    for (const v of poll.votes.values()) {
      if (!v.idxs.length) continue;
      total++;
      for (const i of v.idxs) {
        if (i < 0 || i >= buckets.length) continue;
        buckets[i]!.count++;
        buckets[i]!.voters.push({ name: v.name, number: v.number });
      }
    }
    const tally: PollTally = { total, options: buckets };
    for (const rec of poll.recs) rec.pollVotes = tally;
    changed = true;
  }
  return changed;
}

/**
 * Enrich a findMessages response from the server-side content cache:
 *  - deletes: a delete-for-everyone nulls `message` (that's how the client
 *    detects a deletion), which is also when the original text is missing — so
 *    attach the cached original under `deletedOriginal`.
 *  - edits: this Evolution build overwrites an edited message in place and only
 *    marks the history 'EDITED', so the prior versions are lost. For each edited
 *    record we attach `editHistory` — the cached versions that DIFFER from the
 *    live (current) text, oldest first, deduped — for the client to reveal.
 *  - read receipts: this build stores no timestamp on the READ status, so for
 *    each message the recipient read we attach `readAt` (ISO) from the live-ack
 *    cache — the chat shows "Seen at HH:MM" instead of a bare blue tick.
 * The live record is never rewritten, so deletion/edit detection is untouched.
 * Returns the response unchanged on any non-JSON / unexpected shape, or when
 * nothing was enriched.
 */
export function enrichMessages(
  r: EvoResponse,
  cache: OriginalLookup,
  reads?: ReadLookup,
  /**
   * Learn a lid↔phone alias from each record's key. A `@lid`-only chat whose
   * recent messages dropped the `remoteJidAlt` link (WhatsApp's LID-first
   * addressing) has no phone twin for the chat list to dedup against, so it
   * shows bare LID digits. Historical messages of the SAME thread still carry
   * the phone number under `remoteJidAlt`; feeding those pairs to the alias map
   * here (when the thread is opened) lets the list recover the real number.
   * Pure side effect — never affects whether the response is rewritten.
   */
  onAlias?: (jid: string, altJid: string) => void,
  /**
   * Extra poll records for polls on this page, fetched separately: off-page
   * `pollUpdateMessage` votes (findMessages pages at 50, so a busy poll's votes
   * can land on other pages) and the polls' other `pollCreation*` copies (whose
   * keys can carry creator jids the on-page copy lacks — needed to decrypt
   * votes). They feed the tally only; they are NOT added to the records the
   * client renders (vote bubbles are dropped client-side anyway). Same vote
   * appearing here and on the page is harmless — the tally keeps one vote per
   * voter.
   */
  extraVoteRecords?: Array<Record<string, any>>,
  /**
   * Extra creator-side jids for poll-vote decryption — in practice the group's
   * participant lids. Needed because our OWN group poll is returned with a
   * participant-less fromMe:true key (findMessages dedupes away the mirror copy
   * that has it), and vote decryption requires the creator's @lid, which
   * Evolution exposes nowhere else (fetchInstances only has the phone form).
   */
  pollCreatorJids?: string[],
): EvoResponse {
  if (!r.ok || !(r.contentType ?? '').includes('json')) return r;
  let data: any;
  try {
    data = JSON.parse(r.text);
  } catch {
    return r;
  }
  const records: unknown[] = Array.isArray(data?.messages?.records)
    ? data.messages.records
    : Array.isArray(data?.records)
      ? data.records
      : Array.isArray(data)
        ? data
        : [];
  // recover any end-to-end-encrypted edits before the per-record enrichment, so
  // the loop below (and the client) sees the corrected content + edit history
  let changed = applyEncryptedEdits(records as Array<Record<string, any>>);
  // tally poll votes (plaintext where Evolution decrypted, else we decrypt) onto
  // each poll-creation record, so the client renders live results instead of a
  // standalone [pollUpdateMessage] bubble per vote. extraVoteRecords (fetched
  // off-page) only feed the count — they're not spliced into the page records.
  const pollSource =
    extraVoteRecords && extraVoteRecords.length
      ? [...(records as Array<Record<string, any>>), ...extraVoteRecords]
      : (records as Array<Record<string, any>>);
  if (applyPollVotes(pollSource, pollCreatorJids)) changed = true;
  for (const rec of records as Array<Record<string, any>>) {
    if (!rec || typeof rec !== 'object') continue;
    const id = rec.key?.id ?? '';
    if (onAlias) {
      const jid = rec.key?.remoteJid;
      const alt = rec.key?.remoteJidAlt;
      if (typeof jid === 'string' && jid && typeof alt === 'string' && alt && jid !== alt)
        onAlias(jid, alt);
    }
    // when did the recipient read this? (own sent messages only get a READ ack)
    if (reads && id && rec.key?.fromMe) {
      const readAt = reads.readAtFor(id);
      if (readAt) {
        rec.readAt = readAt;
        changed = true;
      }
    }
    if (rec.message == null) {
      const original = cache.originalFor(id);
      if (original) {
        rec.deletedOriginal = original;
        changed = true;
      }
      continue;
    }
    if (isEditedRecord(rec)) {
      const current = liveText(rec);
      const seen = new Set<string>();
      const prior: CachedContent[] = [];
      // versionsFor is oldest→newest; drop any version equal to the current
      // text (and adjacent/repeat dupes) so only genuinely prior copies show.
      for (const v of cache.versionsFor(id)) {
        const t = versionText(v);
        if (!t || t === current || seen.has(t)) continue;
        seen.add(t);
        prior.push(v);
      }
      if (prior.length) {
        rec.editHistory = prior;
        changed = true;
      }
    }
  }
  return changed ? { ...r, text: JSON.stringify(data) } : r;
}

/**
 * Fetch every poll record for one thread, across pages (findMessages pages at
 * 50): the `pollUpdateMessage` votes, plus the `pollCreation*` copies of each
 * poll. Used to complete a poll's tally when its votes — or the poll itself —
 * span more than the one page the client requested. The creation copies also
 * matter for DECRYPTION: a page often carries only the fromMe:true copy of our
 * own group poll, whose key lacks the creator's @lid — the fromMe:false mirror
 * copy fetched here supplies it (applyPollVotes unions senders across copies).
 * Evolution's `where` accepts a `messageType` filter (verified live). Capped at
 * `maxPages` so a runaway poll can't fan out unbounded; logs when it truncates.
 */
async function fetchThreadPollVotes(
  evo: EvolutionApi,
  instanceEncoded: string,
  remoteJid: string,
  maxPages = 20,
): Promise<Array<Record<string, any>>> {
  const out: Array<Record<string, any>> = [];
  const sweep = async (where: Record<string, unknown>, label: string) => {
    for (let page = 1; page <= maxPages; page++) {
      let r: EvoResponse;
      try {
        r = await evo.call(`/chat/findMessages/${instanceEncoded}`, { where, page });
      } catch {
        break; // upstream hiccup — tally with what we have
      }
      if (!r.ok || !(r.contentType ?? '').includes('json')) break;
      let d: any;
      try {
        d = JSON.parse(r.text);
      } catch {
        break;
      }
      const recs: unknown[] = Array.isArray(d?.messages?.records) ? d.messages.records : [];
      out.push(...(recs as Array<Record<string, any>>));
      const pages = Number(d?.messages?.pages) || 1;
      if (page >= pages || !recs.length) break;
      if (page === maxPages)
        console.warn(`[polls] vote fetch (${label}) for ${remoteJid} hit ${maxPages}-page cap (${pages} pages); tally may undercount`);
    }
  };
  // Votes stored under the chat jid itself: groups (shared group jid) and 1:1s
  // where the vote landed under the same jid form as the poll.
  await sweep({ key: { remoteJid }, messageType: 'pollUpdateMessage' }, 'remoteJid');
  // In a 1:1 the voter's vote is often stored under THEIR @lid jid, with
  // `remoteJidAlt` pointing back at this chat's (phone) jid — the lid↔phone
  // split. findMessages keys on `remoteJid` only, so that sweep misses them;
  // Evolution does honour a `remoteJidAlt` filter, so a second sweep recovers
  // them. (For a group jid this matches nothing extra — group votes carry no
  // alt — so it's a cheap empty query, no regression.) Dupes across the two
  // sweeps collapse later by message id / voter.
  await sweep({ key: { remoteJidAlt: remoteJid }, messageType: 'pollUpdateMessage' }, 'remoteJidAlt');
  // Every copy of the thread's poll creations (one messageType per query —
  // Evolution's filter takes a single value). These feed sender-union +
  // cross-page tallies only; they are never spliced into the rendered page.
  await sweep({ key: { remoteJid }, messageType: 'pollCreationMessageV3' }, 'creationV3');
  await sweep({ key: { remoteJid }, messageType: 'pollCreationMessage' }, 'creation');
  return out;
}

/**
 * The jids (lid + phone forms) of a group's participants. Fed to the poll-vote
 * decryptor as creator-side candidates: a group poll's creator is always a
 * member, and this list is the ONLY place Evolution exposes our own account's
 * @lid — which decrypting votes on our own polls requires (their fromMe:true
 * key carries no participant, and findMessages dedupes away the mirror copy
 * that does). Returns [] on any upstream error — votes then tally exactly as
 * before this lookup existed.
 */
async function fetchGroupParticipantJids(
  evo: EvolutionApi,
  instanceEncoded: string,
  groupJid: string,
): Promise<string[]> {
  try {
    const r = await evo.call(
      `/group/participants/${instanceEncoded}?groupJid=${encodeURIComponent(groupJid)}`,
      undefined,
      'GET',
    );
    if (!r.ok || !(r.contentType ?? '').includes('json')) return [];
    const d = JSON.parse(r.text);
    const ps: unknown[] = Array.isArray(d?.participants) ? d.participants : Array.isArray(d) ? d : [];
    const out: string[] = [];
    for (const p of ps as Array<Record<string, any>>) {
      for (const j of [p?.id, p?.phoneNumber, p?.jid]) {
        if (typeof j === 'string' && j.includes('@')) out.push(j);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Typed chat gateway: the frontend never talks to Evolution directly — these
 * routes proxy the chat surface with the server-side apikey attached.
 * Each route maps to one specific Evolution endpoint (no generic tunneling).
 * Every route resolves the target instance per request (`?instance=`,
 * default = Settings) and enforces the agent's instance grants.
 */
export function registerGateway(
  app: FastifyInstance,
  evo: EvolutionApi,
  access: InstanceAccess,
  msgCache?: OriginalLookup,
  /** stamp who deleted a message for everyone, after Evolution confirms it */
  recordDelete?: (messageId: string, req: FastifyRequest, chatJid: string) => void,
  /** stamp who edited a message, after Evolution confirms it */
  recordEdit?: (messageId: string, req: FastifyRequest, chatJid: string) => void,
  /** when the recipient read each sent message (live-ack cache) */
  reads?: ReadLookup,
  /** shared server-side unread state for the chat list */
  chatUnread?: ChatUnreadGateway,
  /** broadcast an app event (e.g. CHAT_READ) so other agents' lists refresh */
  emit?: (event: string, data: unknown) => void,
  /**
   * Learn a lid↔phone alias seen on a fetched thread (raw instance + the two
   * jids). Caller decides whether to honour it (e.g. only the default
   * instance) — see app.ts wiring. Lets the chat list recover the real number
   * of a `@lid`-only contact whose recent messages dropped the alt link.
   */
  learnAlias?: (rawInstance: string, jid: string, altJid: string) => void,
): void {
  const mirror = (reply: FastifyReply, r: EvoResponse) =>
    reply
      .code(r.status)
      .type(r.contentType || 'application/json')
      .send(r.text);

  /** Resolved+encoded instance, or null after sending the 403. */
  const inst = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const i = access.resolve(req);
    if (i == null) {
      void reply.code(403).send({ error: 'instance not allowed' });
      return null;
    }
    return encodeURIComponent(i);
  };

  // Conversation list. Enriched with the shared unread state — Evolution's own
  // unreadCount is unreliable here, so a tracked chat's badge is the team's
  // (server-side) truth instead.
  app.get('/api/chats', async (req, reply) => {
    const raw = access.resolve(req);
    if (raw == null) return reply.code(403).send({ error: 'instance not allowed' });
    const res = await evo.call(`/chat/findChats/${encodeURIComponent(raw)}`, {});
    return mirror(reply, chatUnread ? enrichChats(res, chatUnread, raw) : res);
  });

  // Contact book (names, avatars; lid→number aliases are derived client-side).
  app.get('/api/contacts', async (req, reply) => {
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(reply, await evo.call(`/chat/findContacts/${i}`, {}));
  });

  // All groups. findChats pushName is unreliable for groups — subjects here
  // are authoritative.
  app.get('/api/groups', async (req, reply) => {
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(
      reply,
      await evo.call(`/group/fetchAllGroups/${i}?getParticipants=false`, undefined, 'GET'),
    );
  });

  // Messages of one conversation. POST because JIDs are awkward in paths and
  // the query carries pagination.
  app.post('/api/messages/find', async (req, reply) => {
    const b = (req.body ?? {}) as { remoteJid?: string; page?: number; offset?: number };
    if (!b.remoteJid) return reply.code(400).send({ error: 'remoteJid required' });
    const raw = access.resolve(req);
    if (raw == null) return reply.code(403).send({ error: 'instance not allowed' });
    const i = encodeURIComponent(raw);
    const body: Record<string, unknown> = { where: { key: { remoteJid: b.remoteJid } } };
    if (b.page != null) body.page = b.page;
    if (b.offset != null) body.offset = b.offset;
    const res = await evo.call(`/chat/findMessages/${i}`, body);
    // If this page carries a poll, its votes (or the poll's other copies, which
    // can hold creator jids needed to decrypt them) may sit on other pages —
    // findMessages caps at 50. Pull the whole thread's poll records so the
    // tally is complete, not just this page's slice. Cheap string probe avoids
    // the extra round-trips on the vast majority of pages.
    const extraVotes =
      res.ok && res.text.includes('pollCreationMessage')
        ? await fetchThreadPollVotes(evo, i, b.remoteJid)
        : undefined;
    // Group pages with a poll also pull the member list: decrypting a vote on
    // our OWN poll needs our account's @lid, which only appears there.
    const creatorJids =
      extraVotes && b.remoteJid.endsWith('@g.us')
        ? await fetchGroupParticipantJids(evo, i, b.remoteJid)
        : undefined;
    // restore deleted originals + prior edit versions + read times from caches,
    // and learn any lid↔phone alias the thread's history carries (so a LID-only
    // chat row can later show the real number)
    const onAlias = learnAlias ? (j: string, alt: string) => learnAlias(raw, j, alt) : undefined;
    return mirror(
      reply,
      msgCache ? enrichMessages(res, msgCache, reads, onAlias, extraVotes, creatorJids) : res,
    );
  });

  // Decrypt/fetch received media (.enc) as base64.
  app.post('/api/media', async (req, reply) => {
    const b = (req.body ?? {}) as { message?: unknown; convertToMp4?: boolean };
    if (!b.message) return reply.code(400).send({ error: 'message required' });
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(
      reply,
      await evo.call(`/chat/getBase64FromMediaMessage/${i}`, {
        message: b.message,
        convertToMp4: !!b.convertToMp4,
      }),
    );
  });

  // Edit a sent message (WhatsApp allows ~15 minutes).
  app.post('/api/messages/edit', async (req, reply) => {
    const b = (req.body ?? {}) as { remoteJid?: string; messageId?: string; text?: string };
    if (!b.remoteJid || !b.messageId || !b.text)
      return reply.code(400).send({ error: 'remoteJid, messageId and text required' });
    const i = inst(req, reply);
    if (!i) return reply;
    const res = await evo.call(`/chat/updateMessage/${i}`, {
      number: b.remoteJid.split('@')[0],
      key: { id: b.messageId, remoteJid: b.remoteJid, fromMe: true },
      text: b.text,
    });
    // attribute the edit only once Evolution accepted it
    if (res.ok) recordEdit?.(b.messageId, req, b.remoteJid);
    return mirror(reply, res);
  });

  // Mark incoming messages of a chat as read.
  app.post('/api/chats/read', async (req, reply) => {
    const b = (req.body ?? {}) as {
      readMessages?: Array<{ remoteJid: string; fromMe: boolean; id: string }>;
      chat?: string;
    };
    const raw = access.resolve(req);
    if (raw == null) return reply.code(403).send({ error: 'instance not allowed' });
    // List-level "mark as read": a chat-list row carries no message ids, so skip
    // Evolution's per-message markMessageAsRead and just clear the shared unread
    // badge for the whole team — the inverse of /api/chats/unread.
    if ((!Array.isArray(b.readMessages) || !b.readMessages.length) && b.chat) {
      if (chatUnread) {
        chatUnread.markRead(raw, b.chat);
        emit?.('CHAT_READ', { instance: raw, jid: b.chat });
      }
      return reply.send({ ok: true });
    }
    if (!Array.isArray(b.readMessages) || !b.readMessages.length)
      return reply.code(400).send({ error: 'readMessages or chat required' });
    const res = await evo.call(`/chat/markMessageAsRead/${encodeURIComponent(raw)}`, {
      readMessages: b.readMessages,
    });
    // clear the shared unread badge for the whole team, then nudge other agents'
    // lists to refetch so the badge drops on their screens too
    if (res.ok && chatUnread) {
      for (const jid of new Set(b.readMessages.map((m) => m.remoteJid).filter(Boolean))) {
        chatUnread.markRead(raw, jid);
        emit?.('CHAT_READ', { instance: raw, jid });
      }
    }
    return mirror(reply, res);
  });

  // Mark a chat unread (the "deal with this later" flag).
  app.post('/api/chats/unread', async (req, reply) => {
    const b = (req.body ?? {}) as { chat?: string; lastMessage?: unknown };
    if (!b.chat) return reply.code(400).send({ error: 'chat required' });
    const raw = access.resolve(req);
    if (raw == null) return reply.code(403).send({ error: 'instance not allowed' });
    const body: Record<string, unknown> = { chat: b.chat };
    if (b.lastMessage) body.lastMessage = b.lastMessage;
    const res = await evo.call(`/chat/markChatUnread/${encodeURIComponent(raw)}`, body);
    // The shared badge is OUR source of truth (Evolution's own unreadCount is
    // unreliable here), so force it regardless of whether Evolution accepted the
    // call — a list row carries no lastMessage, which Evolution may reject.
    if (chatUnread) {
      chatUnread.markUnread(raw, b.chat);
      emit?.('CHAT_READ', { instance: raw, jid: b.chat });
    }
    return mirror(reply, res);
  });

  // Block / unblock a contact.
  app.post('/api/contacts/block', async (req, reply) => {
    const b = (req.body ?? {}) as { number?: string; status?: string };
    if (!b.number || (b.status !== 'block' && b.status !== 'unblock'))
      return reply.code(400).send({ error: 'number and status (block|unblock) required' });
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(
      reply,
      await evo.call(`/message/updateBlockStatus/${i}`, {
        number: b.number,
        status: b.status,
      }),
    );
  });

  // Send our presence (typing / recording) to a chat. v1 used updatePresence —
  // the endpoint proven against this Evolution version.
  app.post('/api/presence', async (req, reply) => {
    const b = (req.body ?? {}) as { number?: string; presence?: string; delay?: number };
    if (!b.number || !b.presence)
      return reply.code(400).send({ error: 'number and presence required' });
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(
      reply,
      await evo.call(`/chat/updatePresence/${i}`, {
        number: b.number,
        presence: b.presence,
        delay: b.delay ?? 1200,
      }),
    );
  });

  // Archive / unarchive a chat.
  app.post('/api/chats/archive', async (req, reply) => {
    const b = (req.body ?? {}) as { chat?: string; archive?: boolean; lastMessage?: unknown };
    if (!b.chat) return reply.code(400).send({ error: 'chat required' });
    const i = inst(req, reply);
    if (!i) return reply;
    const body: Record<string, unknown> = { chat: b.chat, archive: b.archive !== false };
    if (b.lastMessage) body.lastMessage = b.lastMessage;
    return mirror(reply, await evo.call(`/chat/archiveChat/${i}`, body));
  });

  // Delete a message for everyone. Evolution v2 exposes this as
  // DELETE /chat/deleteMessageForEveryone with the message key fields in the
  // body (id/remoteJid/fromMe[/participant]) — NOT the old POST
  // /message/deleteMessage, which 404s on this build.
  app.post('/api/messages/delete', async (req, reply) => {
    const b = (req.body ?? {}) as {
      remoteJid?: string;
      messageId?: string;
      fromMe?: boolean;
      participant?: string;
    };
    if (!b.remoteJid || !b.messageId)
      return reply.code(400).send({ error: 'remoteJid and messageId required' });
    const i = inst(req, reply);
    if (!i) return reply;
    const body: Record<string, unknown> = {
      id: b.messageId,
      remoteJid: b.remoteJid,
      fromMe: b.fromMe !== false,
    };
    // group deletes need the original sender to identify the message
    if (b.participant) body.participant = b.participant;
    const res = await evo.call(`/chat/deleteMessageForEveryone/${i}`, body, 'DELETE');
    // attribute the delete only once Evolution accepted it
    if (res.ok) recordDelete?.(b.messageId, req, b.remoteJid);
    return mirror(reply, res);
  });
}
