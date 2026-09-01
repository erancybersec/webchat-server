import { useEffect, useRef, useState } from 'react';
import { agentBadgeClass, agentLabel } from '../../lib/agents';
import type { ChatMsg, PollVoter } from '../../lib/chatModel';
import { renderRichText } from '../../lib/richText';
import MediaContent from './MediaContent';

const SWIPE_REPLY_PX = 60; // drag distance that fires a reply (v1 parity)
const SWIPE_MAX_PX = 84;
const EDIT_WINDOW_S = 15 * 60; // WhatsApp allows editing for ~15 minutes
const REACT_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

// label for a deleted message whose original had no text (a bare photo, etc.)
const DELETED_MEDIA_LABELS: Record<string, string> = {
  image: '📷 Photo',
  video: '🎥 Video',
  audio: '🎤 Voice message',
  document: '📄 Document',
  sticker: '🏷 Sticker',
  location: '📍 Location',
  contact: '👤 Contact',
  poll: '📊 Poll',
};

/** "21:04" if deleted today, else "Mar 3, 21:04" — the moment of the delete. */
function formatDeletedTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export interface MsgReaction {
  emoji: string;
  fromMe: boolean;
  /** resolved display name of who reacted ("You", a contact name, or number) */
  who: string;
  /** when they reacted (seconds since epoch) */
  at: number;
}

export interface BubbleProps {
  msg: ChatMsg;
  senderName: string;
  /** which agent sent this own message (agent identification, Settings toggle) */
  agentTag?: { email: string; name: string; color: string };
  /** agent who deleted this message for everyone via the app — shown in the tombstone */
  deletedByAgent?: { name: string };
  /** ISO time the message was deleted for everyone (app deletes only) — shown in the tombstone */
  deletedAt?: string;
  /** agent who edited this message via the app — shown in the edit-history popup */
  editedByAgent?: { name: string };
  /** false when this message continues a run from the same sender */
  groupStart?: boolean;
  /** aggregated reactions targeting this message */
  reactions?: MsgReaction[];
  onReply: (msg: ChatMsg) => void;
  onEdit: (msg: ChatMsg, text: string) => void;
  onReact: (msg: ChatMsg, emoji: string) => void;
  onDelete: (msg: ChatMsg) => void;
  onForward: (msg: ChatMsg) => void;
  /** enter multi-select mode starting with this message checked */
  onSelect: (msg: ChatMsg) => void;
  /** jump to the quoted message (id of the original) */
  onQuoteClick?: (id: string) => void;
  /** re-send a failed optimistic message */
  onRetry?: (msg: ChatMsg) => void;
}

interface EmojiChip {
  emoji: string;
  count: number;
  mine: boolean;
  /** who reacted with this emoji, for the hover tooltip */
  reactors: Array<{ who: string; at: number }>;
}

/** Collapse deduped reactions into per-emoji chips: ❤️ ×3, one of them mine. */
function aggregate(reactions: MsgReaction[]): EmojiChip[] {
  const byEmoji = new Map<string, EmojiChip>();
  for (const r of reactions) {
    const e = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false, reactors: [] };
    e.count++;
    e.mine ||= r.fromMe;
    e.reactors.push({ who: r.who, at: r.at });
    byEmoji.set(r.emoji, e);
  }
  return [...byEmoji.values()];
}

/** "Alice · 14:32, You · 14:35" — who reacted with this emoji, and when. */
function reactorTitle(chip: EmojiChip): string {
  return chip.reactors
    .map((r) => {
      const when = r.at
        ? new Date(r.at * 1000).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '';
      return when ? `${r.who} · ${when}` : r.who;
    })
    .join('\n');
}

/**
 * WhatsApp-style delivery ticks for own messages. The tooltip is deliberately
 * honest about read receipts: a recipient who turned them off never sends a
 * READ ack, so "delivered" must NOT be read as "they haven't read it" — that
 * false negative is exactly what trips up agents.
 */
/** Renders a pending media/voice bubble from local bytes (no Evolution media id yet). */
function LocalPreview({ msg }: { msg: ChatMsg }) {
  const url = msg.localPreviewUrl!;
  if (msg.type === 'image' || msg.type === 'sticker')
    return <img src={url} alt={msg.caption || msg.type} className="max-h-72 max-w-full rounded-md opacity-80" />;
  if (msg.type === 'audio') return <audio controls src={url} className="max-w-60" />;
  if (msg.type === 'video') return <video controls src={url} className="max-h-72 max-w-full rounded-md opacity-80" />;
  return <span className="text-xs text-gray-500">📄 {msg.fileName || 'Attachment'}</span>;
}

