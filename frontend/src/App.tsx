import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ConfirmProvider } from './components/Confirm';
import { ToastProvider, useToast } from './components/Toast';
import { agentBadgeClass, agentLabel, useMe, usePerm } from './lib/agents';
import { api } from './lib/api';
import { setActiveInstance, useActiveInstance, useInstances } from './lib/instance';
import { convTimestamp } from './lib/chatModel';
import { effectiveUnread, readMarksVersion, subscribeReadMarks } from './lib/readMarks';
import { useWorkbenchNotifications } from './lib/workbench';
import { applyTheme, initialTheme, type Theme } from './lib/theme';
import BlacklistPage from './pages/BlacklistPage';
import ChatPage from './pages/ChatPage';
import ComposePage from './pages/ComposePage';
import GroupsPage from './pages/GroupsPage';
import InsightsPage from './pages/InsightsPage';
import JobsPage from './pages/JobsPage';
import ListsPage from './pages/ListsPage';
import ProfilePage from './pages/ProfilePage';
import QuickRepliesPage from './pages/QuickRepliesPage';
import SettingsPage from './pages/SettingsPage';
import ToolsPage from './pages/ToolsPage';
import { NAV_EVENT, type NavTarget, targetFromUrl } from './lib/nav';

// heroicons outline path data, rendered as 16px strokes next to each label
const TABS = [
  { id: 'chat', label: 'Chat', icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
  { id: 'compose', label: 'Compose', icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z' },
  { id: 'lists', label: 'Lists', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
  { id: 'groups', label: 'Groups', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z' },
  { id: 'tools', label: 'Tools', icon: 'M11.42 15.17l-5.764 7.005a2.548 2.548 0 11-3.586-3.586L9.83 12.83m1.59 2.34l2.496-3.03c.527-.119 1.076-.14 1.585-.097a4.5 4.5 0 004.985-5.903l-3.187 3.187a3.004 3.004 0 01-2.25-2.25l3.187-3.187a4.5 4.5 0 00-5.903 4.985c.043.51.022 1.058-.096 1.585L9.83 12.83m1.59 2.34l-1.59-2.34' },
  { id: 'quickreplies', label: 'Quick Replies', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { id: 'scheduled', label: 'Scheduled', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
  { id: 'history', label: 'History', icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4' },
  { id: 'blacklist', label: 'Blacklist', icon: 'M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636' },
  { id: 'profile', label: 'Profile', icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z' },
  // Insights sits immediately left of Settings — the two admin surfaces grouped.
  { id: 'insights', label: 'Insights', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
  { id: 'settings', label: 'Settings', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z' },
] as const;

type TabId = (typeof TABS)[number]['id'];
type Tab = (typeof TABS)[number];

// Tabs always shown inline; everything else collapses under a "More" menu so
// the bar never overflows (it used to scroll horizontally on both platforms).
const PRIMARY_TABS: readonly string[] = ['chat', 'compose', 'groups', 'scheduled'];
// the mobile bar is too tight for four tabs beside the channel + theme controls
// (Scheduled truncates to "Schedul…"), so it drops into the More menu there —
// desktop has the room and keeps Scheduled inline.
const MOBILE_PRIMARY_TABS: readonly string[] = ['chat', 'compose', 'groups'];

const HAMBURGER = 'M4 6h16M4 12h16M4 18h16';

/**
 * Overflow menu holding the secondary tabs. Rendered in both the desktop
 * header and the mobile top strip; the dropdown lives outside any
 * overflow-scroll container so it is never clipped.
 */
function MoreMenu({
  variant,
  tabs,
  activeId,
  onPick,
}: {
  variant: 'desktop' | 'mobile';
  tabs: Tab[];
  activeId: TabId;
  onPick: (id: TabId) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  if (!tabs.length) return null;
  const activeInMore = tabs.some((t) => t.id === activeId);
  return (
    <div ref={ref} className="relative">
      {variant === 'desktop' ? (
        <button
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          title="More"
          className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            activeInMore ? 'bg-wa text-white' : 'text-gray-600 hover:bg-gray-100'
          }`}
        >
          <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d={HAMBURGER} />
          </svg>
          <span>More</span>
        </button>
      ) : (
        <button
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="More"
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
            activeInMore ? 'text-wa-dark' : 'text-gray-500'
          }`}
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d={HAMBURGER} />
          </svg>
        </button>
      )}
      {open && (
        <div
          role="menu"
          className={`absolute top-full z-30 mt-1 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg ${
            variant === 'desktop' ? 'left-0' : 'left-1'
          }`}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              role="menuitem"
              onClick={() => {
                onPick(t.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-sm ${
                activeId === t.id ? 'bg-wa text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d={t.icon} />
              </svg>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Which WhatsApp channel (Evolution instance) this browser works on. Hidden
 * unless the agent can reach more than one. Switching drops the whole query
 * cache — every Evolution-backed list belongs to the other channel.
 */
function InstanceSwitcher({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const q = useInstances();
  const active = useActiveInstance();
  const def = q.data?.default ?? '';
  const list = q.data?.instances ?? [];
  // an agent granted only non-default lines never reaches the default —
  // their first granted line is what calls effectively run on
  const defaultVisible = list.some((i) => i.name === def);
  const current = active || (defaultVisible ? def : (list[0]?.name ?? def));

  useEffect(() => {
    if (!q.data) return;
    // a stored selection that no longer exists (revoked grant, deleted
    // instance) would 403 every call — fall back, but only when the GRANTS
    // agree it's gone (a flaky instance list must not silently rehome sends
    // onto the default number)
    if (active && !list.some((i) => i.name === active)) {
      const granted = me.data?.instances;
      if (!granted || !granted.includes(active)) {
        setActiveInstance('');
        qc.clear();
        toast(`Channel “${active}” is no longer available — switched back to the default`, 'err');
      }
      return;
    }
    // lockout guard: when the default line isn't visible to this agent,
    // pin their first granted line explicitly
    if (!active && !defaultVisible && list[0]) {
      setActiveInstance(list[0].name);
      qc.clear();
    }
  }, [active, q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  // hidden with one visible line — unless that line isn't the default, in
  // which case the chip tells the agent which line they're on
  if (list.length < 2 && defaultVisible) return null;
  if (!list.length) return null;
  const connected = list.find((i) => i.name === current)?.connectionStatus === 'open';

  function pick(name: string) {
    setOpen(false);
    if (name === current) return;
    setActiveInstance(name === def ? '' : name);
    qc.clear();
    // full reload so every page/thread re-mounts cleanly on the new line —
    // the selection is persisted to localStorage and survives it
    window.location.reload();
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`WhatsApp channel: ${current}${connected ? '' : ' (disconnected)'}`}
        title={`WhatsApp channel: ${current}${connected ? '' : ' — disconnected'}`}
        className="flex items-center gap-1 rounded-full p-0.5 hover:bg-gray-100"
      >
        {/* channel avatar: initial + a status ring (green = connected) — mirrors
            the chat-row avatars so it reads as "who", not a form field */}
        <span className="relative inline-flex h-7 w-7 items-center justify-center rounded-full bg-green-100 text-xs font-semibold text-wa-dark">
          {current.slice(0, 1).toUpperCase()}
          <span
            className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-white ${connected ? 'bg-wa' : 'bg-red-500'}`}
          />
        </span>
        {!compact && <span className="max-w-[160px] truncate text-xs text-gray-700">{current}</span>}
        <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-56 rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
        >
          <div className="px-3 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-gray-400 uppercase">
            WhatsApp channel
          </div>
          {list.map((i) => {
            const isCur = i.name === current;
            const ok = i.connectionStatus === 'open';
            return (
              <button
                key={i.name}
                role="menuitem"
                onClick={() => pick(i.name)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm ${
                  isCur ? 'bg-gray-50 font-medium text-gray-900' : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${ok ? 'bg-wa' : 'bg-red-500'}`} />
                <span className="min-w-0 flex-1 truncate text-left">{i.name}</span>
                {!ok && <span className="shrink-0 text-[10px] font-medium text-red-500">offline</span>}
                {isCur && (
                  <svg className="h-4 w-4 shrink-0 text-wa-dark" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Sun / moon glyphs for the theme toggle (Heroicons outline) — replaces the
// emoji so it matches the SVG icon set used across the nav.
const THEME_ICON = {
  moon: 'M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z',
  sun: 'M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z',
} as const;

function ThemeIcon({ theme, className }: { theme: Theme; className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d={theme === 'dark' ? THEME_ICON.sun : THEME_ICON.moon} />
    </svg>
  );
}

function App() {
  const [tab, setTab] = useState<TabId>('chat');
  const [theme, setTheme] = useState<Theme>(initialTheme);
  // an open thread takes the whole mobile viewport — hide the tab bar (the
  // thread header's ← already leads back to the list)
  const [threadOpen, setThreadOpen] = useState(false);
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 60_000 });
  const me = useMe();
  useWorkbenchNotifications(useToast());
  // Tabs hide only once a permission is KNOWN to be denied — admins never see
  // tabs pop in while /api/me loads. The server enforces regardless. Insights
  // stays visible to plain agents ("My activity") unless viewOwn is revoked.
  const canSettings = usePerm('settings.manage');
  const canInsights = usePerm('insights.view');
  const canOwnInsights = usePerm('insights.viewOwn');
  const hidden = new Set<TabId>();
  if (canSettings === false) hidden.add('settings');
  if (canInsights === false && canOwnInsights === false) hidden.add('insights');
  const tabs = TABS.filter((t) => !hidden.has(t.id));
  const primaryTabs = tabs.filter((t) => PRIMARY_TABS.includes(t.id));
  const moreTabs = tabs.filter((t) => !PRIMARY_TABS.includes(t.id));
  const mobilePrimaryTabs = tabs.filter((t) => MOBILE_PRIMARY_TABS.includes(t.id));
  const mobileMoreTabs = tabs.filter((t) => !MOBILE_PRIMARY_TABS.includes(t.id));
  useEffect(() => {
    if (hidden.has(tab)) setTab('chat');
  }, [tab, canSettings, canInsights, canOwnInsights]); // eslint-disable-line react-hooks/exhaustive-deps
  // Where a clicked notification (or in-app deep link) wants to land. Cleared
  // by the destination page once it has opened the chat / focused the job, so a
  // later remount of that page doesn't re-apply a stale target.
  const [chatTarget, setChatTarget] = useState<{ jid: string; msg: string | null } | null>(null);
  const [jobTarget, setJobTarget] = useState<string | null>(null);
  const applyTarget = useCallback((t: NavTarget | null) => {
    if (!t) return;
    if (t.chat) {
      setTab('chat');
      setChatTarget({ jid: t.chat, msg: t.msg ?? null });
    } else if (t.job) {
      setTab('history');
      setJobTarget(t.job);
    } else if (t.tab && TABS.some((x) => x.id === t.tab)) {
      setTab(t.tab as TabId);
    }
  }, []);

  // Deep links: the composer's "manage all" link, and notification clicks
  // routed in-page from the service worker (see lib/nav, public/sw.js).
  useEffect(() => {
    const onNav = (e: Event) => applyTarget((e as CustomEvent<NavTarget>).detail);
    window.addEventListener(NAV_EVENT, onNav);
    return () => window.removeEventListener(NAV_EVENT, onNav);
  }, [applyTarget]);

  // Notification → exact screen. Cold start: the SW openWindow'd `/?chat=…`, so
  // read it off the URL once (then strip it so a refresh doesn't re-navigate).
  // Warm start: an already-open tab gets the destination posted by the SW.
  useEffect(() => {
    const cold = targetFromUrl(window.location.href);
    if (cold) {
      applyTarget(cold);
      window.history.replaceState(null, '', window.location.pathname);
    }
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'navigate' && typeof e.data.url === 'string') {
        applyTarget(targetFromUrl(e.data.url));
      }
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, [applyTarget]);
  const chats = useQuery({ queryKey: ['chats'], queryFn: api.chats.list, staleTime: 20_000 });
  useSyncExternalStore(subscribeReadMarks, readMarksVersion); // re-render on read-mark changes
  const unreadTotal = (Array.isArray(chats.data) ? chats.data : []).reduce(
    (sum: number, c: any) =>
      sum +
      effectiveUnread(c.remoteJid ?? c.id ?? '', c.unreadCount ?? 0, convTimestamp(c)),
    0,
  );

  // surface unread activity in the tab title + favicon
  useEffect(() => {
    document.title = unreadTotal ? `(${unreadTotal > 99 ? '99+' : unreadTotal}) WhatsApp Manager` : 'WhatsApp Manager';
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = unreadTotal ? '/favicon-unread.svg' : '/favicon.svg';
  }, [unreadTotal]);

  function toggleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  }

  return (
    <div className="flex h-dvh flex-col bg-gray-50 text-gray-900">
      {/* desktop-only: on mobile the top tab bar replaces this whole lane */}
      <header className="flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-2 shadow-sm max-md:hidden md:gap-4">
        <h1 className="shrink-0 text-lg font-bold text-wa-dark">WhatsApp Manager</h1>
        <nav className="flex gap-1 max-md:hidden" aria-label="Main">
          {primaryTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-label={t.label}
              title={t.label}
              className={`relative flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.id ? 'bg-wa text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d={t.icon} />
              </svg>
              <span>{t.label}</span>
              {t.id === 'chat' && unreadTotal > 0 && (
                <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                  {unreadTotal > 99 ? '99+' : unreadTotal}
                </span>
              )}
            </button>
          ))}
          <MoreMenu variant="desktop" tabs={moreTabs} activeId={tab} onPick={setTab} />
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-gray-400">
          <InstanceSwitcher />
          {me.data?.enabled && me.data.email && (
            <span
              title={`Signed in as ${me.data.email}`}
              className={`rounded-full px-2 py-0.5 font-medium ${agentBadgeClass(me.data.color)}`}
            >
              {agentLabel({ name: me.data.name, email: me.data.email })}
            </span>
          )}
          {health.isSuccess ? (
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-wa align-middle" />
              <span className="max-md:hidden">server </span>v{health.data.version}
            </span>
          ) : health.isError ? (
            <span role="alert">
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-red-500 align-middle" />
              offline
            </span>
          ) : (
            '…'
          )}
          <button
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="flex items-center justify-center rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
          >
            <ThemeIcon theme={theme} className="h-4 w-4" />
          </button>
        </div>
      </header>
      {/* mobile: tabs live at the TOP so they never sit next to the chat
          composer (mistaps while typing) — hidden while a thread is open.
          The tab strip scrolls horizontally so each tab keeps a real tap
          target instead of being crushed; channel + theme stay pinned. */}
      <nav
        className={`${threadOpen && tab === 'chat' ? 'hidden' : 'flex'} items-stretch border-b border-gray-200 bg-white pt-[env(safe-area-inset-top)] md:hidden`}
        aria-label="Main"
      >
        <div className="flex shrink-0 items-center border-r border-gray-100 pl-1 pr-1">
          <MoreMenu variant="mobile" tabs={mobileMoreTabs} activeId={tab} onPick={setTab} />
        </div>
        <div className="flex flex-1 overflow-x-auto">
          {mobilePrimaryTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-label={t.label}
              className={`relative flex w-[58px] shrink-0 flex-col items-center gap-0.5 py-1.5 ${
                tab === t.id ? 'text-wa-dark' : 'text-gray-400'
              }`}
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d={t.icon} />
              </svg>
              <span className="w-full truncate text-center text-[9px] font-medium">{t.label}</span>
              {t.id === 'chat' && unreadTotal > 0 && (
                <span className="absolute top-0 right-1/2 flex h-4 min-w-4 -translate-x-[-14px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
                  {unreadTotal > 99 ? '99+' : unreadTotal}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1 border-l border-gray-100 pl-1 pr-1">
          <InstanceSwitcher compact />
          <button
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500"
          >
            <ThemeIcon theme={theme} className="h-5 w-5" />
          </button>
        </div>
      </nav>
      <main className="min-h-0 flex-1">
        {tab === 'chat' && (
          <ChatPage
            onThreadOpenChange={setThreadOpen}
            openChat={chatTarget}
            onChatOpened={() => setChatTarget(null)}
          />
        )}
        {tab === 'groups' && <GroupsPage />}
        {tab === 'compose' && <ComposePage />}
        {tab === 'lists' && <ListsPage />}
        {tab === 'insights' && <InsightsPage />}
        {tab === 'tools' && <ToolsPage />}
        {tab === 'quickreplies' && <QuickRepliesPage />}
        {tab === 'scheduled' && <JobsPage scope="scheduled" onCompose={() => setTab('compose')} />}
        {tab === 'history' && (
          <JobsPage
            scope="history"
            onCompose={() => setTab('compose')}
            focusJob={jobTarget}
            onJobFocused={() => setJobTarget(null)}
          />
        )}
        {tab === 'blacklist' && <BlacklistPage />}
        {tab === 'profile' && <ProfilePage />}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}

export default function AppRoot() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  );
}
