import type { Db } from '../db/index.js';
import { unwrapEvent } from './envelope.js';
import type { EventRelay } from './events.js';

export type ChatStatus = 'open' | 'pending' | 'resolved';
export const CHAT_STATUSES: readonly ChatStatus[] = ['open', 'pending', 'resolved'];

export interface ChatAssignment {
  agentEmail: string;
  assignedBy: string;
  assignedAt: string;
}

export interface ChatStatusEntry {
  status: ChatStatus;
  changedBy: string;
  changedAt: string;
}

export interface ChatNote {
  id: number;
  chatJid: string;
  agentEmail: string;
  body: string;
  createdAt: string;
}

type Logger = (msg: string) => void;

/** Phone jid beats @lid; otherwise the caller's primary stands. */
function pickPrimary(a: string, b: string): [primary: string, alt: string] {
  if (a.endsWith('@s.whatsapp.net') && !b.endsWith('@s.whatsapp.net')) return [a, b];
  if (b.endsWith('@s.whatsapp.net') && !a.endsWith('@s.whatsapp.net')) return [b, a];
  return [a, b];
}

/**
 * Everything keyed by a chat: assignment, workflow status, tags, notes — plus
 * the jid alias map that keeps those rows findable whichever of a contact's
 * JIDs (@lid / @s.whatsapp.net) an event or client happens to carry. Every
 * read and write goes through canon().
 *
 * The status overlay is deliberately independent of read/unread, which keeps
 * mimicking WhatsApp Web untouched.
 */
export class ChatMetaStore {
  private readonly q;

  constructor(private readonly db: Db) {
    this.q = {
      aliasGet: db.prepare(`SELECT primary_jid FROM jid_aliases WHERE alt_jid = ?`),
      aliasAll: db.prepare(`SELECT alt_jid, primary_jid FROM jid_aliases`),
      aliasPut: db.prepare(`INSERT INTO jid_aliases (alt_jid, primary_jid) VALUES (?, ?)
        ON CONFLICT(alt_jid) DO UPDATE SET primary_jid = excluded.primary_jid`),
      aliasRepoint: db.prepare(`UPDATE jid_aliases SET primary_jid = ? WHERE primary_jid = ?`),

      assignAll: db.prepare(`SELECT * FROM chat_assignments`),
      assignGet: db.prepare(`SELECT agent_email FROM chat_assignments WHERE chat_jid = ?`),
      assignPut: db.prepare(`INSERT INTO chat_assignments (chat_jid, agent_email, assigned_by, assigned_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_jid) DO UPDATE SET agent_email = excluded.agent_email,
          assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at`),
      assignDel: db.prepare(`DELETE FROM chat_assignments WHERE chat_jid = ?`),
      assignDelByAgent: db.prepare(`DELETE FROM chat_assignments WHERE agent_email = ?`),

      statusAll: db.prepare(`SELECT * FROM chat_status`),
      statusGet: db.prepare(`SELECT * FROM chat_status WHERE chat_jid = ?`),
      statusPut: db.prepare(`INSERT INTO chat_status (chat_jid, status, changed_by, changed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_jid) DO UPDATE SET status = excluded.status,
          changed_by = excluded.changed_by, changed_at = excluded.changed_at`),

      tagsAll: db.prepare(`SELECT chat_jid, tag FROM chat_tags ORDER BY tag COLLATE NOCASE`),
      tagsDel: db.prepare(`DELETE FROM chat_tags WHERE chat_jid = ?`),
      tagPut: db.prepare(`INSERT OR IGNORE INTO chat_tags (chat_jid, tag, created_at) VALUES (?, ?, ?)`),
      taggedChats: db.prepare(`SELECT chat_jid FROM chat_tags WHERE tag = ? COLLATE NOCASE`),

      notesByChat: db.prepare(`SELECT * FROM chat_notes WHERE chat_jid = ? ORDER BY created_at ASC, id ASC`),
      noteById: db.prepare(`SELECT * FROM chat_notes WHERE id = ?`),
      noteInsert: db.prepare(`INSERT INTO chat_notes (chat_jid, agent_email, body, created_at) VALUES (?, ?, ?, ?)`),
      noteDel: db.prepare(`DELETE FROM chat_notes WHERE id = ?`),
    };
  }

