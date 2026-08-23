import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { ChatMeta, Me } from '../types';
import { api } from './api';
import { displayNumber, parseMessage } from './chatModel';
import { useBusEvent } from './eventBus';
import { getActiveInstance } from './instance';
import { messageGate, notifyMessage } from './notify';

/** Presence per jid: 'composing' | 'recording' | 'available' | ... */
export type PresenceMap = Record<string, string>;

const MESSAGE_EVENTS = ['MESSAGES_UPSERT', 'messages.upsert', 'MESSAGES_UPDATE', 'messages.update'] as const;
// CHAT_READ is our own app event — another agent read/unread a chat, so the
// shared unread badge changed; refetch the list to pick it up.
const CHAT_EVENTS = ['CHATS_UPSERT', 'chats.upsert', 'CHATS_UPDATE', 'chats.update', 'CHAT_READ'] as const;
const PRESENCE_EVENTS = ['PRESENCE_UPDATE', 'presence.update'] as const;
const PRESENCE_TTL_MS = 10_000;

/**
 * Evolution's envelope ({instance, data}) → record list. Mirrors the
 * backend's unwrapEvent incl. the {messages:[…]} upsert variant.
 */
function unwrapClient(data: any): { instance?: string; records: any[] } {
  const instance = typeof data?.instance === 'string' ? data.instance : undefined;
  const payload = instance !== undefined && data && typeof data === 'object' && 'data' in data ? data.data : data;
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.messages)
      ? payload.messages
      : payload == null
        ? []
        : [payload];
  return { instance, records };
}

function extractJid(data: any): string {
  return (
    data?.key?.remoteJid ??
    data?.remoteJid ??
    data?.id ??
    (data?.presences ? Object.keys(data.presences)[0] : '') ??
    ''
  );
}

function extractPresence(data: any): string {
  if (data?.presences) {
    const first = Object.values(data.presences)[0] as any;
    return first?.lastKnownPresence ?? '';
  }
  return data?.presence ?? data?.lastKnownPresence ?? '';
}

/**
 * Live updates over the backend's SSE relay (shared bus connection).
 * Refreshes the chats list and the affected thread on message events; tracks
 * short-lived presence (typing / recording) per chat. Degrades silently when
 * the relay is disabled.
 */
export function useEvents(): PresenceMap {
  const qc = useQueryClient();
  const [presence, setPresence] = useState<PresenceMap>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // This person's notification prefs — populated so the in-page notifier honors
  // them (group/DM mute, quiet hours, keyword alerts) the same way the server's
  // push path does. Until loaded, the gate falls back to "notify".
  const notifyPrefs = useQuery({ queryKey: ['notifyPrefs'], queryFn: api.notifyPrefs.get, staleTime: 300_000 });

  // Events from OTHER instances must neither refetch the lists nor notify —
  // the server filters for restricted agents, but admins get the firehose.
  const foreign = (instance: string | undefined): boolean => {
    if (instance === undefined) return false;
    const eff =
      getActiveInstance() || qc.getQueryData<Me>(['me'])?.defaultInstance || '';
    return !!eff && instance !== eff;
  };

  useBusEvent(MESSAGE_EVENTS, (data: any) => {
    const { instance, records } = unwrapClient(data);
    if (foreign(instance)) return;
    void qc.invalidateQueries({ queryKey: ['chats'] });
    // records live under @lid or phone JIDs interchangeably while the open
    // thread is keyed by the dedup winner — keying the invalidation on the
    // record's JID misses it, so refresh every mounted messages query
    void qc.invalidateQueries({ queryKey: ['messages'] });
    // incoming messages → notification (shown only when the app is hidden).
    // Chats assigned to ANOTHER agent stay quiet for me — the assignee gets
    // the ping; unassigned chats keep notifying everyone.
    const meta = qc.getQueryData<ChatMeta>(['chat-meta']);
    const me = qc.getQueryData<Me>(['me']);
    for (const record of records) {
      const msg = record ? parseMessage(record) : null;
      // a delete-for-everyone now parses to a real (content-nulled) bubble, not a
      // dropped record — it must not masquerade as a new incoming message ping.
      if (msg && !msg.fromMe && !msg.deletedBySender && msg.type !== 'reaction' && msg.type !== 'edit' && msg.type !== 'delete') {
        const canon = meta?.aliases[msg.remoteJid] ?? msg.remoteJid;
        const assignee = meta?.assignments[canon]?.agentEmail;
        if (assignee && me?.enabled && me.email && assignee !== me.email) continue;
        // honor this person's category/quiet/keyword prefs (mirrors the server)
        const isGroup = msg.remoteJid.endsWith('@g.us');
        if (!messageGate(notifyPrefs.data, { isGroup, text: msg.text || msg.caption || '' })) continue;
        const who = msg.pushName || displayNumber(msg.senderJid || msg.remoteJid);
        const preview =
          msg.text || msg.caption || (msg.hasMedia ? `📎 ${msg.type}` : msg.type);
        // click opens this conversation, scrolled to this message (mirrors the
        // server push url so in-page and push notifications behave the same)
        const url =
          `/?chat=${encodeURIComponent(msg.remoteJid)}` +
          (msg.id ? `&msg=${encodeURIComponent(msg.id)}` : '');
        notifyMessage(who, preview.slice(0, 140), msg.remoteJid, url);
      }
    }
  });

  useBusEvent(CHAT_EVENTS, (data: any) => {
    if (foreign(unwrapClient(data).instance)) return;
    void qc.invalidateQueries({ queryKey: ['chats'] });
  });

  useBusEvent(PRESENCE_EVENTS, (data: any) => {
    if (foreign(unwrapClient(data).instance)) return;
    const payload = data?.data ?? data;
    const jid = extractJid(payload);
    const state = extractPresence(payload);
    if (!jid || !state) return;
    setPresence((p) => ({ ...p, [jid]: state }));
    clearTimeout(timers.current[jid]);
    timers.current[jid] = setTimeout(
      () =>
        setPresence((p) => {
          const { [jid]: _gone, ...rest } = p;
          return rest;
        }),
      PRESENCE_TTL_MS,
    );
  });

  return presence;
}
