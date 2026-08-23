import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { EmojiStyle } from 'emoji-picker-react';
import BlacklistAddDialog from '../components/BlacklistAddDialog';
import { useConfirm } from '../components/Confirm';
import { useToast } from '../components/Toast';
import { agentBadgeClass, agentLabel, useAgents, useMe } from '../lib/agents';
import { api } from '../lib/api';
import {
  canonJid,
  syncAliases,
  useAgentPresence,
  useChatMeta,
  usePresenceHeartbeat,
  useReminders,
} from '../lib/workbench';
import WorkbenchBar from './chat/WorkbenchBar';
import {
  buildChatList,
  buildContactNames,
  displayConvNumber,
  displayNumber,
  fetchThread,
} from '../lib/chatModel';
import {
  clearReadMark,
  effectiveUnread,
  readMarksVersion,
  setReadMark,
  subscribeReadMarks,
} from '../lib/readMarks';
import {
  collapseReactions,
  isGroupJid,
  resolveName,
  threadJids,
  type ChatMsg,
  type Conv,
  type MsgType,
  type ThreadFetchResult,
} from '../lib/chatModel';
import { applyLocalDeletes, buildOptimistic, matchReconciled, mergePending, reconcilePending, type LocalDelete, type PendingSend } from '../lib/optimistic';
import { normalizePhone } from '../lib/phone';
import { fillAgentName, useQuickReplies } from '../lib/quickReplies';
import QuickRepliesModal from './chat/QuickRepliesModal';
import { useEvents } from '../lib/useEvents';
import { fileToBase64, VoiceRecorder } from '../lib/voice';
import type { Job } from '../types';
import AttachPreview from './chat/AttachPreview';
import ContactCard from './chat/ContactCard';
import ForwardModal from './chat/ForwardModal';
import MessageBubble, { type MsgReaction } from './chat/MessageBubble';
import NewChatModal from './chat/NewChatModal';
import QuickSwitcher from './chat/QuickSwitcher';

// Lazy so the ~1MB emoji dataset lands in its own chunk, loaded only when the
// picker is first opened rather than on every page load.
const EmojiPicker = lazy(() => import('emoji-picker-react'));

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'mine', label: 'Mine' },
  { id: 'pending', label: 'Pending' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'groups', label: 'Groups' },
  { id: 'archived', label: 'Archived' },
] as const;
type FilterId = (typeof FILTERS)[number]['id'];
/** Mine needs an identity; the workflow chips need any chat-meta to filter on. */
const WORKBENCH_FILTERS: readonly FilterId[] = ['mine', 'pending', 'resolved'];

const ARCHIVED_KEY = 'wa_archived_jids';
const SUBJECTS_KEY = 'wa_group_subjects';

function loadArchived(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(ARCHIVED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

/** Stable hue per contact name so fallback avatars get distinct pastel colors. */
function avatarHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return h;
}

function Avatar({ conv }: { conv: Conv }) {
  // expired/blocked picture URLs must fall back to initials, not render the
  // browser's broken-image icon (tracked per URL so a refresh can recover)
  const [brokenUrl, setBrokenUrl] = useState('');
  if (conv.profilePicUrl && conv.profilePicUrl !== brokenUrl)
    return (
      <img
        src={conv.profilePicUrl}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setBrokenUrl(conv.profilePicUrl)}
        // pointer-events-none: a long-press on the avatar otherwise triggers the
        // browser's native image handling (callout/drag) and eats the row's
        // long-press gesture — so the context menu only opened when you pressed
        // the text side. Let the touch fall through to the row instead.
        className="pointer-events-none h-10 w-10 shrink-0 rounded-full object-cover"
      />
    );
  const initial = conv.isGroup ? '👥' : (conv.name.match(/\p{L}/u)?.[0]?.toUpperCase() ?? '#');
  return (
    <div
      className="avatar-fallback flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
      style={{ '--av-h': avatarHue(conv.name) } as React.CSSProperties}
    >
      {initial}
    </div>
  );
}