  // ---- jid aliases -------------------------------------------------------

  /** Resolve any of a contact's JIDs to the canonical one rows are keyed by. */
  canon(jid: string): string {
    const r = this.q.aliasGet.get(jid) as { primary_jid: string } | undefined;
    return r?.primary_jid ?? jid;
  }

  aliases(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.q.aliasAll.all() as Array<{ alt_jid: string; primary_jid: string }>) {
      out[r.alt_jid] = r.primary_jid;
    }
    return out;
  }

  /**
   * Record that two JIDs are the same contact. Direction is normalized
   * (phone jid wins over @lid) and existing rows pointing at the loser are
   * re-pointed, so canon() is always a single hop.
   */
  learnAlias(a: string, b: string): void {
    if (!a || !b || a === b) return;
    const [primary, alt] = pickPrimary(this.canon(a), this.canon(b));
    if (primary === alt) return;
    this.db.transaction(() => {
      this.q.aliasPut.run(alt, primary);
      this.q.aliasRepoint.run(primary, alt);
    })();
  }

  // ---- assignment --------------------------------------------------------

  assignments(): Record<string, ChatAssignment> {
    const out: Record<string, ChatAssignment> = {};
    for (const r of this.q.assignAll.all() as Array<{
      chat_jid: string;
      agent_email: string;
      assigned_by: string;
      assigned_at: string;
    }>) {
      out[r.chat_jid] = {
        agentEmail: r.agent_email,
        assignedBy: r.assigned_by,
        assignedAt: r.assigned_at,
      };
    }
    return out;
  }

  /** The agent a chat is assigned to, or null when unassigned. canon()-keyed. */
  assigneeOf(jid: string): string | null {
    const r = this.q.assignGet.get(this.canon(jid)) as { agent_email: string } | undefined;
    return r?.agent_email || null;
  }

  /** agentEmail null/'' = unassign. Returns the canonical jid written. */
  assign(jid: string, agentEmail: string | null, by: string): string {
    const key = this.canon(jid);
    if (agentEmail) this.q.assignPut.run(key, agentEmail, by, new Date().toISOString());
    else this.q.assignDel.run(key);
    return key;
  }

  /** Agent deactivated — their chats must not route notifications to nobody. */
  unassignAgent(agentEmail: string): number {
    return this.q.assignDelByAgent.run(agentEmail).changes;
  }

  // ---- workflow status ---------------------------------------------------

  statuses(): Record<string, ChatStatusEntry> {
    const out: Record<string, ChatStatusEntry> = {};
    for (const r of this.q.statusAll.all() as Array<{
      chat_jid: string;
      status: string;
      changed_by: string;
      changed_at: string;
    }>) {
      out[r.chat_jid] = {
        status: r.status as ChatStatus,
        changedBy: r.changed_by,
        changedAt: r.changed_at,
      };
    }
    return out;
  }

  setStatus(jid: string, status: ChatStatus, by: string): string {
    const key = this.canon(jid);
    this.q.statusPut.run(key, status, by, new Date().toISOString());
    return key;
  }

  /**
   * Inbound message on a pending/resolved chat reopens it. Returns the
   * canonical jid when something changed (the caller broadcasts), else null.
   */
  reopenOnInbound(jid: string): string | null {
    const key = this.canon(jid);
    const r = this.q.statusGet.get(key) as { status: string } | undefined;
    if (!r || r.status === 'open') return null;
    this.q.statusPut.run(key, 'open', '', new Date().toISOString());
    return key;
  }

  // ---- tags --------------------------------------------------------------

  tags(): { byChat: Record<string, string[]>; all: string[] } {
    const byChat: Record<string, string[]> = {};
    const all = new Set<string>();
    for (const r of this.q.tagsAll.all() as Array<{ chat_jid: string; tag: string }>) {
      (byChat[r.chat_jid] ??= []).push(r.tag);
      all.add(r.tag);
    }
    return { byChat, all: [...all].sort((a, b) => a.localeCompare(b)) };
  }

  setTags(jid: string, tags: string[]): string {
    const key = this.canon(jid);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.q.tagsDel.run(key);
      for (const t of tags) this.q.tagPut.run(key, t, now);
    })();
    return key;
  }

  /** Canonical jids carrying a tag — Compose's "add by tag" audience. */
  chatsWithTag(tag: string): string[] {
    return (this.q.taggedChats.all(tag) as Array<{ chat_jid: string }>).map((r) => r.chat_jid);
  }

  // ---- notes -------------------------------------------------------------

  notes(jid: string): ChatNote[] {
    return (this.q.notesByChat.all(this.canon(jid)) as Array<{
      id: number;
      chat_jid: string;
      agent_email: string;
      body: string;
      created_at: string;
    }>).map((r) => ({
      id: r.id,
      chatJid: r.chat_jid,
      agentEmail: r.agent_email,
      body: r.body,
      createdAt: r.created_at,
    }));
  }

  addNote(jid: string, agentEmail: string, body: string): ChatNote {
    const r = this.q.noteInsert.run(this.canon(jid), agentEmail, body, new Date().toISOString());
    const row = this.q.noteById.get(Number(r.lastInsertRowid)) as {
      id: number;
      chat_jid: string;
      agent_email: string;
      body: string;
      created_at: string;
    };
    return {
      id: row.id,
      chatJid: row.chat_jid,
      agentEmail: row.agent_email,
      body: row.body,
      createdAt: row.created_at,
    };
  }

  noteOwner(id: number): string | null {
    const r = this.q.noteById.get(id) as { agent_email: string } | undefined;
    return r ? r.agent_email : null;
  }

  deleteNote(id: number): boolean {
    return this.q.noteDel.run(id).changes > 0;
  }
}

