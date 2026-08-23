import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { agentBadgeClass, agentLabel, useAgents } from '../../lib/agents';
import { api } from '../../lib/api';
import { useChatMeta } from '../../lib/workbench';
import type { ChatMsg, Conv } from '../../lib/chatModel';

const STATUS_META: Record<string, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-blue-100 text-blue-700' },
  pending: { label: 'Pending', cls: 'bg-amber-100 text-amber-700' },
  resolved: { label: 'Resolved', cls: 'bg-green-100 text-green-700' },
};

export interface ContactCardProps {
  conv: Conv;
  /** canonical jid — key into chat-meta (status / assignment / tags) */
  canon: string;
  /** display phone number for a 1:1 contact ("+972…") */
  phone: string;
  /** loaded thread messages, for the shared-media summary */
  messages: ChatMsg[];
  blocked: boolean;
  /** already on the send-time blacklist */
  blacklisted: boolean;
  onSearch: () => void;
  onArchive: () => void;
  onToggleBlock: () => void;
  /** open the blacklist form (number + reason) for this contact */
  onBlacklist: () => void;
  onClose: () => void;
}

/** Stable hue per name so the fallback avatar matches the one in the list. */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return h;
}

/**
 * WhatsApp-style contact/group info panel. Slides in from the right on desktop,
 * full-screen on mobile. Tapping the picture opens it full-size (lightbox).
 */