function Ticks({ msg }: { msg: ChatMsg }) {
  // optimistic temps get their own glyphs; a real message with an empty status
  // keeps the normal single gray tick.
  //
  // An in-flight PENDING temp shows the single gray tick IMMEDIATELY rather than
  // a spinner. Evolution's /message/sendText blocks ~1-1.5s on the WhatsApp relay
  // ack before /api/send returns, so a spinner would sit there the whole time —
  // here the message has already left the composer and almost always lands, so we
  // show "sent" optimistically (WhatsApp-feel) and rely on the FAILED/SKIPPED
  // branch below to honestly flip to a red "!" if the send actually fails. The
  // tooltip stays truthful ("Sending…") until the real row reconciles.
  if (msg.optimistic && (msg.status === 'FAILED' || msg.status === 'SKIPPED')) {
    const t = msg.status === 'SKIPPED' ? 'Not sent — recipient blocked/skipped' : 'Failed to send — tap Retry';
    return (
      <span title={t} aria-label={t} role="img" className="ml-0.5 font-bold text-red-500">
        !
      </span>
    );
  }
  const status = msg.status;
  const sending = msg.optimistic && status === 'PENDING';
  const read = status === 'READ' || status === 'PLAYED';
  const delivered = read || status === 'DELIVERY_ACK';
  const seenWhen = msg.readAt
    ? new Date(msg.readAt * 1000).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  const tip = read
    ? seenWhen
      ? `Read by the recipient · ${seenWhen}`
      : 'Read by the recipient'
    : delivered
      ? "Delivered to the recipient's phone. It turns blue once read — but some contacts disable read receipts, so this may already be read."
      : sending
        ? 'Sending…'
        : 'Sent — waiting for delivery';
  return (
    <span title={tip} aria-label={tip} role="img">
      <svg
        className={`ml-0.5 inline h-3.5 w-4 align-text-bottom ${read ? 'text-[#53bdeb]' : 'text-gray-400'}`}
        viewBox="0 0 18 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M1.5 6.5l3 3L10 4" />
        {delivered && <path d="M7.5 8.7l1 .8L14 4" />}
      </svg>
    </span>
  );
}