interface IncomingRecord {
  key?: { remoteJid?: string; remoteJidAlt?: string; fromMe?: boolean };
}

/**
 * Relay listener: learns jid aliases from incoming events and auto-reopens
 * pending/resolved chats when the customer writes again. Only active while
 * the events relay is enabled — same posture as opt-out/acks.
 */
export function attachChatWatcher(
  relay: EventRelay,
  meta: ChatMetaStore,
  onReopen: (canonJid: string) => void,
  log: Logger = () => {},
  /** Live default-instance getter — chat meta is jid-keyed across the whole
   * app, so a secondary instance's traffic must not reopen chats or feed the
   * alias map (a reconnecting instance replays history). */
  defaultInstance: () => string = () => '',
): void {
  relay.subscribe((e) => {
    if (e.event !== 'MESSAGES_UPSERT' && e.event !== 'messages.upsert') return;
    const { instance, records } = unwrapEvent(e.data);
    const def = defaultInstance();
    if (instance !== undefined && def && instance !== def) return;
    for (const record of records as IncomingRecord[]) {
      try {
        const jid = record.key?.remoteJid ?? '';
        if (!jid || jid === 'status@broadcast') continue;
        const alt = record.key?.remoteJidAlt ?? '';
        if (alt && alt !== jid) meta.learnAlias(jid, alt);
        // own outbound sends must not reopen a chat the agent just resolved
        if (record.key?.fromMe) continue;
        const reopened = meta.reopenOnInbound(jid);
        if (reopened) onReopen(reopened);
      } catch (err) {
        log(`[chatwatch] error: ${String(err)}`);
      }
    }
  });
}
