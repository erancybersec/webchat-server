import { useEffect, useState } from 'react';
import { usePerm } from './agents';

// heroicons outline path data, rendered as 16px strokes next to each label
export const TABS = [
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
  // Personal to the signed-in agent (notifications, toolbar order) — distinct
  // from Profile (the shared WhatsApp account identity) and from the
  // admin-only Settings page.
  { id: 'preferences', label: 'Preferences', icon: 'M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75' },
  // Insights sits immediately left of Settings — the two admin surfaces grouped.
  { id: 'insights', label: 'Insights', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
  { id: 'settings', label: 'Settings', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z' },
] as const;

export type TabId = (typeof TABS)[number]['id'];
export type Tab = (typeof TABS)[number];

// Mirrors the backend's DEFAULT_TOOLBAR_ORDER (backend/src/services/toolbarPrefs.ts) —
// today's fixed primary tabs first, then the rest in TABS order, so anyone who
// hasn't customized yet sees exactly today's layout.
export const DEFAULT_ORDER: string[] = [
  'chat',
  'compose',
  'groups',
  'scheduled',
  'lists',
  'tools',
  'quickreplies',
  'history',
  'blacklist',
  'profile',
  'preferences',
  'insights',
];

/**
 * Which tabs this agent is allowed to see at all (permission-gated), computed
 * once and shared by the nav bar and the toolbar-order settings card so they
 * never disagree about what's visible.
 */
export function useVisibleTabs(): { tabs: Tab[]; hidden: Set<TabId> } {
  // Tabs hide only once a permission is KNOWN to be denied — admins never see
  // tabs pop in while /api/me loads. The server enforces regardless. Insights
  // stays visible to plain agents ("My activity") unless viewOwn is revoked.
  const canSettings = usePerm('settings.manage');
  const canInsights = usePerm('insights.view');
  const canOwnInsights = usePerm('insights.viewOwn');
  const hidden = new Set<TabId>();
  if (canSettings === false) hidden.add('settings');
  if (canInsights === false && canOwnInsights === false) hidden.add('insights');
  return { tabs: TABS.filter((t) => !hidden.has(t.id)), hidden };
}

/**
 * Orders `tabs` by `order` (a list of ids, e.g. from saved toolbar prefs),
 * appending anything not mentioned at the end in `tabs`' own order — so a
 * newly-shipped tab, or one dropped from a stale saved order, still shows up.
 */
export function applyOrder<T extends { id: string }>(tabs: T[], order: string[]): T[] {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const ordered: T[] = [];
  for (const id of order) {
    const t = byId.get(id);
    if (t) {
      ordered.push(t);
      byId.delete(id);
    }
  }
  for (const t of tabs) if (byId.has(t.id)) ordered.push(t);
  return ordered;
}

function slotCountFor(variant: 'desktop' | 'mobile', width: number): number {
  if (variant === 'mobile') {
    if (width < 400) return 2;
    if (width < 480) return 3;
    return 4;
  }
  if (width < 1024) return 3;
  if (width < 1280) return 5;
  return 7;
}

/**
 * How many tabs fit in the primary bar before the rest collapse into "More",
 * recomputed as the window is resized/rotated. Breakpoints are tuned so a
 * default-width desktop/mobile viewport keeps today's counts (4 and 3).
 */
export function useToolbarSlotCount(variant: 'desktop' | 'mobile'): number {
  const [count, setCount] = useState(() =>
    typeof window === 'undefined' ? 4 : slotCountFor(variant, window.innerWidth),
  );
  useEffect(() => {
    const onResize = () => setCount(slotCountFor(variant, window.innerWidth));
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [variant]);
  return count;
}