export default function ContactCard({
  conv,
  canon,
  phone,
  messages,
  blocked,
  blacklisted,
  onSearch,
  onArchive,
  onToggleBlock,
  onBlacklist,
  onClose,
}: ContactCardProps) {
  const [lightbox, setLightbox] = useState(false);
  const [copied, setCopied] = useState(false);

  // close on Escape (lightbox first, then the panel)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (lightbox) setLightbox(false);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightbox, onClose]);

  // workbench snapshot (read-only mirror of the bar under the header)
  const chatMeta = useChatMeta();
  const roster = useAgents();
  const status = chatMeta.data?.statuses[canon]?.status ?? 'open';
  const assignment = chatMeta.data?.assignments[canon];
  const tags = chatMeta.data?.tags[canon] ?? [];
  const assignedAgent = assignment
    ? (roster.data ?? []).find((a) => a.email === assignment.agentEmail)
    : undefined;

  // group members — fetched lazily only for groups while the card is open
  const groupInfo = useQuery({
    queryKey: ['group-info', conv.id],
    queryFn: () => api.groups.info(conv.id),
    enabled: conv.isGroup,
    staleTime: 60_000,
  });
  const members: any[] = Array.isArray(groupInfo.data?.participants)
    ? groupInfo.data!.participants
    : [];

  // shared media, counted from the loaded thread
  const photos = messages.filter((m) => m.hasMedia && (m.type === 'image' || m.type === 'video')).length;
  const docs = messages.filter((m) => m.hasMedia && m.type === 'document').length;
  const voice = messages.filter((m) => m.hasMedia && m.type === 'audio').length;

  async function copyPhone() {
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  const initial = conv.isGroup ? '👥' : (conv.name.match(/\p{L}/u)?.[0]?.toUpperCase() ?? '#');

  return (
    <>
      {/* scrim */}
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} aria-hidden="true" />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={conv.isGroup ? 'Group info' : 'Contact info'}
        className="animate-slide-in fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col bg-gray-50 shadow-2xl sm:w-96"
      >
        {/* title bar */}
        <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-3 py-3">
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
          >
            ✕
          </button>
          <span className="font-medium text-gray-800">
            {conv.isGroup ? 'Group info' : 'Contact info'}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* identity: big avatar (tap for full size) + name + number */}
          <div className="flex flex-col items-center gap-2 bg-white px-4 py-6">
            {conv.profilePicUrl ? (
              <button
                type="button"
                onClick={() => setLightbox(true)}
                aria-label="View profile picture"
                className="group relative"
              >
                <img
                  src={conv.profilePicUrl}
                  alt=""
                  draggable={false}
                  className="h-36 w-36 rounded-full object-cover ring-1 ring-black/5 transition group-hover:brightness-95"
                />
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 text-transparent transition group-hover:bg-black/20 group-hover:text-white">
                  <svg className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" d="M2.5 12S5 5.5 12 5.5 21.5 12 21.5 12 19 18.5 12 18.5 2.5 12 2.5 12z"/></svg>
                </span>
              </button>
            ) : (
              <div
                className="avatar-fallback flex h-36 w-36 items-center justify-center rounded-full text-5xl font-semibold"
                style={{ '--av-h': hue(conv.name) } as React.CSSProperties}
              >
                {initial}
              </div>
            )}
            <h2 className="mt-1 text-center text-xl font-semibold text-gray-800" dir="auto">
              {conv.name}
            </h2>
            {!conv.isGroup && phone && (
              <div className="flex items-center gap-2 text-gray-500">
                <span className="text-sm" dir="ltr">{phone}</span>
                <button
                  onClick={() => void copyPhone()}
                  title="Copy number"
                  aria-label="Copy number"
                  className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                >
                  {copied ? (
                    <svg className="h-4 w-4 text-wa-dark" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
                  ) : (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                  )}
                </button>
              </div>
            )}
            {conv.isGroup && (
              <span className="text-sm text-gray-500">
                {groupInfo.isLoading ? 'Loading members…' : `${members.length || ''} ${members.length === 1 ? 'member' : 'members'}`}
              </span>
            )}
          </div>

          {/* workbench snapshot — read-only; full controls live in the bar */}
          {(status !== 'open' || assignment || tags.length > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 bg-white px-4 py-3 text-xs">
              <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_META[status]?.cls ?? ''}`}>
                {STATUS_META[status]?.label ?? status}
              </span>
              {assignment && (
                <span className={`rounded-full px-2 py-0.5 font-medium ${agentBadgeClass(assignedAgent?.color ?? '')}`}>
                  👤 {agentLabel(assignedAgent ?? { email: assignment.agentEmail })}
                </span>
              )}
              {tags.map((t) => (
                <span key={t} className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600" dir="auto">
                  🏷 {t}
                </span>
              ))}
            </div>
          )}

          {/* shared media summary (from the messages loaded so far) */}
          {(photos > 0 || docs > 0 || voice > 0) && (
            <div className="mt-2 bg-white px-4 py-3 text-sm text-gray-600">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">Shared media</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {photos > 0 && <span>🖼 {photos} photos & videos</span>}
                {docs > 0 && <span>📄 {docs} documents</span>}
                {voice > 0 && <span>🎤 {voice} voice messages</span>}
              </div>
              <p className="mt-1 text-[11px] text-gray-400">In the messages loaded so far.</p>
            </div>
          )}

          {/* group members */}
          {conv.isGroup && members.length > 0 && (
            <div className="mt-2 bg-white px-4 py-3">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
                {members.length} members
              </div>
              <div className="space-y-1">
                {members.slice(0, 50).map((p, i) => {
                  const id = String(p.id ?? p.jid ?? '');
                  const num = id.split('@')[0] ?? '';
                  return (
                    <div key={id || i} className="flex items-center gap-2 text-sm text-gray-700">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs">
                        {num.slice(-2) || '#'}
                      </span>
                      <span className="truncate" dir="ltr">+{num}</span>
                      {(p.admin || p.isAdmin) && (
                        <span className="ml-auto shrink-0 rounded bg-gray-100 px-1.5 text-[10px] text-gray-500">admin</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* actions */}
          <div className="mt-2 bg-white">
            <button
              onClick={() => {
                onSearch();
                onClose();
              }}
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-gray-700 hover:bg-gray-50"
            >
              <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.2-5.2M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"/></svg>
              Search in this conversation
            </button>
            <button
              onClick={() => {
                onArchive();
                onClose();
              }}
              className="flex w-full items-center gap-3 border-t border-gray-100 px-4 py-3 text-left text-sm text-gray-700 hover:bg-gray-50"
            >
              <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v1a2 2 0 01-2 2M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>
              Archive chat
            </button>
            {!conv.isGroup && (
              <button
                onClick={() => {
                  onBlacklist();
                  onClose();
                }}
                className="flex w-full items-center gap-3 border-t border-gray-100 px-4 py-3 text-left text-sm text-gray-700 hover:bg-gray-50"
              >
                <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636L5.636 18.364M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                <span>
                  {blacklisted ? 'Blacklisted — edit reason' : 'Add to blacklist'}
                  <span className="block text-xs text-gray-400">
                    Campaigns skip the number; this chat keeps working
                  </span>
                </span>
              </button>
            )}
            {!conv.isGroup && (
              <button
                onClick={onToggleBlock}
                className="flex w-full items-center gap-3 border-t border-gray-100 px-4 py-3 text-left text-sm text-red-600 hover:bg-red-50"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636L5.636 18.364M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                {blocked ? 'Unblock contact' : 'Block contact'}
              </button>
            )}
          </div>

          {/* encryption footer, WhatsApp-style reassurance */}
          <p className="flex items-center justify-center gap-1.5 px-4 py-5 text-center text-xs text-gray-400">
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
            Messages are end-to-end encrypted
          </p>
        </div>
      </aside>

      {/* full-size picture lightbox */}
      {lightbox && conv.profilePicUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setLightbox(false)}
        >
          <button
            onClick={() => setLightbox(false)}
            aria-label="Close"
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full text-2xl text-white/80 hover:bg-white/10"
          >
            ✕
          </button>
          <img
            src={conv.profilePicUrl}
            alt={conv.name}
            draggable={false}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
          />
        </div>
      )}
    </>
  );
}
