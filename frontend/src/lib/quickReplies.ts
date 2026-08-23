import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { QuickReplyMediaInput, ServerQuickReply } from '../types';
import { api } from './api';

/**
 * Quick replies, server-side since v2.4 (shared across devices). The old
 * per-device localStorage list (v1 key) is imported once on first load.
 */
const KEY = 'wa_quick_replies';
const MIGRATED_KEY = 'wa_quick_replies_migrated';

export type QuickReply = ServerQuickReply;

function loadLegacyReplies(): Array<{ shortcut: string; text: string }> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (Array.isArray(raw))
      return raw
        .map((r) => ({ shortcut: String(r.shortcut ?? ''), text: String(r.text ?? '') }))
        .filter((r) => r.text);
  } catch {
    /* corrupted store — nothing to migrate */
  }
  return [];
}

export interface QuickRepliesApi {
  replies: QuickReply[];
  add: (shortcut: string, text: string, personal?: boolean, media?: QuickReplyMediaInput | null) => void;
  // media: omit to leave unchanged, null to clear, a value to replace.
  edit: (id: number, shortcut: string, text: string, media?: QuickReplyMediaInput | null) => void;
  remove: (id: number) => void;
}

/**
 * Server-side quick replies. `all` switches to the admin manage view — every
 * instance and every owner (the server enforces agents.manage and falls back
 * to the scoped roster otherwise). Mutations invalidate both query shapes since
 * the 'all' key is a child of ['quick-replies'].
 */
export function useQuickReplies(opts: { all?: boolean } = {}): QuickRepliesApi {
  const all = !!opts.all;
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: all ? ['quick-replies', 'all'] : ['quick-replies'],
    queryFn: all ? api.quickReplies.listAll : api.quickReplies.list,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['quick-replies'] });
  const migrating = useRef(false);

  // One-time migration: this device's localStorage replies move to the server
  // the first time it sees an empty server list. Only the scoped (composer)
  // view migrates — the admin all-view must not import on another agent's device.
  useEffect(() => {
    if (all || migrating.current || !query.isSuccess || query.data.length > 0) return;
    if (localStorage.getItem(MIGRATED_KEY)) return;
    const legacy = loadLegacyReplies();
    localStorage.setItem(MIGRATED_KEY, '1');
    if (!legacy.length) return;
    migrating.current = true;
    api.quickReplies
      .importMany(legacy)
      .then(invalidate)
      .catch(() => localStorage.removeItem(MIGRATED_KEY)); // retry next load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.isSuccess, query.data]);

  const add = useMutation({
    mutationFn: ({ shortcut, text, personal, media }: { shortcut: string; text: string; personal?: boolean; media?: QuickReplyMediaInput | null }) =>
      api.quickReplies.create(shortcut, text, personal, media),
    onSuccess: invalidate,
  });
  const edit = useMutation({
    mutationFn: ({ id, shortcut, text, media }: { id: number; shortcut: string; text: string; media?: QuickReplyMediaInput | null }) =>
      api.quickReplies.update(id, { shortcut, text, media }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.quickReplies.remove(id),
    onSuccess: invalidate,
  });

  return {
    replies: query.data ?? [],
    add: (shortcut, text, personal, media) => add.mutate({ shortcut, text, personal, media }),
    edit: (id, shortcut, text, media) => edit.mutate({ id, shortcut, text, media }),
    remove: (id) => remove.mutate(id),
  };
}

/**
 * {{agent_name}} in a quick reply resolves at INSERTION time, client-side —
 * the agent sees the final text in the composer before sending (job sends
 * substitute server-side instead, where the composing agent is known).
 */
export function fillAgentName(text: string, agentName: string): string {
  return text.replace(/\{\{\s*agent_name\s*(?:\|([^}]*))?\}\}/g, (_, fallback: string | undefined) =>
    agentName || (fallback ?? '').trim(),
  );
}