/** "Today" / "Yesterday" / "8 June" pill between message days. */
function dayLabel(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], {
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

const sameDay = (aSec: number, bSec: number): boolean =>
  new Date(aSec * 1000).toDateString() === new Date(bSec * 1000).toDateString();

/** messages this close together (and same sender) render as one visual group */
const GROUP_GAP_S = 300;

/** WhatsApp-style animated "typing" dots. */
function TypingDots() {
  return (
    <span className="inline-flex items-baseline gap-1 text-wa-dark">
      typing
      <span className="inline-flex gap-0.5">
        {[0, 150, 300].map((d) => (
          <span
            key={d}
            className="h-1 w-1 animate-bounce rounded-full bg-current"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </span>
    </span>
  );
}

function listTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString();
}

/** "Today 20:00" / "Tomorrow 09:00" / "12/06 14:30" for scheduled-message labels. */
function scheduleLabel(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { day: '2-digit', month: '2-digit' })} ${time}`;
}

/** One-line preview of a scheduled job's first item, for the in-thread bubble. */
function jobPreview(job: Job): string {
  const item = job.items[0];
  if (!item) return '(empty)';
  const text = (item.data?.text ?? item.data?.caption) as string | undefined;
  if (text) return text;
  if (item.type === 'media') return '📎 Attachment';
  if (item.type === 'voice') return '🎤 Voice note';
  return item.type;
}

/** Set a datetime-local input value (local-time, minute precision) from a Date. */
function toLocalInput(d: Date): string {
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Skeleton bubbles shown while a thread loads. */
function ThreadSkeleton() {
  const rows = ['w-52', 'w-64', 'w-40', 'w-56', 'w-36', 'w-60'];
  return (
    <div className="space-y-2" aria-hidden="true">
      {rows.map((w, i) => (
        <div key={i} className={`flex ${i % 3 === 2 ? 'justify-end' : 'justify-start'}`}>
          <div
            className={`h-10 ${w} max-w-[75%] animate-pulse rounded-lg ${
              i % 3 === 2 ? 'bg-bubble-me/60' : 'bg-white/60'
            }`}
          />
        </div>
      ))}
    </div>
  );
}

/** Skeleton rows shown while the chat list loads. */
function ChatListSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-gray-100 px-3 py-2">
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-gray-200" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-1/2 animate-pulse rounded bg-gray-200" />
            <div className="h-2.5 w-3/4 animate-pulse rounded bg-gray-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface ThreadProps {
  conv: Conv;
  convs: Conv[];
  names: Map<string, string>;
  aliases: Map<string, string>;
  presence: string;
  /** notification deep-link: scroll to + flash this message once it's loaded */
  jumpTo?: string;
  onBack: () => void;
  onArchived: () => void;
}

function Thread({ conv, convs, names, aliases, presence, jumpTo, onBack, onArchived }: ThreadProps) {
  const qc = useQueryClient();
  const confirmDlg = useConfirm();
  const toast = useToast();
  const jid = conv.id;
  // Incoming messages often live under the contact's @lid alias JID — fetch
  // and merge every JID this conversation maps to (the v1-proven approach).
  const jids = useMemo(() => threadJids(jid, aliases), [jid, aliases]);
  const [pageCount, setPageCount] = useState(1);
  const messages = useQuery({
    // keyed on the JID *set* — an alias substitution must refetch even when
    // the count happens to stay the same
    queryKey: ['messages', jid, [...jids].sort().join(','), pageCount],
    queryFn: async ({ queryKey }) => {
      const fresh = await fetchThread(jids, pageCount, (j, p) => api.chats.messages(j, p));
      // The thread renders a "newest N pages" window. As messages accumulate the
      // oldest LOADED one slides past the page boundary, so a plain refetch drops
      // it — and after every send the whole list reflows/reorders by that row's
      // height (the visible jump). Keep what we've already shown: union previous
      // ∪ fresh, fresh winning per id so edits / deletes / status still apply.
      // Bounded by the open chat; the key includes jid+pageCount, so it resets on
      // chat switch or when older pages are loaded.
      const prev = qc.getQueryData<ThreadFetchResult>(queryKey)?.records ?? [];
      if (!prev.length) return fresh;
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of fresh.records) byId.set(m.id, m);
      return {
        records: [...byId.values()].sort((a, b) => a.timestamp - b.timestamp),
        hasMore: fresh.hasMore,
      };
    },
    // 10s (was 25s): deletes/edits made on the phone emit no realtime event we
    // can refresh on, so the open thread catches them on this poll — only runs
    // for the open chat while the tab is visible (RQ pauses in the background).
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
  // Optimistic sends, held outside the messages-query cache so a refetch can't
  // wipe them; merged into `records` for rendering until the real row arrives.
  const [pending, setPending] = useState<PendingSend[]>([]);
  const tmpCounter = useRef(0);
  // Stable React key bridge: realEvolutionId → the tmpId the optimistic bubble
  // used. When a send reconciles, the bubble's id flips tmp-… → real id; without
  // this the <MessageBubble> would unmount+remount under a new key (a visible
  // flicker + scroll jump on every send). Aliasing the real id back to the temp
  // key keeps the SAME element across the swap. Reset per chat (Thread is keyed
  // on the jid), so it can't grow unbounded.
  const keyAlias = useRef<Map<string, string>>(new Map());
  const prevPendingRef = useRef<PendingSend[]>([]); // for blob: URL revocation
  // Messages the operator deleted via the app's delete button — flipped to a
  // tombstone instantly (id → pre-delete content) since Evolution nulls the
  // content asynchronously and emits no realtime delete event to refresh on.
  const [locallyDeleted, setLocallyDeleted] = useState<Map<string, LocalDelete>>(() => new Map());
  const serverRecords = messages.data?.records ?? [];
  // Reconcile synchronously at render time (not in a follow-up effect) so no
  // frame ever shows a temp AND its real row. A real send is reconciled by its
  // Evolution id (no clock-skew/identical-text dup); content+time is a fallback
  // only when the id is missing. The effect below just prunes + revokes blobs.
  const livePending = useMemo(() => reconcilePending(pending, serverRecords), [pending, serverRecords]);
  const records = useMemo(() => {
    // A message you're sending right now is the newest thing you did, so an
    // in-flight optimistic temp always renders at the BOTTOM (mergePending
    // appends pending after the server rows) — "good from the start" even when
    // the device clock is behind the server (sorting by the device timestamp put
    // the bubble above recent messages). Its real row arrives stamped server-now,
    // which is also the newest server row, so it lands in the same bottom slot —
    // no re-sort a beat later. keyAlias links the real row back to the temp's
    // React key so the bubble updates in place instead of remounting; /api/send
    // often returns no messageId on this Evolution build (so dispatchSend can't
    // set it), hence we also link it here via the SAME match reconcile uses.
    for (const t of pending) {
      if (livePending.includes(t)) continue; // still pending → not reconciled yet
      const real = matchReconciled(t, serverRecords);
      if (real) keyAlias.current.set(real.id, t.id);
    }
    return applyLocalDeletes(mergePending(serverRecords, livePending), locallyDeleted);
  }, [serverRecords, livePending, locallyDeleted, pending]);
  // Once the server confirms a delete (its own deletedBySender arrives), drop the
  // optimistic overlay entry so the map can't grow unbounded over a session.
  useEffect(() => {
    if (!locallyDeleted.size) return;
    setLocallyDeleted((prev) => {
      let next: Map<string, LocalDelete> | null = null;
      for (const r of serverRecords) {
        if (r.deletedBySender && prev.has(r.id)) {
          next ??= new Map(prev);
          next.delete(r.id);
        }
      }
      return next ?? prev;
    });
  }, [serverRecords, locallyDeleted]);

  // Reactions are stored as standalone records — collapse them onto their
  // target message (one per sender, latest wins, removals dropped — see
  // collapseReactions) and resolve who reacted for the hover tooltip.
  const reactionsByTarget = useMemo(() => {
    const map = new Map<string, MsgReaction[]>();
    for (const [target, live] of collapseReactions(records)) {
      map.set(
        target,
        live.map((r) => ({
          emoji: r.emoji,
          fromMe: r.fromMe,
          who: r.fromMe ? 'You' : r.pushName || resolveName(r.senderJid, names, aliases),
          at: r.at,
        })),
      );
    }
    return map;
  }, [records, names, aliases]);
  const visible = useMemo(
    () => records.filter((m) => m.type !== 'reaction' || !m.reactionTargetId),
    [records],
  );

  // Agent identification (Settings toggle): which agent sent each own message.
  const me = useMe();
  // Workbench: chat meta is keyed by the server's canonical jid; teammates'
  // live presence in THIS chat; my own heartbeat while it's open.
  const chatMeta = useChatMeta();
  const canon = canonJid(chatMeta.data, jid);
  const othersHere = useAgentPresence().filter(
    (o) => o.chatJid === canon && o.email !== me.data?.email,
  );
  // never POST a temp 'tmp-' id to /api/message-agents — only real sent messages
  const fromMeIds = useMemo(
    () => visible.filter((m) => m.fromMe && !m.optimistic).map((m) => m.id),
    [visible],
  );
  const msgAgents = useQuery({
    queryKey: ['msg-agents', jid, fromMeIds.join(',')],
    queryFn: () => api.messageAgents(fromMeIds),
    enabled: !!me.data?.enabled && fromMeIds.length > 0,
    staleTime: 60_000,
    // The key changes on every send (a new fromMe id joins the list). Without
    // this, data blanks to undefined while the re-keyed fetch runs, so EVERY
    // agent badge drops and re-appears for a frame — the whole thread flickers.
    // Keep the prior map until the new one resolves (it's a superset anyway).
    placeholderData: (prev) => prev,
  });
  // The server only maps an agent to a message once Evolution assigns it an id,
  // so an optimistic temp has no msgAgents entry yet. But the sender IS the
  // signed-in agent — tag it from `me` so the badge shows during the in-flight
  // phase too, with no flicker when the real row reconciles.
  const meTag = useMemo(
    () =>
      me.data?.enabled && me.data.email
        ? { email: me.data.email, name: me.data.name, color: me.data.color }
        : undefined,
    [me.data?.enabled, me.data?.email, me.data?.name, me.data?.color],
  );
  // Evolution ids this client sent this session. msgAgents re-keys on every send
  // and lags during a burst, so a freshly-reconciled real row can briefly have no
  // entry — fall back to meTag for THOSE ids only (never another agent's message).
  const iSentRef = useRef<Set<string>>(new Set());

  // Pending scheduled jobs addressed to THIS chat — rendered as ghost bubbles.
  const scheduled = useQuery({
    queryKey: ['jobs'],
    queryFn: api.jobs.list,
    refetchInterval: 30_000,
    select: (jobs) =>
      jobs
        // immediate "send now" jobs are pending for seconds — not scheduled work
        .filter(
          (j) =>
            j.status === 'pending' &&
            j.type !== 'immediate' &&
            j.recipients.some((r) => r.id === jid),
        )
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)),
  });
  const scheduledJobs = scheduled.data ?? [];

  const [draft, setDraft] = useState('');
  // highlighted row in the "/" quick-reply picker (keyboard navigation)
  const [qrActive, setQrActive] = useState(0);
  const [replyTo, setReplyTo] = useState<ChatMsg | null>(null);
  const [forwardMsg, setForwardMsg] = useState<ChatMsg | null>(null);
  const [recording, setRecording] = useState(false);

  // Tell teammates I'm in this chat (and typing) — collision avoidance.
  usePresenceHeartbeat(canon, !!draft.trim() && !draft.startsWith('/'));

  // Our own presence, fire-and-forget: "typing…" while the draft changes
  // (throttled — WhatsApp shows it for a few seconds per signal), and
  // "recording…" refreshed for as long as the mic is open.
  const lastTypingSignal = useRef(0);
  useEffect(() => {
    if (!draft || draft.startsWith('/')) return; // the quick-reply picker isn't typing
    const now = Date.now();
    if (now - lastTypingSignal.current < 4000) return;
    lastTypingSignal.current = now;
    api.presence(jid, 'composing', 3000).catch(() => {});
  }, [draft, jid]);
  useEffect(() => {
    if (!recording) return;
    const signal = () => api.presence(jid, 'recording', 6000).catch(() => {});
    void signal();
    const t = setInterval(signal, 5000);
    return () => clearInterval(t);
  }, [recording, jid]);
  const [sendError, setSendError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [blDialog, setBlDialog] = useState(false);
  const [blocked, setBlocked] = useState(false);
  // is this contact on the send-time blacklist? (shared cache with Compose)
  const blacklist = useQuery({
    queryKey: ['blacklist'],
    queryFn: api.blacklist.list,
    staleTime: 60_000,
    enabled: !conv.isGroup,
  });
  const blKey = conv.isGroup ? null : normalizePhone(displayConvNumber(conv));
  const blacklisted = !!blKey && (blacklist.data ?? []).some((e) => e.phone_number === blKey);
  const quickRepliesStore = useQuickReplies();
  const quickReplies = quickRepliesStore.replies;
  // null = closed; initialShortcut (possibly undefined) opens straight into the new-reply form
  const [qrModal, setQrModal] = useState<{ initialShortcut?: string } | null>(null);
  const [attachFile, setAttachFile] = useState<File | null>(null);
  // A quick reply's media, staged in the same preview the agent reviews before
  // sending (carries the reply text as caption). base64 = uploaded file bytes;
  // url = hosted media sent by reference.
  const [attachQr, setAttachQr] = useState<{
    mediatype: 'image' | 'video' | 'audio' | 'document';
    mimetype: string;
    filename: string;
    caption: string;
    base64?: string;
    url?: string;
    previewUrl: string;
  } | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [notice, setNotice] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchIdx, setSearchIdx] = useState(0);
  const [flashId, setFlashId] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [pendingNew, setPendingNew] = useState(0);
  const [dragDepth, setDragDepth] = useState(0);
  const recorder = useRef(new VoiceRecorder());
  const fileInput = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const scheduledRef = useRef<HTMLDivElement>(null);
  const markedRef = useRef<string>('');
  // Where to drop the caret after an emoji insert; null except for the render
  // right after insertEmoji, so the restore effect below is a no-op otherwise.
  const emojiCaret = useRef<number | null>(null);

  // Grow the composer with its content so multi-line messages stay fully
  // visible (WhatsApp-style), capped before it eats the thread; runs on every
  // draft change so programmatic fills (quick replies, schedule pull-back) and
  // the post-send reset to a single row both re-measure.
  useLayoutEffect(() => {
    const el = draftRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    // Only show the scrollbar once the content actually exceeds the cap,
    // so a single-line (or short) draft never renders an idle scrollbar.
    el.style.overflowY = el.scrollHeight > 160 ? 'auto' : 'hidden';
  }, [draft]);

  // Insert an emoji at the caret (or replacing the selection), keeping the
  // picker open so several can be added in a row — WhatsApp-style.
  function insertEmoji(emoji: string) {
    const el = draftRef.current;
    const start = el ? el.selectionStart : draft.length;
    const end = el ? el.selectionEnd : draft.length;
    emojiCaret.current = start + emoji.length;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));
  }

  // After an emoji insert, refocus the composer and drop the caret just past
  // the inserted glyph so typing continues where the user expects.
  useEffect(() => {
    if (emojiCaret.current == null) return;
    const el = draftRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(emojiCaret.current, emojiCaret.current);
    }
    emojiCaret.current = null;
  }, [draft]);

  function onThreadScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = nearBottom;
    setAtBottom(nearBottom);
    if (nearBottom) setPendingNew(0);
  }

  // smooth scrolling never progresses in hidden documents (rAF doesn't tick)
  const scrollBehavior = (): ScrollBehavior =>
    document.visibilityState === 'visible' ? 'smooth' : 'auto';

  function scrollToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
    atBottomRef.current = true;
    setAtBottom(true);
    setPendingNew(0);
  }

  /** scroll to a message already in the DOM and flash it briefly */
  function jumpToMessage(id: string) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) {
      toast('The original message is not loaded — load older messages first', 'err');
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    setFlashId(id);
    window.setTimeout(() => setFlashId(''), 1400);
  }

  // Notification deep-link: once the target message is in the DOM, scroll to it
  // and flash it. Re-checks as records load (the message is usually the newest,
  // so it's there on first paint); jumps once per target so later messages
  // arriving don't re-yank the view.
  const jumpedTo = useRef<string | null>(null);
  useEffect(() => {
    if (!jumpTo || jumpedTo.current === jumpTo) return;
    const el = document.getElementById(`msg-${jumpTo}`);
    if (!el) return; // not loaded yet — retry on the next records change
    jumpedTo.current = jumpTo;
    el.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    setFlashId(jumpTo);
    window.setTimeout(() => setFlashId(''), 1400);
  }, [jumpTo, records]);

  // ── in-thread search ──
  const matchIds = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    if (!searchOpen || !q) return [];
    return visible.filter((m) => (m.text || m.caption).toLowerCase().includes(q)).map((m) => m.id);
  }, [visible, searchQ, searchOpen]);
  // a new query starts at the newest match
  useEffect(() => {
    setSearchIdx(Math.max(0, matchIds.length - 1));
  }, [searchQ, matchIds.length]);
  const currentMatch = matchIds[searchIdx] ?? '';
  useEffect(() => {
    if (currentMatch)
      document.getElementById(`msg-${currentMatch}`)?.scrollIntoView({ block: 'center' });
  }, [currentMatch]);

  // ── unread divider: the unread count captured when the thread opened ──
  const initialUnread = useRef(conv.unreadCount);
  const firstUnreadId = useMemo(() => {
    let remaining = initialUnread.current;
    if (remaining <= 0) return '';
    for (let i = visible.length - 1; i >= 0; i--) {
      const m = visible[i]!;
      if (m.fromMe) continue;
      if (--remaining === 0) return m.id;
    }
    return '';
  }, [visible]);

  // initial load lands on the first unread message (if any); afterwards stick
  // to the bottom whenever the NEWEST message changes (not on older pages)
  const didInitialScroll = useRef(false);
  const newestId = records[records.length - 1]?.id;
  useEffect(() => {
    if (!newestId) return;
    if (!didInitialScroll.current) {
      didInitialScroll.current = true;
      // a notification deep-link owns the initial position when its target is
      // loaded — let the jump effect land on it. If it's not loaded yet, fall
      // through to the normal divider/bottom placement (the jump effect still
      // scrolls to it if it arrives on a later page).
      if (jumpTo && document.getElementById(`msg-${jumpTo}`)) return;
      const divider = firstUnreadId && document.getElementById(`msg-${firstUnreadId}`);
      if (divider) {
        divider.scrollIntoView();
        return;
      }
    }
    // reading history? don't yank to the bottom — count it on the FAB instead.
    // Scroll the container directly (scrollTop = scrollHeight) rather than
    // bottomRef.scrollIntoView(): Samsung Internet doesn't reliably honour
    // scrollIntoView on an element inside a nested overflow container (esp. with
    // the keyboard up after a send), so own sends "didn't scroll down" there —
    // the explicit container scroll the FAB uses works across browsers.
    if (atBottomRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else setPendingNew((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestId]);

  // mark incoming messages read once per latest message — keyed off
  // serverRecords so optimistic temp ids never pollute markedRef / markRead
  useEffect(() => {
    if (!serverRecords.length) return;
    // viewing the conversation clears its badge locally even when none of the
    // loaded messages needs a read receipt (Evolution's count can be stale)
    if (conv.unreadCount > 0) {
      setReadMark(jid, conv.lastMsgTimestamp);
      void qc.invalidateQueries({ queryKey: ['chats'] });
    }
    const unread = serverRecords.filter(
      (m) => !m.fromMe && m.status !== 'READ' && m.status !== 'PLAYED' && m.type !== 'reaction',
    );
    const newest = serverRecords[serverRecords.length - 1]!.id;
    if (!unread.length || markedRef.current === newest) return;
    markedRef.current = newest;
    api.chats
      .markRead(unread.map((m) => ({ remoteJid: m.remoteJid || jid, fromMe: false, id: m.id })))
      .then(() => {
        // Evolution's findChats unreadCount stays stale after this call —
        // remember locally how far we've read so the badge actually clears
        setReadMark(jid, conv.lastMsgTimestamp);
        return qc.invalidateQueries({ queryKey: ['chats'] });
      })
      .catch(() => {});
  }, [serverRecords, jid, conv.lastMsgTimestamp, conv.unreadCount, qc]);

  // Prune reconciled temps out of state + revoke any blob: preview URLs they
  // held. livePending is the already-reconciled view; when it shrinks, commit
  // the trimmed list so `pending` can't grow unbounded.
  useEffect(() => {
    const prev = prevPendingRef.current;
    for (const t of prev) {
      if (!livePending.includes(t) && t.localPreviewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(t.localPreviewUrl);
      }
    }
    prevPendingRef.current = livePending;
    if (livePending.length !== pending.length) setPending(livePending);
  }, [livePending, pending.length]);

  // revoke any surviving blob: previews on unmount (chat switch / close)
  useEffect(
    () => () => {
      for (const t of prevPendingRef.current) {
        if (t.localPreviewUrl?.startsWith('blob:')) URL.revokeObjectURL(t.localPreviewUrl);
      }
    },
    [],
  );

  function nextTmpId(): string {
    tmpCounter.current += 1;
    return `tmp-${Date.now()}-${tmpCounter.current}`;
  }

  function setTempStatus(tempId: string, patch: Partial<PendingSend>) {
    setPending((p) => p.map((t) => (t.id === tempId ? { ...t, ...patch } : t)));
  }

  // Each send owns its own tempId via closure — independent promises, so a
  // slow/failed send always targets the right temp (a shared useMutation
  // observer would corrupt state on concurrent sends).
  async function dispatchSend(tempId: string, item: PendingSend['item']) {
    setSendError('');
    atBottomRef.current = true; // own sends land at the bottom, even reading history
    try {
      const res = await api.send(jid, item, conv.isGroup);
      if (res.skipped || res.routed === 'skipped') {
        setTempStatus(tempId, { status: 'SKIPPED' });
        setSendError('Not sent — recipient is blocked/blacklisted or skipped.');
        return;
      }
      // capture the real Evolution id so reconciliation drops the temp by id
      if (res.messageId) {
        iSentRef.current.add(res.messageId);
        // let the real row inherit the temp's render key → no remount flicker
        keyAlias.current.set(res.messageId, tempId);
      }
      setTempStatus(tempId, { status: 'SENT_SERVER', serverId: res.messageId ?? undefined });
      void messages.refetch();
    } catch (e) {
      const err = e as Error & { timedOut?: boolean };
      setTempStatus(tempId, { status: 'FAILED' });
      setSendError(
        err.timedOut
          ? 'Timed out — your message may have been sent. Check the conversation, then Retry if needed.'
          : String(err.message),
      );
    }
  }

  function sendText() {
    const text = draft.trim();
    if (!text) return;
    const data: Record<string, unknown> = { text };
    if (replyTo) data.quotedId = replyTo.id;
    const item = { type: 'text', data };
    const tempId = nextTmpId();
    setPending((p) => [
      ...p,
      buildOptimistic({
        tmpId: tempId,
        type: 'text',
        text,
        remoteJid: jid,
        quoted: replyTo
          ? {
              id: replyTo.id,
              text: replyTo.text || replyTo.caption,
              fromMe: replyTo.fromMe,
              participant: replyTo.senderJid || '',
            }
          : null,
        item,
      }),
    ]);
    setDraft(''); // clear immediately — the temp now owns the visual
    setReplyTo(null);
    void dispatchSend(tempId, item);
  }

  async function sendAttachment(caption: string) {
    const f = attachFile;
    if (!f) return;
    setSendError('');
    setAttachFile(null); // close the preview synchronously; the temp owns the visual
    try {
      const base64 = await fileToBase64(f);
      const tempId = nextTmpId();
      if (f.type.startsWith('audio/')) {
        // v1 parity: audio attachments go out as WhatsApp voice messages
        const item = { type: 'voice', data: { base64, encoding: true } };
        setPending((p) => [
          ...p,
          buildOptimistic({
            tmpId: tempId,
            type: 'audio',
            mimetype: f.type,
            hasMedia: true,
            localPreviewUrl: `data:${f.type};base64,${base64}`,
            remoteJid: jid,
            item,
          }),
        ]);
        void dispatchSend(tempId, item);
      } else {
        const mediatype = f.type.startsWith('video/')
          ? 'video'
          : f.type.startsWith('image/')
            ? 'image'
            : 'document';
        const data: Record<string, unknown> = {
          base64,
          mimetype: f.type || 'application/octet-stream',
          filename: f.name,
          mediatype,
        };
        if (caption) data.caption = caption;
        const item = { type: 'media', data };
        const type: MsgType = mediatype === 'video' ? 'video' : mediatype === 'image' ? 'image' : 'document';
        setPending((p) => [
          ...p,
          buildOptimistic({
            tmpId: tempId,
            type,
            caption,
            mimetype: f.type,
            fileName: f.name,
            hasMedia: true,
            localPreviewUrl: URL.createObjectURL(f),
            remoteJid: jid,
            item,
          }),
        ]);
        void dispatchSend(tempId, item);
      }
    } catch {
      setSendError('Could not read the file');
    }
  }

  /** Pick a quick reply: insert its text, or stage its media for review+send. */
  async function pickQuickReply(r: (typeof quickReplies)[number]) {
    const filled = fillAgentName(r.text, me.data?.name || me.data?.email?.split('@')[0] || '');
    if (!r.media) {
      setDraft(filled);
      return;
    }
    if (r.media.kind === 'url' && r.media.url) {
      setDraft('');
      setAttachQr({
        mediatype: r.media.mediatype,
        mimetype: r.media.mimetype,
        filename: r.media.filename ?? '',
        caption: filled,
        url: r.media.url,
        previewUrl: r.media.url,
      });
      return;
    }
    // Uploaded file: the bytes live server-side, fetched only now.
    try {
      const m = await api.quickReplies.media(r.id);
      if (!m.base64) return setSendError('That quick reply has no media to send');
      setDraft('');
      setAttachQr({
        mediatype: m.mediatype,
        mimetype: m.mimetype,
        filename: m.filename ?? '',
        caption: filled,
        base64: m.base64,
        previewUrl: `data:${m.mimetype};base64,${m.base64}`,
      });
    } catch {
      setSendError('Could not load the quick reply media');
    }
  }

  /** Send the staged quick-reply media (audio → voice note, else a media item). */
  function sendQrMedia(caption: string) {
    const m = attachQr;
    if (!m) return;
    setSendError('');
    setAttachQr(null);
    const tempId = nextTmpId();
    if (m.mediatype === 'audio') {
      const item = { type: 'voice', data: m.base64 ? { base64: m.base64, encoding: true } : { url: m.url } };
      setPending((p) => [
        ...p,
        buildOptimistic({
          tmpId: tempId,
          type: 'audio',
          mimetype: m.mimetype,
          hasMedia: true,
          localPreviewUrl: m.previewUrl,
          remoteJid: jid,
          item,
        }),
      ]);
      void dispatchSend(tempId, item);
      return;
    }
    const data: Record<string, unknown> = { mimetype: m.mimetype, mediatype: m.mediatype, filename: m.filename };
    if (m.base64) data.base64 = m.base64;
    else data.url = m.url;
    if (caption) data.caption = caption;
    const item = { type: 'media', data };
    const type: MsgType = m.mediatype === 'video' ? 'video' : m.mediatype === 'image' ? 'image' : 'document';
    setPending((p) => [
      ...p,
      buildOptimistic({
        tmpId: tempId,
        type,
        caption,
        mimetype: m.mimetype,
        fileName: m.filename,
        hasMedia: true,
        localPreviewUrl: m.previewUrl,
        remoteJid: jid,
        item,
      }),
    ]);
    void dispatchSend(tempId, item);
  }

  function retrySend(failed: ChatMsg) {
    const t = pending.find((p) => p.id === failed.id);
    if (!t) return;
    const tempId = nextTmpId();
    setPending((p) => [
      ...p.filter((x) => x.id !== failed.id),
      { ...t, id: tempId, status: 'PENDING', serverId: undefined, createdAt: Date.now() },
    ]);
    void dispatchSend(tempId, t.item);
  }

  function pickDroppedFile(e: React.DragEvent) {
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    e.preventDefault();
    setAttachFile(f);
  }

  function toggleSchedule() {
    if (!showSchedule && !scheduleAt) setScheduleAt(toLocalInput(new Date(Date.now() + 3600_000)));
    setShowSchedule(!showSchedule);
  }

  // Schedule popover presets.
  function presetIn1h() {
    setScheduleAt(toLocalInput(new Date(Date.now() + 3600_000)));
  }
  function presetTonight() {
    const d = new Date();
    d.setHours(20, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    setScheduleAt(toLocalInput(d));
  }
  function presetTomorrow9() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    setScheduleAt(toLocalInput(d));
  }

  async function scheduleSend() {
    const text = draft.trim();
    if (!text) return setSendError('Type the message to schedule first');
    const when = new Date(scheduleAt);
    if (!scheduleAt || Number.isNaN(when.getTime()) || when.getTime() <= Date.now())
      return setSendError('Pick a future date/time');
    setSendError('');
    try {
      await api.jobs.save({
        scheduledAt: when.toISOString(),
        recipients: [{ id: jid, isGroup: conv.isGroup }],
        items: [{ type: 'text', data: { text } }],
      });
      setDraft('');
      setShowSchedule(false);
      qc.invalidateQueries({ queryKey: ['jobs'] });
      setNotice(`Scheduled for ${scheduleLabel(when.toISOString())}`);
      window.setTimeout(() => setNotice(''), 6000);
      toast('Message scheduled');
    } catch (e) {
      setSendError(String((e as Error).message));
    }
  }

  const cancelJob = useMutation({
    mutationFn: (id: string) => api.jobs.cancel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
    onError: (e) => setSendError(String((e as Error).message)),
  });

  // Pull a scheduled job's text back into the composer, then drop the job.
  function editScheduled(job: Job) {
    const text = (job.items[0]?.data?.text ?? job.items[0]?.data?.caption) as string | undefined;
    if (typeof text === 'string') setDraft(text);
    setScheduleAt(toLocalInput(new Date(job.scheduledAt)));
    cancelJob.mutate(job.id);
  }

  // Fire a scheduled job right now and remove it from the queue.
  async function sendScheduledNow(job: Job) {
    const item = job.items[0];
    if (!item) return;
    setSendError('');
    try {
      await api.send(jid, item, conv.isGroup);
      await api.jobs.cancel(job.id);
      qc.invalidateQueries({ queryKey: ['jobs'] });
      void messages.refetch();
    } catch (e) {
      setSendError(String((e as Error).message));
    }
  }

  async function toggleVoice() {
    setSendError('');
    if (!recording) {
      try {
        await recorder.current.start();
        setRecording(true);
      } catch {
        setSendError('Microphone unavailable');
      }
      return;
    }
    setRecording(false);
    try {
      const { base64, mime } = await recorder.current.stop();
      const item = { type: 'voice', data: { base64, encoding: true } };
      const tempId = nextTmpId();
      setPending((p) => [
        ...p,
        buildOptimistic({
          tmpId: tempId,
          type: 'audio',
          mimetype: mime,
          hasMedia: true,
          // a data: URL CAN carry codec params for <audio> preview
          localPreviewUrl: `data:${mime};base64,${base64}`,
          remoteJid: jid,
          item,
        }),
      ]);
      void dispatchSend(tempId, item);
    } catch {
      setSendError('Recording failed');
    }
  }

  function editMessage(msg: ChatMsg, next: string) {
    api.messages
      .edit(msg.remoteJid || jid, msg.id, next)
      .then(() => {
        // Optimistic: show the new text + Edited tag immediately. Evolution
        // applies the edit to its DB via an async upsert event, so an instant
        // refetch can race and return the old text — the 25s poll reconciles.
        qc.setQueriesData({ queryKey: ['messages', jid] }, (old: unknown) => {
          const data = old as { records: ChatMsg[]; hasMore: boolean } | undefined;
          if (!data?.records) return old;
          return {
            ...data,
            records: data.records.map((r) =>
              r.id === msg.id
                ? {
                    ...r,
                    text: next,
                    edited: true,
                    // preserve the pre-edit text so the history is clickable here too
                    editHistory: [...r.editHistory, r.text].filter(Boolean),
                  }
                : r,
            ),
          };
        });
      })
      .catch((e) => setSendError(String(e.message)));
  }

  function react(msg: ChatMsg, emoji: string) {
    // target the JID the message actually lives under (may be the @lid alias)
    api
      .send(
        msg.remoteJid || jid,
        { type: 'reaction', data: { messageId: msg.id, reaction: emoji, fromMe: msg.fromMe } },
        conv.isGroup,
      )
      .then(() => messages.refetch())
      .catch((e) => setSendError(String((e as Error).message)));
  }

  async function deleteMessage(msg: ChatMsg) {
    const ok = await confirmDlg({
      title: 'Delete this message?',
      body: 'The message is deleted for everyone in the chat.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    // optimistic: show the tombstone + original + who deleted it instantly
    // (Evolution nulls the content asynchronously and fires no realtime event,
    // so a bare refetch lags). `by` is the acting agent, shown as "Deleted by …".
    const by = me.data?.name || me.data?.email?.split('@')[0] || '';
    setLocallyDeleted((prev) =>
      new Map(prev).set(msg.id, {
        text: msg.text,
        caption: msg.caption,
        type: msg.type,
        by,
        at: new Date().toISOString(),
      }),
    );
    api.messages
      // groups need the original sender to locate the message
      .delete(msg.remoteJid || jid, msg.id, msg.fromMe, conv.isGroup ? msg.senderJid : undefined)
      .then(() => {
        toast('Message deleted');
        void messages.refetch();
      })
      .catch((e) => {
        // the delete didn't go through — undo the optimistic tombstone
        setLocallyDeleted((prev) => {
          if (!prev.has(msg.id)) return prev;
          const next = new Map(prev);
          next.delete(msg.id);
          return next;
        });
        setSendError(String(e.message));
      });
  }

  // Forward: text goes straight out; media is pulled (decrypted) from
  // /api/media and re-sent to the target chat.
  async function forwardTo(target: Conv) {
    const m = forwardMsg;
    if (!m) return;
    try {
      if (m.hasMedia) {
        const resp = await api.media({
          key: { id: m.id, remoteJid: m.remoteJid || jid, fromMe: m.fromMe },
        });
        const raw = String(resp?.base64 ?? resp?.media ?? resp?.data?.base64 ?? '');
        if (!raw) throw new Error('Could not load the media to forward');
        const base64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
        if (m.type === 'audio') {
          await api.send(target.id, { type: 'voice', data: { base64, encoding: true } }, target.isGroup);
        } else {
          await api.send(
            target.id,
            {
              type: 'media',
              data: {
                base64,
                mimetype: m.mimetype || 'application/octet-stream',
                ...(m.fileName ? { filename: m.fileName } : {}),
                mediatype:
                  m.type === 'video' ? 'video' : m.type === 'document' ? 'document' : 'image',
                ...(m.caption ? { caption: m.caption } : {}),
              },
            },
            target.isGroup,
          );
        }
      } else {
        const text = m.text || m.caption;
        if (!text) throw new Error('This message type cannot be forwarded');
        await api.send(target.id, { type: 'text', data: { text } }, target.isGroup);
      }
      setForwardMsg(null);
      toast(`Forwarded to ${target.name}`);
    } catch (e) {
      toast(String((e as Error).message), 'err');
    }
  }

  async function markUnread() {
    setMenuOpen(false);
    clearReadMark(jid); // the local overlay must not keep suppressing the badge
    const last = records[records.length - 1];
    await api.chats.markUnread(
      jid,
      // the last message may live under an @lid alias — its key must carry
      // the JID it is actually stored under, like the markRead path does
      last ? { key: { id: last.id, fromMe: last.fromMe, remoteJid: last.remoteJid || jid } } : undefined,
    );
    qc.invalidateQueries({ queryKey: ['chats'] });
  }

  async function toggleBlock() {
    setMenuOpen(false);
    await api.chats.block(jid.split('@')[0]!, blocked ? 'unblock' : 'block');
    setBlocked(!blocked);
  }

  // quick replies: "/" at the start of the draft opens the picker
  const qrQuery = draft.startsWith('/') ? draft.slice(1).toLowerCase() : null;
  const qrMatches =
    qrQuery != null
      ? quickReplies.filter(
          (r) =>
            !qrQuery ||
            r.shortcut.toLowerCase().includes(qrQuery) ||
            r.text.toLowerCase().includes(qrQuery),
        )
      : [];
  // the rows actually rendered (and reachable by the arrow keys)
  const qrVisible = qrMatches.slice(0, 6);
  // reset the highlight whenever the filtered set changes so it never points
  // past the end (or at a stale row) after the query narrows
  useEffect(() => {
    setQrActive(0);
  }, [qrQuery, qrVisible.length]);

  const presenceLabel =
    presence === 'composing' ? 'typing…' : presence === 'recording' ? 'recording voice…' : '';

  return (
    // min-w-0: without it this flex item takes its content's intrinsic width
    // and overflows narrow viewports (clipped composer on mobile)
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-gray-200 bg-white px-1.5 py-1.5 sm:gap-2 sm:px-3">
        <button
          onClick={onBack}
          aria-label="Back to chat list"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg text-gray-500 hover:bg-gray-100 pointer-coarse:h-11 pointer-coarse:w-11 md:hidden"
        >
          ←
        </button>
        {/* tapping the name/avatar block opens the contact/group info card
            (WhatsApp-style) — the ⋮ menu remains for quick actions */}
        <button
          type="button"
          onClick={() => setCardOpen(true)}
          aria-label={conv.isGroup ? 'Group info' : 'Contact info'}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-gray-50"
        >
          <span className="relative shrink-0">
            <Avatar conv={conv} />
            {presence && presence !== 'unavailable' && (
              <span
                className="absolute right-0 bottom-0 h-2.5 w-2.5 rounded-full border-2 border-white bg-wa"
                title="Online"
              />
            )}
          </span>
          <div className="min-w-0">
            <div className="truncate font-medium" dir="auto">
              {conv.name}
            </div>
            {(() => {
              // when the contact has no saved name, conv.name already IS the
              // number — don't repeat it on the subtitle line
              const number = conv.isGroup ? 'group' : displayConvNumber(conv);
              const showNumber = conv.isGroup || number !== conv.name;
              if (presence === 'composing')
                return (
                  <div className="truncate text-xs text-wa-dark">
                    <TypingDots />
                  </div>
                );
              const label = presenceLabel || (showNumber ? number : '');
              if (!label && !blocked) return null;
              return (
                <div className="truncate text-xs text-wa-dark">
                  {label}
                  {blocked ? (label ? ' · blocked' : 'blocked') : ''}
                </div>
              );
            })()}
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={() => {
              setSearchOpen(!searchOpen);
              setSearchQ('');
            }}
            title="Search in conversation"
            aria-label="Search in conversation"
            aria-expanded={searchOpen}
            className={`flex h-9 w-9 items-center justify-center rounded-full hover:bg-gray-100 pointer-coarse:h-11 pointer-coarse:w-11 ${searchOpen ? 'bg-gray-100 text-wa-dark' : 'text-gray-500'}`}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.2-5.2M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"/></svg>
          </button>
        <div className="relative">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Conversation menu"
            aria-expanded={menuOpen}
            className="flex h-9 w-9 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 pointer-coarse:h-11 pointer-coarse:w-11"
          >
            ⋮
          </button>
          {menuOpen && (
            <div className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg">
              {scheduledJobs.length > 0 && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    scheduledRef.current?.scrollIntoView({ behavior: 'smooth' });
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-medium text-amber-700 hover:bg-amber-50"
                >
                  <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                  {scheduledJobs.length} scheduled — jump
                </button>
              )}
              <button onClick={() => void markUnread()} className="block w-full px-3 py-1.5 text-left hover:bg-gray-50">
                Mark as unread
              </button>
              <button onClick={() => void onArchived()} className="block w-full px-3 py-1.5 text-left hover:bg-gray-50">
                Archive chat
              </button>
              {!conv.isGroup && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setBlDialog(true);
                  }}
                  title="Campaigns skip this number — this chat keeps working"
                  className="block w-full px-3 py-1.5 text-left hover:bg-gray-50"
                >
                  {blacklisted ? '🚫 Blacklisted — edit reason' : 'Add to blacklist…'}
                </button>
              )}
              {!conv.isGroup && (
                <button onClick={() => void toggleBlock()} className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-red-50">
                  {blocked ? 'Unblock contact' : 'Block contact'}
                </button>
              )}
            </div>
          )}
        </div>
        </div>
      </div>

      {cardOpen && (
        <ContactCard
          conv={conv}
          canon={canon}
          phone={displayConvNumber(conv)}
          messages={visible}
          blocked={blocked}
          blacklisted={blacklisted}
          onSearch={() => {
            setSearchOpen(true);
            setSearchQ('');
          }}
          onArchive={() => void onArchived()}
          onToggleBlock={() => void toggleBlock()}
          onBlacklist={() => setBlDialog(true)}
          onClose={() => setCardOpen(false)}
        />
      )}

      {blDialog && !conv.isGroup && (
        <BlacklistAddDialog
          phone={displayConvNumber(conv)}
          // a nameless contact is titled by its own number — don't echo that
          // back as the blacklist row's name
          name={conv.name.replace(/\D/g, '') === displayConvNumber(conv).replace(/\D/g, '') ? '' : conv.name}
          onClose={() => setBlDialog(false)}
        />
      )}

      <WorkbenchBar jid={canon} meta={chatMeta.data} others={othersHere} />

      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-1.5">
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearchOpen(false);
              if (e.key === 'Enter' && matchIds.length)
                setSearchIdx((i) => (i - 1 + matchIds.length) % matchIds.length);
            }}
            placeholder="Search in this conversation…"
            dir="auto"
            autoFocus
            className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm"
          />
          <span className="shrink-0 text-xs text-gray-400">
            {searchQ.trim() ? (matchIds.length ? `${searchIdx + 1}/${matchIds.length}` : 'No matches') : ''}
          </span>
          <button
            onClick={() => setSearchIdx((i) => Math.max(0, i - 1))}
            disabled={searchIdx <= 0}
            title="Older match"
            aria-label="Older match"
            className="rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
          >
            ↑
          </button>
          <button
            onClick={() => setSearchIdx((i) => Math.min(matchIds.length - 1, i + 1))}
            disabled={searchIdx >= matchIds.length - 1}
            title="Newer match"
            aria-label="Newer match"
            className="rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
          >
            ↓
          </button>
          <button
            onClick={() => setSearchOpen(false)}
            aria-label="Close search"
            className="rounded px-1.5 py-0.5 text-gray-400 hover:text-gray-600"
          >
            ✕
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onThreadScroll}
        className="h-full overflow-y-auto bg-chat p-4"
        onClick={() => setMenuOpen(false)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDragEnter={(e) => {
          if (e.dataTransfer.types.includes('Files')) setDragDepth((d) => d + 1);
        }}
        onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
        onDrop={(e) => {
          setDragDepth(0);
          pickDroppedFile(e);
        }}
      >
        {messages.isLoading && <ThreadSkeleton />}
        {!messages.isLoading && !visible.length && !scheduledJobs.length && (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-gray-500">
            <span className="text-3xl" aria-hidden="true">
              👋
            </span>
            <span dir="auto">No messages yet — say hi to {conv.name}</span>
          </div>
        )}
        {messages.data?.hasMore && (
          <div className="mb-2 text-center">
            <button
              onClick={() => setPageCount(pageCount + 1)}
              disabled={messages.isFetching}
              className="rounded-full bg-white/80 px-3 py-1 text-xs text-gray-500 shadow-sm hover:bg-white disabled:opacity-50"
            >
              {messages.isFetching ? 'Loading…' : '↑ Load older messages'}
            </button>
          </div>
        )}
        {visible.map((m, i) => {
          const prev = visible[i - 1];
          const newDay = !prev || !sameDay(prev.timestamp, m.timestamp);
          // same sender, same day, close in time → one visual group
          const grouped =
            !!prev &&
            !newDay &&
            prev.fromMe === m.fromMe &&
            prev.senderJid === m.senderJid &&
            prev.type !== 'reaction' &&
            m.timestamp - prev.timestamp < GROUP_GAP_S &&
            m.id !== firstUnreadId;
          // a reconciled send keeps the optimistic bubble's key (see keyAlias)
          const stableKey = keyAlias.current.get(m.id) ?? m.id;
          return (
            <div key={stableKey} className={grouped ? 'mt-0.5' : 'mt-2'}>
              {newDay && (
                <div className="mb-2 flex justify-center">
                  <span className="rounded-full bg-white/90 px-3 py-1 text-[11px] font-medium text-gray-500 shadow-sm">
                    {dayLabel(m.timestamp)}
                  </span>
                </div>
              )}
              {m.id === firstUnreadId && (
                <div className="flex items-center gap-2 py-1" role="separator" aria-label="Unread messages">
                  <div className="h-px flex-1 bg-wa/30" />
                  <span className="rounded-full bg-white/90 px-2.5 py-0.5 text-[11px] font-medium text-wa-dark shadow-sm">
                    Unread messages
                  </span>
                  <div className="h-px flex-1 bg-wa/30" />
                </div>
              )}
              <div
                id={`msg-${m.id}`}
                className={`transition-shadow ${
                  m.id === currentMatch || m.id === flashId ? 'rounded-lg ring-2 ring-amber-400' : ''
                }`}
              >
                <MessageBubble
                  msg={m}
                  groupStart={!grouped}
                  onQuoteClick={jumpToMessage}
                  senderName={
                    !grouped && conv.isGroup && !m.fromMe
                      ? m.pushName?.trim() ||
                        (m.senderJid ? resolveName(m.senderJid, names, aliases) : '')
                      : ''
                  }
                  agentTag={
                    m.fromMe
                      ? m.optimistic
                        ? meTag
                        : (msgAgents.data?.[m.id] ?? (iSentRef.current.has(m.id) ? meTag : undefined))
                      : undefined
                  }
                  deletedByAgent={
                    m.deletedBySender
                      ? msgAgents.data?.[m.id]?.deletedBy ??
                        (locallyDeleted.get(m.id)?.by ? { name: locallyDeleted.get(m.id)!.by } : undefined)
                      : undefined
                  }
                  deletedAt={
                    m.deletedBySender
                      ? msgAgents.data?.[m.id]?.deletedAt ?? locallyDeleted.get(m.id)?.at
                      : undefined
                  }
                  editedByAgent={m.edited ? msgAgents.data?.[m.id]?.editedBy : undefined}
                  reactions={reactionsByTarget.get(m.id)}
                  onReply={setReplyTo}
                  onEdit={editMessage}
                  onReact={react}
                  onDelete={(msg) => void deleteMessage(msg)}
                  onForward={setForwardMsg}
                  onRetry={retrySend}
                />
              </div>
            </div>
          );
        })}

        {scheduledJobs.length > 0 && (
          <div ref={scheduledRef} className="space-y-1 pt-2">
            <div className="flex items-center gap-2 px-1">
              <div className="h-px flex-1 bg-amber-300/40" />
              <span className="flex items-center gap-1 text-[11px] font-medium text-amber-700">
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                Scheduled
              </span>
              <div className="h-px flex-1 bg-amber-300/40" />
            </div>
            {scheduledJobs.map((job) => (
              <div key={job.id} className="flex justify-end">
                <div className="max-w-[75%] rounded-xl rounded-br-sm border border-dashed border-amber-400 bg-amber-50/80 px-3 py-2">
                  <div className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-amber-700">
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                    {scheduleLabel(job.scheduledAt)}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-sm text-gray-800" dir="auto">
                    {jobPreview(job)}
                  </div>
                  <div className="mt-1.5 flex justify-end gap-1.5">
                    <button
                      onClick={() => editScheduled(job)}
                      className="rounded border border-amber-300 px-2 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => void sendScheduledNow(job)}
                      className="rounded border border-amber-300 px-2 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100"
                    >
                      Send now
                    </button>
                    <button
                      onClick={() => cancelJob.mutate(job.id)}
                      className="rounded border border-red-300 px-2 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {!atBottom && (
        <button
          onClick={scrollToBottom}
          aria-label="Scroll to latest messages"
          className="absolute right-4 bottom-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white text-gray-500 shadow-lg hover:text-gray-700"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3"/></svg>
          {pendingNew > 0 && (
            <span className="absolute -top-1.5 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-wa px-1 text-[10px] font-bold text-white">
              {pendingNew > 99 ? '99+' : pendingNew}
            </span>
          )}
        </button>
      )}

      {dragDepth > 0 && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-wa bg-wa/10">
          <span className="rounded-full bg-white px-4 py-2 text-sm font-medium text-wa-dark shadow">
            Drop to attach
          </span>
        </div>
      )}
      </div>

      {replyTo && (
        <div className="flex items-center gap-2 border-t border-gray-200 bg-gray-50 px-3 py-1.5 text-xs">
          <div className="min-w-0 flex-1 border-l-4 border-wa pl-2 text-gray-500">
            <div className="font-semibold text-wa-dark">
              {replyTo.fromMe
                ? 'You'
                : replyTo.pushName || resolveName(replyTo.senderJid || replyTo.remoteJid || jid, names, aliases)}
            </div>
            <div className="truncate" dir="auto">
              {(replyTo.text || replyTo.caption || replyTo.type).slice(0, 120)}
            </div>
          </div>
          <button onClick={() => setReplyTo(null)} className="px-2 text-gray-400 hover:text-gray-600">
            ✕
          </button>
        </div>
      )}
      {sendError && (
        <div role="alert" className="bg-red-50 px-3 py-1 text-xs text-red-600">
          {sendError}
        </div>
      )}
      {notice && (
        <div role="status" className="bg-green-50 px-3 py-1 text-xs text-wa-dark">
          {notice}
        </div>
      )}

      {showSchedule && (
        <div className="border-t border-gray-200 bg-gray-50 px-3 py-2">
          <div className="animate-rise mx-auto max-w-md rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">Schedule this message</span>
              <button onClick={() => setShowSchedule(false)} className="text-gray-400 hover:text-gray-600">
                ✕
              </button>
            </div>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {(
                [
                  ['In 1 hour', presetIn1h],
                  ['Tonight 20:00', presetTonight],
                  ['Tomorrow 09:00', presetTomorrow9],
                ] as const
              ).map(([label, fn]) => (
                <button
                  key={label}
                  onClick={fn}
                  className="rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-wa-dark hover:bg-green-100"
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              className="mb-2 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
            />
            <div className="mb-2 truncate rounded-md bg-gray-50 px-2 py-1.5 text-xs text-gray-500" dir="auto">
              {draft.trim() ? (
                <>
                  <span className="text-gray-400">Will send: </span>
                  {draft.trim()}
                </>
              ) : (
                <span className="text-gray-400">Type a message below to schedule it.</span>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSchedule(false)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void scheduleSend()}
                disabled={!draft.trim() || draft.startsWith('/')}
                title={draft.trim() ? 'Schedule (fires server-side)' : 'Type the message below first'}
                className="flex items-center gap-1.5 rounded-md bg-wa px-4 py-1.5 text-sm font-medium text-white hover:bg-wa-dark disabled:opacity-50"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                Schedule
              </button>
            </div>
          </div>
        </div>
      )}

      {qrQuery != null && (
        <div className="border-t border-gray-200 bg-white px-3 py-1.5 text-sm">
          <div className="mb-1 flex items-center justify-between text-xs text-gray-400">
            <span>Quick replies</span>
            <span className="flex items-center gap-3">
              <button
                onClick={() => setQrModal({ initialShortcut: qrQuery })}
                className="font-medium text-wa-dark hover:underline"
              >
                + New
              </button>
              <button
                onClick={() => setQrModal({})}
                className="font-medium text-wa-dark hover:underline"
              >
                Manage
              </button>
            </span>
          </div>
          {!qrMatches.length && (
            <div className="py-1 text-xs text-gray-400">No matches — “+ New” saves one</div>
          )}
          {qrVisible.map((r, i) => (
            <button
              key={r.shortcut}
              // {{agent_name}} fills at insertion so the final text is visible
              // in the composer before sending; media replies stage for review
              onClick={() => void pickQuickReply(r)}
              onMouseEnter={() => setQrActive(i)}
              className={`flex w-full min-w-0 items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-green-50 ${
                i === qrActive ? 'bg-green-50' : ''
              }`}
            >
              <span className="shrink-0 font-mono text-xs text-wa-dark">/{r.shortcut}</span>
              {r.media && <span className="shrink-0 text-xs" title={`${r.media.mediatype} attached`}>📎</span>}
              <span className="truncate text-xs text-gray-500" dir="auto">
                {r.text || `[${r.media?.mediatype ?? 'media'}]`}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* bottom inset: with the tab bar hidden on mobile this form is the
          bottommost element — keep it clear of the iOS home indicator */}
      <form
        className="flex items-end gap-2 border-t border-gray-200 bg-white p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        onSubmit={(e) => {
          e.preventDefault();
          sendText();
        }}
      >
        {/* Emoji picker — WhatsApp-style, anchored above the composer. Kept
            open after a pick so several emoji can be added in a row. */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setShowEmoji((v) => !v)}
            title="Emoji"
            aria-label="Emoji"
            aria-expanded={showEmoji}
            className={`flex h-10 w-10 items-center justify-center rounded-full ${
              showEmoji ? 'bg-green-100 text-wa-dark' : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </button>
          {showEmoji && (
            <>
              {/* transparent click-away layer (no dim, matching WhatsApp) */}
              <div className="fixed inset-0 z-30" onClick={() => setShowEmoji(false)} />
              <div className="absolute bottom-full left-0 z-40 mb-2 max-w-[90vw]">
                <Suspense fallback={null}>
                  <EmojiPicker
                    onEmojiClick={(d) => insertEmoji(d.emoji)}
                    // WhatsApp-lookalike artwork (Apple set, via the library's
                    // CDN). lazyLoadEmojis fetches images as they scroll in
                    // rather than all at once.
                    emojiStyle={'apple' as EmojiStyle}
                    lazyLoadEmojis
                    width={320}
                    height={400}
                    previewConfig={{ showPreview: false }}
                    searchPlaceHolder="Search emoji"
                  />
                </Suspense>
              </div>
            </>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setAttachFile(f);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          title="Attach file"
          aria-label="Attach file"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
        >
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/></svg>
        </button>
        <textarea
          ref={draftRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && replyTo) setReplyTo(null);
            // Quick-reply picker open: arrows move the highlight, Enter picks
            // the highlighted row (and Tab does too). Take these keys over
            // before the send/newline handling below.
            if (qrQuery != null && qrVisible.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setQrActive((i) => (i + 1) % qrVisible.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setQrActive((i) => (i - 1 + qrVisible.length) % qrVisible.length);
                return;
              }
              if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Tab') {
                e.preventDefault();
                const r = qrVisible[qrActive] ?? qrVisible[0];
                if (r) void pickQuickReply(r);
                return;
              }
            }
            // WhatsApp-style: Enter sends, Shift+Enter inserts a newline.
            // Mirror the send button's guard so Enter never fires a blank
            // message or a half-typed "/" quick-reply query. isComposing
            // skips Enter that's only committing an IME candidate.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!recording && draft.trim() && !draft.startsWith('/')) sendText();
            }
          }}
          onPaste={(e) => {
            const f = e.clipboardData.files?.[0];
            if (f) {
              e.preventDefault();
              setAttachFile(f);
            }
          }}
          placeholder={recording ? 'Recording voice note…' : 'Type a message'}
          dir="auto"
          disabled={recording}
          className="max-h-40 min-w-0 flex-1 resize-none overflow-y-hidden rounded-3xl border border-gray-300 px-4 py-2 text-sm leading-snug disabled:bg-red-50"
        />
        {/* WhatsApp-style: the mic gives way to text — hidden once the user
            starts typing so the composer reclaims the space. Stays visible
            while recording so it doubles as the stop-and-send control. */}
        {(recording || !draft.trim()) && (
          <button
            type="button"
            onClick={() => void toggleVoice()}
            title={recording ? 'Stop and send' : 'Record voice note'}
            aria-label={recording ? 'Stop recording and send' : 'Record voice note'}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
              recording ? 'animate-pulse bg-red-500 text-white' : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-14 0m7 7v3m-4 0h8M12 3a3 3 0 00-3 3v5a3 3 0 006 0V6a3 3 0 00-3-3z"/></svg>
          </button>
        )}
        {recording && (
          <button
            type="button"
            onClick={() => {
              recorder.current.cancel();
              setRecording(false);
            }}
            className="rounded-full bg-gray-100 px-3 py-2 text-sm text-gray-600 hover:bg-gray-200"
          >
            ✕
          </button>
        )}
        <button
          type="button"
          onClick={toggleSchedule}
          disabled={recording}
          title="Schedule send…"
          aria-label="Schedule send"
          aria-expanded={showSchedule}
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full disabled:opacity-50 ${
            showSchedule ? 'bg-green-100 text-wa-dark' : 'text-gray-500 hover:bg-gray-100'
          }`}
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        </button>
        <button
          type="submit"
          disabled={recording || !draft.trim() || draft.startsWith('/')}
          title="Send"
          aria-label="Send message"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-wa text-white hover:bg-wa-dark disabled:opacity-50"
        >
          <svg className="h-5 w-5 translate-x-px" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>
        </button>
      </form>

      {attachFile && (
        <AttachPreview
          file={attachFile}
          sending={false}
          onCancel={() => setAttachFile(null)}
          onSend={(caption) => void sendAttachment(caption)}
        />
      )}

      {attachQr && (
        <AttachPreview
          media={{ name: attachQr.filename || attachQr.mediatype, mime: attachQr.mimetype, previewUrl: attachQr.previewUrl }}
          initialCaption={attachQr.caption}
          sending={false}
          onCancel={() => setAttachQr(null)}
          onSend={(caption) => sendQrMedia(caption)}
        />
      )}

      {forwardMsg && (
        <ForwardModal
          msg={forwardMsg}
          convs={convs}
          onPick={forwardTo}
          onClose={() => setForwardMsg(null)}
        />
      )}

      {qrModal && (
        <QuickRepliesModal
          store={quickRepliesStore}
          onClose={() => setQrModal(null)}
          initialShortcut={qrModal.initialShortcut}
        />
      )}
    </div>
  );
}

interface ChatPageProps {
  /** Mobile: lets the app shell hide the bottom tab bar while a thread is open. */
  onThreadOpenChange?: (open: boolean) => void;
  /** Notification deep-link: open this chat (and optionally jump to a message). */
  openChat?: { jid: string; msg: string | null } | null;
  /** Called once the deep-link has been applied, so App can clear it. */
  onChatOpened?: () => void;
}

export default function ChatPage({ onThreadOpenChange, openChat, onChatOpened }: ChatPageProps = {}) {
  const qc = useQueryClient();
  const chats = useQuery({ queryKey: ['chats'], queryFn: api.chats.list, staleTime: 20_000 });
  const contacts = useQuery({
    queryKey: ['contacts'],
    queryFn: api.chats.contacts,
    staleTime: 5 * 60_000,
  });
  const groups = useQuery({
    queryKey: ['groups'],
    queryFn: api.chats.groups,
    staleTime: 5 * 60_000,
  });
  const presence = useEvents();
  // Workbench data for list decorations and the Mine/Pending/Resolved filters.
  const me = useMe();
  const chatMeta = useChatMeta();
  const roster = useAgents();
  const agentsByEmail = useMemo(
    () => new Map((roster.data ?? []).map((a) => [a.email, a])),
    [roster.data],
  );
  const agentPresence = useAgentPresence();
  const remindersQ = useReminders();
  const firedReminders = useMemo(
    () => new Set((remindersQ.data ?? []).filter((r) => r.status === 'fired').map((r) => r.chatJid)),
    [remindersQ.data],
  );
  const [activeJid, setActiveJid] = useState<string | null>(null);
  useEffect(() => {
    onThreadOpenChange?.(!!activeJid);
    return () => onThreadOpenChange?.(false);
  }, [activeJid, onThreadOpenChange]);
  // Notification deep-link: open the chat and remember which message to jump to.
  // `jump` is scoped to its jid so a later (normal) chat switch ignores it.
  const [jump, setJump] = useState<{ jid: string; msg: string } | null>(null);
  useEffect(() => {
    if (!openChat) return;
    setActiveJid(openChat.jid);
    setJump(openChat.msg ? { jid: openChat.jid, msg: openChat.msg } : null);
    onChatOpened?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChat]);
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState<FilterId>('all');
  const [archived, setArchived] = useState<Set<string>>(loadArchived);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // WhatsApp-style row context menu: opened by right-click (desktop) or
  // long-press (mobile). Pinned to the pointer; `longPressed` suppresses the
  // tap that would otherwise open the chat right after a long-press.
  const [rowMenu, setRowMenu] = useState<{ conv: Conv; x: number; y: number } | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);

  function openRowMenu(c: Conv, x: number, y: number) {
    // clamp so the menu never spills off the viewport edges
    setRowMenu({ conv: c, x: Math.min(x, window.innerWidth - 184), y: Math.min(y, window.innerHeight - 104) });
  }
  function cancelLongPress() {
    if (longPressTimer.current != null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  // Ctrl/Cmd+K — quick chat switcher
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSwitcherOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const groupSubjects = useMemo(() => {
    const map = new Map<string, string>();
    // seed with the last seen subjects: /api/groups takes seconds on Evolution,
    // and until it lands group rows would otherwise show the last sender's name
    try {
      const cached = JSON.parse(localStorage.getItem(SUBJECTS_KEY) ?? '{}') as Record<string, string>;
      for (const [id, s] of Object.entries(cached)) map.set(id, s);
    } catch {
      /* corrupt cache — live data overwrites it below */
    }
    for (const g of (Array.isArray(groups.data) ? groups.data : []) as Array<Record<string, any>>) {
      if (g.id && g.subject) map.set(g.id, g.subject);
    }
    return map;
  }, [groups.data]);

  useEffect(() => {
    if (!Array.isArray(groups.data)) return;
    const fresh: Record<string, string> = {};
    for (const g of groups.data as Array<Record<string, any>>) {
      if (g.id && g.subject) fresh[g.id] = g.subject;
    }
    if (Object.keys(fresh).length) localStorage.setItem(SUBJECTS_KEY, JSON.stringify(fresh));
  }, [groups.data]);

  const marksV = useSyncExternalStore(subscribeReadMarks, readMarksVersion);
  const { convs, aliases } = useMemo(() => {
    const built = buildChatList(
      Array.isArray(chats.data) ? chats.data : [],
      Array.isArray(contacts.data) ? contacts.data : [],
      groupSubjects,
      chatMeta.data?.aliases ?? {},
    );
    // Evolution keeps serving stale unreadCount after markMessageAsRead —
    // the local read-marks overlay clears badges we know were read
    for (const c of built.convs) {
      c.unreadCount = effectiveUnread(c.id, c.unreadCount, c.lastMsgTimestamp);
    }
    return built;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- marksV re-applies the overlay
  }, [chats.data, contacts.data, groupSubjects, chatMeta.data?.aliases, marksV]);
  const names = useMemo(
    () => buildContactNames(Array.isArray(contacts.data) ? contacts.data : []),
    [contacts.data],
  );

  // Teach the server the alias pairs our dedup discovered so chat meta stays
  // findable whichever jid an Evolution event carries (deduped per session).
  useEffect(() => {
    if (aliases.size) syncAliases(aliases);
  }, [aliases]);

  /** Workbench lookups for a list row, via the server's canonical jid. */
  const rowMeta = (c: Conv) => {
    const key = canonJid(chatMeta.data, c.id);
    return {
      assignee: chatMeta.data?.assignments[key]?.agentEmail,
      status: chatMeta.data?.statuses[key]?.status ?? 'open',
      hasReminder: firedReminders.has(key),
      othersHere: agentPresence.some((o) => o.chatJid === key && o.email !== me.data?.email),
    };
  };

  async function archiveChat(jid: string) {
    const next = new Set(archived);
    next.add(jid);
    setArchived(next);
    localStorage.setItem(ARCHIVED_KEY, JSON.stringify([...next]));
    setActiveJid(null);
    try {
      await api.chats.archive(jid, true);
    } catch {
      /* local archive still applies */
    }
    qc.invalidateQueries({ queryKey: ['chats'] });
  }

  // WhatsApp-style "mark as unread" straight from the list row (no need to open
  // the chat). Forces the shared badge for the whole team; clears the local
  // read-mark overlay so it can't suppress the badge we just raised.
  async function markChatUnread(c: Conv) {
    clearReadMark(c.id);
    try {
      await api.chats.markUnread(c.id);
    } catch {
      /* shared store is best-effort; the optimistic invalidate still refetches */
    }
    qc.invalidateQueries({ queryKey: ['chats'] });
  }

  // The inverse: clear an unread chat from the list without opening it.
  async function markChatRead(c: Conv) {
    setReadMark(c.id, c.lastMsgTimestamp); // suppress locally right away
    try {
      await api.chats.markChatRead(c.id);
    } catch {
      /* local overlay already cleared the badge for this browser */
    }
    qc.invalidateQueries({ queryKey: ['chats'] });
  }

  function unarchiveChat(jid: string) {
    const next = new Set(archived);
    next.delete(jid);
    setArchived(next);
    localStorage.setItem(ARCHIVED_KEY, JSON.stringify([...next]));
    void api.chats.archive(jid, false).catch(() => {});
  }

  const list = convs.filter((c) => {
    if (tab === 'archived') {
      if (!archived.has(c.id)) return false;
    } else {
      if (archived.has(c.id)) return false;
      if (tab === 'unread' && !c.unreadCount) return false;
      if (tab === 'groups' && !c.isGroup) return false;
      if (WORKBENCH_FILTERS.includes(tab)) {
        const m = rowMeta(c);
        if (tab === 'mine' && (!me.data?.email || m.assignee !== me.data.email)) return false;
        if (tab === 'pending' && m.status !== 'pending') return false;
        if (tab === 'resolved' && m.status !== 'resolved') return false;
      }
    }
    const q = filter.trim().toLowerCase();
    return !q || c.name.toLowerCase().includes(q) || c.id.includes(q);
  });
  // A brand-new chat (started by phone number) has no conversation record yet —
  // synthesize one so the thread opens empty and sends still work.
  const active: Conv | null =
    convs.find((c) => c.id === activeJid) ??
    (activeJid
      ? {
          id: activeJid,
          name: names.get(activeJid) ?? displayNumber(activeJid),
          profilePicUrl: '',
          lastMessage: '',
          lastMsgTimestamp: 0,
          unreadCount: 0,
          unreadDot: false,
          isGroup: isGroupJid(activeJid),
          fromMe: false,
          pinned: false,
          altJid: '',
        }
      : null);

  return (
    <div className="flex h-full">
      <aside
        className={`w-full shrink-0 flex-col border-r border-gray-200 bg-white md:flex md:w-80 ${
          active ? 'hidden' : 'flex'
        }`}
      >
        <div className="space-y-2 p-2">
          <div className="flex gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search chats"
              dir="auto"
              className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
            />
            <button
              onClick={() => setNewChatOpen(true)}
              title="New chat — any phone number"
              aria-label="New chat"
              className="shrink-0 rounded-md bg-wa px-3 text-lg leading-none text-white hover:bg-wa-dark"
            >
              ＋
            </button>
          </div>
          <div className="flex gap-1 overflow-x-auto">
            {FILTERS.filter((f) => f.id !== 'mine' || !!(me.data?.enabled && me.data.email)).map((f) => (
              <button
                key={f.id}
                onClick={() => setTab(f.id)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${
                  tab === f.id ? 'bg-wa text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {chats.isLoading && <ChatListSkeleton />}
          {chats.isError && (
            <div role="alert" className="p-4 text-sm text-red-500">
              {String(chats.error)} — is the Evolution connection configured?
            </div>
          )}
          {!chats.isLoading && !chats.isError && !list.length && (
            <div className="space-y-1 p-6 text-center text-sm text-gray-400">
              <div className="text-2xl" aria-hidden="true">
                💬
              </div>
              <div>
                {filter.trim()
                  ? 'No chats match your search.'
                  : tab === 'archived'
                    ? 'No archived chats.'
                    : tab === 'unread'
                      ? 'No unread chats — all caught up!'
                      : tab === 'groups'
                        ? 'No group chats yet.'
                        : 'No chats yet — start one with ＋'}
              </div>
            </div>
          )}
          {list.map((c) => {
            const wm = rowMeta(c);
            const assignedAgent = wm.assignee ? agentsByEmail.get(wm.assignee) : undefined;
            return (
            // content-visibility lets the browser skip layout/paint for the
            // ~1000 off-screen rows of a real account's chat list
            <div
              key={c.id}
              className="relative select-none [-webkit-touch-callout:none] [content-visibility:auto] [contain-intrinsic-size:auto_64px]"
              onContextMenu={(e) => {
                e.preventDefault();
                openRowMenu(c, e.clientX, e.clientY);
              }}
              onTouchStart={(e) => {
                longPressed.current = false;
                const t = e.touches[0];
                if (!t) return;
                const { clientX, clientY } = t;
                longPressStart.current = { x: clientX, y: clientY };
                cancelLongPress();
                longPressTimer.current = window.setTimeout(() => {
                  longPressed.current = true;
                  navigator.vibrate?.(10);
                  openRowMenu(c, clientX, clientY);
                }, 450);
              }}
              onTouchEnd={cancelLongPress}
              onTouchCancel={cancelLongPress}
              // Only a real drag/scroll (>12px) cancels the press. Cancelling on
              // ANY touchmove broke it: a finger held still always emits sub-pixel
              // jitter moves, so the long-press fired only intermittently.
              onTouchMove={(e) => {
                const s = longPressStart.current;
                const t = e.touches[0];
                if (s && t && (Math.abs(t.clientX - s.x) > 12 || Math.abs(t.clientY - s.y) > 12))
                  cancelLongPress();
              }}
            >
              <button
                onClick={() => {
                  // a long-press already opened the menu — don't also open the chat
                  if (longPressed.current) {
                    longPressed.current = false;
                    return;
                  }
                  setActiveJid(c.id);
                }}
                className={`flex w-full items-center gap-3 border-b border-l-[3px] border-gray-100 px-3 py-2 text-left pointer-coarse:py-3 ${
                  c.unreadCount
                    ? 'border-l-wa'
                    : wm.status === 'pending'
                      ? 'border-l-amber-400'
                      : 'border-l-transparent'
                } ${
                  activeJid === c.id
                    ? 'bg-green-50'
                    : wm.status === 'pending'
                      ? 'bg-amber-50 hover:bg-amber-100/70'
                      : 'hover:bg-gray-50'
                }`}
              >
                <Avatar conv={c} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={`truncate text-sm ${c.unreadCount ? 'font-semibold' : 'font-medium'}`}
                      dir="auto"
                    >
                      {c.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {wm.othersHere && (
                        <span
                          className="inline-block h-2 w-2 animate-pulse rounded-full bg-purple-400"
                          title="A teammate is in this chat"
                          aria-label="A teammate is in this chat"
                        />
                      )}
                      {wm.hasReminder && (
                        <span title="Follow-up reminder due" aria-label="Follow-up reminder due">
                          ⏰
                        </span>
                      )}
                      {wm.status === 'resolved' && (
                        <span className="font-bold text-green-500" title="Resolved" aria-label="Resolved">
                          ✓
                        </span>
                      )}
                      {wm.assignee && (
                        <span
                          title={`Assigned to ${wm.assignee}`}
                          className={`rounded-full px-1.5 text-[10px] font-medium ${agentBadgeClass(assignedAgent?.color ?? '')}`}
                        >
                          {agentLabel(assignedAgent ?? { email: wm.assignee })}
                        </span>
                      )}
                      {c.pinned && (
                        <svg className="h-3 w-3 text-gray-400" fill="currentColor" viewBox="0 0 24 24" aria-label="Pinned">
                          <path d="M16 3a1 1 0 01.707 1.707L16 5.414V10l2.293 2.293A1 1 0 0117.586 14H13v6l-1 2-1-2v-6H6.414a1 1 0 01-.707-1.707L8 10V5.414l-.707-.707A1 1 0 018 3h8z" />
                        </svg>
                      )}
                      <span
                        className={`text-xs ${c.unreadCount ? 'font-semibold text-wa-dark' : 'text-gray-400'}`}
                      >
                        {listTime(c.lastMsgTimestamp)}
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`truncate text-xs ${c.unreadCount ? 'font-medium text-gray-600' : 'text-gray-400'}`}
                      dir="auto"
                    >
                      {presence[c.id] === 'composing' ? (
                        <TypingDots />
                      ) : (
                        <>
                          {c.fromMe ? '✓ ' : ''}
                          {c.lastMessage}
                        </>
                      )}
                    </span>
                    {c.unreadCount > 0 &&
                      (c.unreadDot ? (
                        // WhatsApp-style "unread" flag: a plain green dot, no number
                        <span
                          className="h-3 w-3 shrink-0 rounded-full bg-wa"
                          title="Unread"
                          aria-label="Unread"
                        />
                      ) : (
                        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-wa px-1 text-xs font-bold text-white">
                          {c.unreadCount > 99 ? '99+' : c.unreadCount}
                        </span>
                      ))}
                  </div>
                </div>
              </button>
            </div>
            );
          })}
        </div>
      </aside>
      {rowMenu && (
        <>
          {/* full-screen catcher closes the menu on a press / right-click away.
              Uses onPointerDown (not onClick): after a touch long-press opens
              the menu, lifting the finger fires a synthetic click on this
              catcher and would instantly close the menu. pointerdown only fires
              on a NEW press, so the opening gesture's tail can't dismiss it. */}
          <div
            className="fixed inset-0 z-40"
            onPointerDown={() => setRowMenu(null)}
            onContextMenu={(e) => {
              // Suppress the native menu but do NOT close here: a touch
              // long-press fires this contextmenu ~50ms AFTER our 450ms timer
              // opened the menu, and it lands on this freshly-mounted catcher —
              // closing here is the "flash and vanish". Dismissal is
              // onPointerDown (a fresh tap), which also covers desktop
              // right-click-away (pointerdown fires for the right button too).
              e.preventDefault();
            }}
          />
          <div
            className="fixed z-50 w-44 rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg"
            style={{ left: rowMenu.x, top: rowMenu.y }}
          >
            <button
              onClick={() => {
                const c = rowMenu.conv;
                setRowMenu(null);
                if (c.unreadCount > 0) void markChatRead(c);
                else void markChatUnread(c);
              }}
              className="block w-full px-3 py-1.5 text-left hover:bg-gray-50"
            >
              {rowMenu.conv.unreadCount > 0 ? 'Mark as read' : 'Mark as unread'}
            </button>
            {archived.has(rowMenu.conv.id) ? (
              <button
                onClick={() => {
                  const id = rowMenu.conv.id;
                  setRowMenu(null);
                  unarchiveChat(id);
                }}
                className="block w-full px-3 py-1.5 text-left hover:bg-gray-50"
              >
                Unarchive chat
              </button>
            ) : (
              <button
                onClick={() => {
                  const id = rowMenu.conv.id;
                  setRowMenu(null);
                  void archiveChat(id);
                }}
                className="block w-full px-3 py-1.5 text-left hover:bg-gray-50"
              >
                Archive chat
              </button>
            )}
          </div>
        </>
      )}
      {active ? (
        <Thread
          key={active.id}
          conv={active}
          convs={convs}
          names={names}
          aliases={aliases}
          presence={presence[active.id] ?? ''}
          jumpTo={jump && jump.jid === active.id ? jump.msg : undefined}
          onBack={() => setActiveJid(null)}
          onArchived={() => void archiveChat(active.id)}
        />
      ) : (
        <div className="hidden flex-1 items-center justify-center text-sm text-gray-400 md:flex">
          Select a conversation
        </div>
      )}
      {switcherOpen && (
        <QuickSwitcher
          convs={convs}
          onPick={(jid) => {
            setActiveJid(jid);
            setSwitcherOpen(false);
          }}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
      {newChatOpen && (
        <NewChatModal
          contacts={Array.isArray(contacts.data) ? contacts.data : []}
          onOpen={(jid) => {
            setActiveJid(jid);
            setNewChatOpen(false);
          }}
          onClose={() => setNewChatOpen(false)}
        />
      )}
    </div>
  );
}
