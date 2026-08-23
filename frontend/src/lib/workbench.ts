import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { AgentPresenceEntry, ChatMeta } from '../types';
import { useMe } from './agents';
import { api } from './api';
import { useBusEvent } from './eventBus';
import { notifyMessage } from './notify';

/**
 * Mirror of the server's bulk-approval rule, purely for honest button labels:
 * a send over the threshold by an agent without "send without approval" lands
 * in the approval queue instead of firing. The server re-evaluates and
 * enforces regardless of what we predict here.
 */
export function useNeedsApproval(recipientCount: number): { needed: boolean; threshold: number } {
  const me = useMe();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get, staleTime: 60_000 });
  const threshold = Math.max(1, settings.data?.approvalThreshold ?? 1);
  const needed =
    !!me.data?.enabled &&
    !!me.data.email &&
    me.data.perms?.['jobs.sendWithoutApproval'] === false &&
    recipientCount > threshold;
  return { needed, threshold };
}

/**
 * v2.8 agent-workbench client plumbing: chat meta (assignment / status /
 * tags / aliases), reminders, live agent presence, and the heartbeat that
 * feeds it. All server rows are keyed by canonical jid — canonJid() maps
 * whatever jid the chat list dedup picked onto that key.
 */

const META_EVENTS = ['CHAT_ASSIGNED', 'CHAT_STATUS', 'CHAT_TAGS'] as const;

export function useChatMeta() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['chat-meta'], queryFn: api.chatMeta.get, staleTime: 30_000 });
  useBusEvent(META_EVENTS, () => void qc.invalidateQueries({ queryKey: ['chat-meta'] }));
  return q;
}

export const canonJid = (meta: ChatMeta | undefined, jid: string): string =>
  meta?.aliases[jid] ?? jid;

/**
 * Push alias pairs the chat-list dedup discovered (profile-pic joins etc.)
 * to the server, once per pair per session — server-side chat meta stays
 * findable whichever jid an Evolution event carries.
 */
const syncedPairs = new Set<string>();
export function syncAliases(aliases: Map<string, string>): void {
  const fresh: Array<[string, string]> = [];
  for (const [alt, primary] of aliases) {
    const key = `${alt}\n${primary}`;
    if (syncedPairs.has(key)) continue;
    syncedPairs.add(key);
    fresh.push([alt, primary]);
  }
  if (fresh.length) void api.chatMeta.syncAliases(fresh).catch(() => {});
}

export function useReminders(enabled = true) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['reminders'],
    queryFn: api.reminders.list,
    staleTime: 30_000,
    enabled,
  });
  useBusEvent('REMINDER_DUE', () => void qc.invalidateQueries({ queryKey: ['reminders'] }));
  return q;
}

/** Live "who is looking at which chat" map from AGENT_PRESENCE events. */
export function useAgentPresence(): AgentPresenceEntry[] {
  const [agents, setAgents] = useState<AgentPresenceEntry[]>([]);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useBusEvent('AGENT_PRESENCE', (data: any) => {
    setAgents(Array.isArray(data?.agents) ? data.agents : []);
    // server entries expire by TTL but only broadcast on heartbeats — clear
    // locally too so a lone closed tab doesn't linger on everyone's screen
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setAgents([]), 30_000);
  });
  return agents;
}

const TAB_ID = Math.random().toString(36).slice(2, 10);
const HEARTBEAT_MS = 10_000;

/**
 * Tell teammates which chat I'm in (and whether I'm typing). Heartbeats only
 * flow while agent identification is on and a chat is open.
 */
export function usePresenceHeartbeat(chatJid: string, typing: boolean): void {
  const me = useMe();
  const enabled = !!(me.data?.enabled && me.data.email);
  useEffect(() => {
    if (!enabled || !chatJid) return;
    const beat = () => void api.agentPresence(TAB_ID, chatJid, typing).catch(() => {});
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => {
      clearInterval(t);
      // leaving the chat: one last beat saying "nowhere" so the indicator
      // clears immediately instead of waiting out the TTL
      void api.agentPresence(TAB_ID, '', false).catch(() => {});
    };
  }, [enabled, chatJid, typing]);
}

/**
 * App-level listeners for workbench events that must reach the user whatever
 * tab they're on: fired reminders and approval-queue activity.
 */
export function useWorkbenchNotifications(toast: (text: string, kind?: 'ok' | 'err') => void): void {
  const qc = useQueryClient();
  const me = useMe();

  useBusEvent('REMINDER_DUE', (data: any) => {
    void qc.invalidateQueries({ queryKey: ['reminders'] });
    const mine = !data?.agentEmail || data.agentEmail === me.data?.email || !me.data?.enabled;
    if (!mine) return;
    const text = data?.note ? `Reminder: ${data.note}` : 'Chat follow-up reminder is due';
    toast(`⏰ ${text}`);
    notifyMessage(
      'Follow-up reminder',
      data?.note || 'A chat follow-up is due',
      `reminder-${data?.id}`,
      data?.chatJid ? `/?chat=${encodeURIComponent(data.chatJid)}` : undefined,
    );
  });

  useBusEvent('JOB_APPROVAL', (data: any) => {
    void qc.invalidateQueries({ queryKey: ['jobs'] });
    const action = data?.action as string;
    const self = me.data?.email && data?.by === me.data.email;
    if (action === 'submitted' && hasApprove(me) && !self)
      toast('A job is awaiting your approval');
    else if (action === 'approved' && !hasApprove(me)) toast('Your job was approved and queued');
    else if (action === 'rejected' && !hasApprove(me))
      toast(data?.reason ? `Job rejected: ${data.reason}` : 'Your job was rejected', 'err');
  });
}

const hasApprove = (me: ReturnType<typeof useMe>): boolean =>
  !!me.data && (!me.data.enabled || !me.data.email || !me.data.perms || me.data.perms['jobs.approve']);
