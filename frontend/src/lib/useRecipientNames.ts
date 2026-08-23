import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from './api';
import { buildContactNames, displayNumber, isGroupJid } from './chatModel';

const hasRealName = (name: string): boolean => !!name && !/^[\d\s+-]+$/.test(name);

/**
 * jid → display-name lookup for job recipients, built from the same
 * contacts/groups/chats queries the Chat tab uses (shared react-query cache —
 * no extra traffic when those tabs are warm). Every entry is keyed by the full
 * JID and by its bare local part, because jobs store recipients as bare
 * numbers while Evolution records carry full JIDs.
 */
export function useRecipientNames(): Map<string, string> {
  const contacts = useQuery({
    queryKey: ['contacts'],
    queryFn: api.chats.contacts,
    staleTime: 5 * 60_000,
  });
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.chats.groups, staleTime: 5 * 60_000 });
  const chats = useQuery({ queryKey: ['chats'], queryFn: api.chats.list, staleTime: 20_000 });

  return useMemo(() => {
    const map = new Map<string, string>();
    const add = (jid: string, name: string) => {
      if (!jid || !hasRealName(name)) return;
      map.set(jid, name);
      map.set(jid.split('@')[0]!, name);
    };
    // chats first — contact saved names and group subjects overwrite pushNames
    for (const c of Array.isArray(chats.data) ? chats.data : [])
      add(c.remoteJid ?? c.id ?? '', c.savedName || c.name || c.pushName || '');
    for (const [jid, name] of buildContactNames(Array.isArray(contacts.data) ? contacts.data : []))
      add(jid, name);
    for (const g of Array.isArray(groups.data) ? groups.data : []) add(g.id ?? '', g.subject ?? '');
    return map;
  }, [contacts.data, groups.data, chats.data]);
}

/** The known contact/group name for a recipient id, or null. */
export function recipientName(id: string, names: Map<string, string>): string | null {
  return names.get(id) ?? names.get(id.split('@')[0]!) ?? null;
}

/** Best label for one recipient id: contact/group name, else a readable number. */
export function recipientLabel(id: string, names: Map<string, string>): string {
  return recipientName(id, names) ?? (isGroupJid(id) ? id.split('@')[0]! : displayNumber(id));
}