export default function MessageBubble({
  msg,
  senderName,
  agentTag,
  deletedByAgent,
  deletedAt,
  editedByAgent,
  groupStart = true,
  reactions,
  onReply,
  onEdit,
  onReact,
  onDelete,
  onForward,
  onSelect,
  onQuoteClick,
  onRetry,
}: BubbleProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const swipeIconRef = useRef<HTMLSpanElement>(null);
  // mutable drag state lives in a ref so pointermove doesn't re-render per pixel
  const drag = useRef<{ x0: number; y0: number; dx: number; active: boolean } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The options dropdown defaults to opening downward, but on the bottom-most
  // bubbles that runs off the chat area (clipped behind the composer). Flip it
  // upward when there isn't room below the trigger.
  const [menuUp, setMenuUp] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  function toggleMenu() {
    const next = !menuOpen;
    if (next && menuBtnRef.current) {
      const r = menuBtnRef.current.getBoundingClientRect();
      // ~6 items worth of menu; if it wouldn't fit below, open upward instead
      setMenuUp(window.innerHeight - r.bottom < 260);
    }
    setMenuOpen(next);
    setEmojiOpen(false);
  }
  // The reaction popup defaults to opening upward; on the top-most bubble that
  // clips above the chat area, so flip it downward when there's no room above.
  const [emojiUp, setEmojiUp] = useState(true);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);

  function toggleEmoji() {
    const next = !emojiOpen;
    if (next && emojiBtnRef.current) {
      const r = emojiBtnRef.current.getBoundingClientRect();
      // single-row popup (~44px); open downward only if it won't fit above
      setEmojiUp(r.top >= 48);
    }
    setEmojiOpen(next);
    setMenuOpen(false);
  }
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showVoters, setShowVoters] = useState(true);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && editRef.current) {
      const ta = editRef.current;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, [editing]);

  const time = msg.timestamp
    ? new Date(msg.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  if (msg.type === 'reaction') {
    return (
      <div className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'} px-8`}>
        <span className="text-xs text-gray-400">{msg.text} reaction</span>
      </div>
    );
  }

  // A media message is edited by its caption, not its (empty) text — WhatsApp
  // carries both edits the same way on the wire (see secretedit.ts), so a
  // caption is just as editable as a plain-text message.
  const editableText = msg.type === 'text' ? msg.text : msg.caption;
  const canEdit =
    msg.fromMe &&
    (msg.type === 'text' || (msg.hasMedia && !!msg.caption)) &&
    !msg.optimistic &&
    !msg.editTargetId &&
    Date.now() / 1000 - msg.timestamp < EDIT_WINDOW_S;

  function startEdit() {
    setMenuOpen(false);
    setEditText(editableText);
    setEditing(true);
  }

  function commitEdit() {
    const next = editText.trim();
    setEditing(false);
    if (next && next !== editableText) onEdit(msg, next);
  }

  function copyText() {
    setMenuOpen(false);
    void navigator.clipboard?.writeText(msg.text || msg.caption || '').catch(() => {});
  }

  // ── drag-to-reply (pointer events cover both mouse and touch, v1 gesture) ──
  // Always swipe right to reply, for both own and incoming messages.
  const swipeDir = 1;

  function dragStart(e: React.PointerEvent) {
    if (editing || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const t = e.target as HTMLElement;
    if (t.closest('button, a, audio, video, textarea, input')) return;
    drag.current = { x0: e.clientX, y0: e.clientY, dx: 0, active: false };
  }

  function dragMove(e: React.PointerEvent) {
    const d = drag.current;
    const row = rowRef.current;
    if (!d || !row) return;
    // dx is the distance along the swipe direction; positive = toward reply
    const dx = (e.clientX - d.x0) * swipeDir;
    const dy = e.clientY - d.y0;
    if (!d.active) {
      if (Math.abs(dx) < 8) return;
      // vertical → scrolling; wrong-direction mouse → text selection. Leave both alone.
      if (Math.abs(dx) <= Math.abs(dy) || dx < 0) {
        drag.current = null;
        return;
      }
      d.active = true;
      row.setPointerCapture(e.pointerId);
      row.style.transition = 'none';
      document.body.style.userSelect = 'none';
      window.getSelection()?.removeAllRanges();
    }
    d.dx = Math.max(0, Math.min(dx, SWIPE_MAX_PX));
    row.style.transform = `translateX(${d.dx * swipeDir}px)`;
    const icon = swipeIconRef.current;
    if (icon) {
      const p = Math.min(1, d.dx / SWIPE_REPLY_PX);
      icon.style.opacity = String(p);
      icon.style.transform = `translateX(${(d.dx - 40) * swipeDir}px) scale(${0.5 + 0.5 * p})`;
      icon.style.color = d.dx >= SWIPE_REPLY_PX ? '#25D366' : '#9ca3af';
    }
  }

  function dragEnd() {
    const d = drag.current;
    const row = rowRef.current;
    drag.current = null;
    document.body.style.userSelect = '';
    if (!d || !row) return;
    row.style.transition = 'transform .18s ease';
    row.style.transform = '';
    const icon = swipeIconRef.current;
    if (icon) icon.style.opacity = '0';
    if (d.active && d.dx >= SWIPE_REPLY_PX) onReply(msg);
  }

  // Bubble fill reflects the message's state: a deleted message reads as a light
  // rose tombstone, an edited one keeps its side colour with a faint amber hint.
  const bubbleBg = msg.deletedBySender
    ? 'bg-red-50 ring-1 ring-red-100'
    : msg.edited
      ? msg.fromMe
        ? 'bg-bubble-me ring-1 ring-amber-200'
        : 'bg-amber-50'
      : msg.fromMe
        ? 'bg-bubble-me'
        : 'bg-white';

  const actionBtn =
    'flex h-6 w-6 items-center justify-center rounded-full text-gray-400 hover:bg-black/5 hover:text-gray-600 pointer-coarse:h-8 pointer-coarse:w-8';
  // While a popup is open the container must stay visible even when the
  // pointer leaves the message row — otherwise hovering the popup itself
  // ends group-hover and everything disappears mid-click. A deleted tombstone
  // has nothing to act on (and must not offer Edit/Delete on a gone message).
  const actions = msg.deletedBySender ? null : (
    <span
      className={`relative gap-0.5 self-center ${
        // touch screens have no hover — keep the actions reachable there
        emojiOpen || menuOpen ? 'flex' : 'hidden group-hover:flex pointer-coarse:flex'
      }`}
    >
      <button
        ref={emojiBtnRef}
        onClick={toggleEmoji}
        title="React"
        aria-label="React to message"
        aria-expanded={emojiOpen}
        className={actionBtn}
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      </button>
      <button
        ref={menuBtnRef}
        onClick={toggleMenu}
        title="Message options"
        aria-label="Message options"
        aria-expanded={menuOpen}
        className={actionBtn}
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>
      {emojiOpen && (
        <>
          <span className="fixed inset-0 z-20" onClick={() => setEmojiOpen(false)} />
          <span
            className={`absolute z-30 flex gap-0.5 rounded-full border border-gray-200 bg-white px-1.5 py-1 shadow-md ${
              emojiUp ? '-top-9' : 'top-9'
            }`}
          >
            {REACT_EMOJIS.map((e) => (
              <button
                key={e}
                onClick={() => {
                  setEmojiOpen(false);
                  onReact(msg, e);
                }}
                aria-label={`React with ${e}`}
                className="rounded-full px-0.5 text-sm hover:scale-125"
              >
                {e}
              </button>
            ))}
          </span>
        </>
      )}
      {menuOpen && (
        <>
          <span className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
          <span
            className={`absolute z-30 w-36 rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg ${
              menuUp ? 'bottom-7' : 'top-7'
            } ${msg.fromMe ? 'right-0' : 'left-0'}`}
          >
            <button onClick={() => { setMenuOpen(false); onReply(msg); }} className="block w-full px-3 py-1.5 text-left hover:bg-gray-50">↩ Reply</button>
            <button onClick={() => { setMenuOpen(false); onForward(msg); }} className="block w-full px-3 py-1.5 text-left hover:bg-gray-50">↪ Forward</button>
            <button onClick={() => { setMenuOpen(false); onSelect(msg); }} className="block w-full px-3 py-1.5 text-left hover:bg-gray-50">☑ Select</button>
            {(msg.text || msg.caption) && (
              <button onClick={copyText} className="block w-full px-3 py-1.5 text-left hover:bg-gray-50">📋 Copy</button>
            )}
            {canEdit && (
              <button onClick={startEdit} className="block w-full px-3 py-1.5 text-left hover:bg-gray-50">✏️ Edit</button>
            )}
            {msg.fromMe && (
              <button onClick={() => { setMenuOpen(false); onDelete(msg); }} className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-red-50">🗑 Delete</button>
            )}
          </span>
        </>
      )}
    </span>
  );

  return (
    <div className="relative">
      <span
        ref={swipeIconRef}
        className={`pointer-events-none absolute top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white opacity-0 shadow ${
          msg.fromMe ? 'right-1' : 'left-1'
        }`}
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4"/></svg>
      </span>
      <div
        ref={rowRef}
        className={`group flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}
        style={{ touchAction: 'pan-y' }}
        onPointerDown={dragStart}
        onPointerMove={dragMove}
        onPointerUp={dragEnd}
        onPointerCancel={dragEnd}
        onContextMenu={(e) => {
          if (editing) return;
          e.preventDefault();
          // Mirror toggleMenu()'s flip check: the trigger button is hidden
          // (display:none) until the menu opens, so its own rect reads as
          // zero here — measure off the always-rendered row instead.
          const r = rowRef.current?.getBoundingClientRect();
          if (r) setMenuUp(window.innerHeight - r.bottom < 260);
          setEmojiOpen(false);
          setMenuOpen(true);
        }}
      >
        {msg.fromMe &&
          (msg.optimistic ? (
            (msg.status === 'FAILED' || msg.status === 'SKIPPED') && (
              <button
                type="button"
                onClick={() => onRetry?.(msg)}
                className="self-center pr-1 text-[11px] font-medium text-red-600 underline"
              >
                Retry
              </button>
            )
          ) : (
            <span className="pr-1">{actions}</span>
          ))}
        <div
          className={`max-w-[75%] rounded-lg px-3 py-1.5 text-[15px] leading-snug shadow-sm md:max-w-[65%] ${bubbleBg} ${groupStart ? (msg.fromMe ? 'rounded-tr-sm' : 'rounded-tl-sm') : ''}`}
        >
          {senderName && !msg.fromMe && (
            <div className="text-xs font-semibold text-wa-dark" dir="auto">
              {senderName}
            </div>
          )}
          {msg.quoted && (
            <div
              role={msg.quoted.id ? 'button' : undefined}
              onClick={() => msg.quoted?.id && onQuoteClick?.(msg.quoted.id)}
              title={msg.quoted.id ? 'Jump to original message' : undefined}
              className={`mb-1 rounded border-l-4 border-wa bg-black/5 px-2 py-1 text-xs text-gray-500 ${
                msg.quoted.id && onQuoteClick ? 'cursor-pointer hover:bg-black/10' : ''
              }`}
            >
              <span dir="auto">{msg.quoted.text.slice(0, 120)}</span>
            </div>
          )}
          {msg.hasMedia && (msg.localPreviewUrl ? <LocalPreview msg={msg} /> : <MediaContent msg={msg} />)}
          {editing ? (
            <div className="min-w-[220px]">
              <textarea
                ref={editRef}
                value={editText}
                dir="auto"
                rows={1}
                onChange={(e) => {
                  setEditText(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commitEdit();
                  } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    setEditing(false);
                  }
                }}
                className="w-full resize-none rounded-md bg-white/70 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-wa/50"
              />
              <div className="mt-1 flex items-center justify-end gap-2">
                <button
                  onClick={() => setEditing(false)}
                  title="Cancel (Esc)"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-gray-500 hover:bg-black/5"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
                <button
                  onClick={commitEdit}
                  disabled={!editText.trim() || editText.trim() === editableText}
                  title="Save (Enter)"
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-wa text-white hover:bg-wa-dark disabled:opacity-40"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
                </button>
              </div>
            </div>
          ) : msg.type === 'poll' ? (
            (() => {
              // WhatsApp-style poll: question + "Select one / one or more",
              // each option a checkbox/radio + bar + count, voters revealed via
              // "View votes". Options come off the creation record so they show
              // even before the first vote (pollVotes is absent until then).
              const tally = msg.pollVotes;
              const max = tally ? Math.max(1, ...tally.options.map((o) => o.count)) : 1;
              const rows = (msg.pollOptions ?? tally?.options.map((o) => o.name) ?? []).map(
                (name, i) => tally?.options[i] ?? { name, count: 0, voters: [] as PollVoter[] },
              );
              const total = tally?.total ?? 0;
              const hasVoters = rows.some((r) => r.voters.length > 0);
              const multiple = !!msg.pollMultiple;
              return (
                <div className="min-w-[15rem]">
                  <div className="font-medium" dir="auto">
                    {msg.text}
                  </div>
                  <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                    {multiple ? 'Select one or more' : 'Select one'}
                  </div>
                  <div className="mt-2 space-y-2.5">
                    {rows.map((opt, i) => {
                      // bar is relative to the leading option (WhatsApp fills the
                      // winner ~full), so a sole vote still reads as a clear lead.
                      const pct = Math.round((opt.count / max) * 100);
                      const lead = opt.count > 0 && opt.count === max;
                      return (
                        <div key={i} className="flex items-start gap-2.5">
                          <span
                            className={`mt-px h-[18px] w-[18px] shrink-0 border-2 border-gray-300 dark:border-gray-500 ${
                              multiple ? 'rounded-[5px]' : 'rounded-full'
                            }`}
                            aria-hidden
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 break-words text-sm" dir="auto">
                                {opt.name}
                              </span>
                              <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400">
                                {opt.count}
                              </span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
                              <div
                                className={`h-full rounded-full transition-all ${lead ? 'bg-wa' : 'bg-wa/55'}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            {showVoters && opt.voters.length > 0 && (
                              <div className="mt-1.5 space-y-0.5">
                                {opt.voters.map((v, j) => (
                                  <div
                                    key={j}
                                    className="flex items-baseline gap-1.5 leading-tight"
                                    dir="auto"
                                  >
                                    <span className="text-[11px] text-gray-600 dark:text-gray-300">
                                      {v.name || (v.number ? `+${v.number}` : '—')}
                                    </span>
                                    {v.name && v.number && (
                                      <span className="text-[10px] tabular-nums text-gray-400 dark:text-gray-500">
                                        +{v.number}
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t border-black/10 pt-1.5 dark:border-white/10">
                    <span className="text-[11px] text-gray-400">
                      {total} {total === 1 ? 'vote' : 'votes'}
                    </span>
                    {hasVoters && (
                      <button
                        type="button"
                        onClick={() => setShowVoters((v) => !v)}
                        className="text-xs font-medium text-wa hover:underline"
                      >
                        {showVoters ? 'Hide votes' : 'View votes'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })()
          ) : (
            (msg.text || msg.caption) && (
              <div className="whitespace-pre-wrap break-words" dir="auto">
                {renderRichText(msg.text || msg.caption)}
              </div>
            )
          )}
          {msg.deletedBySender && (
            <div className="mt-0.5">
              <div className="flex items-center gap-1 text-xs italic text-rose-500" dir="auto">
                <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m1 0v12a1 1 0 01-1 1H8a1 1 0 01-1-1V7"/></svg>
                {deletedByAgent?.name
                  ? `Deleted by ${deletedByAgent.name}`
                  : msg.fromMe
                    ? 'You deleted this message'
                    : senderName || msg.pushName
                      ? `${senderName || msg.pushName} deleted this message`
                      : 'This message was deleted'}
                {deletedAt && formatDeletedTime(deletedAt) && (
                  <span className="not-italic text-rose-400">· {formatDeletedTime(deletedAt)}</span>
                )}
              </div>
              {(() => {
                const original =
                  msg.deletedOriginalText ||
                  msg.deletedOriginalCaption ||
                  DELETED_MEDIA_LABELS[msg.deletedOriginalType ?? ''] ||
                  '';
                return original ? (
                  <div
                    className="mt-0.5 whitespace-pre-wrap break-words border-l-2 border-rose-200 pl-2 text-sm italic text-gray-400"
                    dir="auto"
                    title="Original message before it was deleted"
                  >
                    {renderRichText(original)}
                  </div>
                ) : null;
              })()}
            </div>
          )}
          {!editing && (
            <span className="ml-2 align-bottom text-[10px] text-gray-400">
              {agentTag && (
                <span
                  title={agentTag.email}
                  className={`mr-1 rounded-full px-1.5 py-px font-medium ${agentBadgeClass(agentTag.color)}`}
                >
                  {agentLabel(agentTag)}
                </span>
              )}
              {msg.edited &&
                (msg.editHistory.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setHistoryOpen((v) => !v)}
                    className="italic underline decoration-dotted underline-offset-2 hover:text-gray-600"
                    title="Show previous versions"
                  >
                    Edited
                  </button>
                ) : (
                  <span className="italic">Edited</span>
                ))}
              {msg.edited && ' · '}
              {time}
              {msg.fromMe && <Ticks msg={msg} />}
              {msg.fromMe && (msg.status === 'READ' || msg.status === 'PLAYED') && (
                <span className="ml-1 font-medium text-[#53bdeb]">
                  {msg.readAt
                    ? `Seen at ${new Date(msg.readAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                    : 'Seen'}
                </span>
              )}
            </span>
          )}
          {historyOpen && msg.editHistory.length > 0 && (
            <div className="mt-1 rounded-md border border-gray-200 bg-white/70 px-2 py-1 text-xs text-gray-600">
              <div className="mb-0.5 font-medium text-gray-400">
                {editedByAgent?.name
                  ? `Edited by ${editedByAgent.name} · previous ${msg.editHistory.length > 1 ? 'versions' : 'version'}`
                  : `Previous ${msg.editHistory.length > 1 ? 'versions' : 'version'}`}
              </div>
              {msg.editHistory.map((v, i) => (
                <div
                  key={i}
                  dir="auto"
                  className="whitespace-pre-wrap break-words border-t border-gray-100 py-0.5 first:border-0"
                >
                  {v}
                </div>
              ))}
            </div>
          )}
          {!!reactions?.length && (
            <div className="-mb-0.5 mt-0.5 flex flex-wrap gap-1">
              {aggregate(reactions).map((chip) => (
                <span
                  key={chip.emoji}
                  title={reactorTitle(chip)}
                  className={`flex cursor-default items-center gap-0.5 rounded-full border px-1.5 py-px text-xs shadow-sm ${
                    chip.mine ? 'border-wa/60 bg-green-50' : 'border-gray-200 bg-white'
                  }`}
                >
                  {chip.emoji}
                  {chip.count > 1 && <span className="text-[10px] text-gray-500">{chip.count}</span>}
                </span>
              ))}
            </div>
          )}
        </div>
        {!msg.fromMe && <span className="pl-1">{actions}</span>}
      </div>
    </div>
  );
}
