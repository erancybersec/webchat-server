import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';

export type AgentRole = 'admin' | 'agent';

/** Explicit per-agent grants/denies; absent key = the role's default. */
export type PermOverrides = Record<string, boolean>;

export interface Agent {
  email: string;
  name: string;
  color: string;
  active: boolean;
  role: AgentRole;
  perms: PermOverrides;
  /** Evolution instance grants; null/empty = the Settings default only. */
  instances: string[] | null;
  /**
   * The synthetic AI sender, not a person. Filtered out of the human roster and
   * the assignment picker; kept in the table so message_agents attribution can
   * badge the AI's own sends like any other sender's.
   */
  isBot: boolean;
  createdAt: string;
  lastSeenAt: string;
}

interface AgentRow {
  email: string;
  name: string;
  color: string;
  active: number;
  role: string;
  perms: string;
  instances: string | null;
  is_bot: number;
  created_at: string;
  last_seen_at: string;
}

function parsePerms(raw: string): PermOverrides {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).filter(([, val]) => typeof val === 'boolean'),
    ) as PermOverrides;
  } catch {
    return {};
  }
}

function parseInstances(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return null;
    const names = v.filter((n): n is string => typeof n === 'string' && !!n.trim());
    return names.length ? names : null;
  } catch {
    return null;
  }
}

const rowToAgent = (r: AgentRow): Agent => ({
  email: r.email,
  name: r.name,
  color: r.color,
  active: !!r.active,
  role: r.role as AgentRole,
  perms: parsePerms(r.perms),
  instances: parseInstances(r.instances),
  isBot: !!r.is_bot,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
});

/**
 * The verified identity Cloudflare Access injects on every proxied request.
 * Trusting the header matches the deployment posture (Access fronts the
 * tunnel; the container has no published host port).
 */
export function emailFromRequest(req: FastifyRequest): string | null {
  const raw = req.headers['cf-access-authenticated-user-email'];
  const email = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase() ?? '';
  return email.includes('@') ? email : null;
}

/** Re-upserting an agent on every request would write SQLite constantly. */
const SEEN_THROTTLE_MS = 60_000;

/**
 * Sales agents (auto-provisioned from the Access header) plus the message-id →
 * agent map that attributes chat-screen sends.
 */
export class AgentsStore {
  private readonly q;
  private readonly seenAt = new Map<string, number>();

  constructor(db: Db) {
    this.q = {
      // Fresh-install bootstrap: the first agent ever seen becomes admin.
      // ON CONFLICT never touches role, so revisits can't reset it. The bot row
      // is excluded from the "is this a fresh install" test — it is upserted at
      // boot, and counting it would demote the first real human to 'agent'.
      seen: db.prepare(`INSERT INTO agents (email, role, created_at, last_seen_at)
        VALUES (?, CASE WHEN EXISTS (SELECT 1 FROM agents WHERE is_bot = 0) THEN 'agent' ELSE 'admin' END, ?, ?)
        ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at`),
      // Idempotent boot upsert of the synthetic AI sender. Never touches role
      // or is_bot on conflict beyond re-asserting is_bot=1, so a rename in the
      // roster can't turn the bot row into a human one (or vice versa).
      ensureBot: db.prepare(`INSERT INTO agents (email, name, color, role, is_bot, created_at, last_seen_at)
        VALUES (?, ?, ?, 'agent', 1, ?, ?)
        ON CONFLICT(email) DO UPDATE SET is_bot = 1`),
      all: db.prepare(`SELECT * FROM agents ORDER BY created_at ASC`),
      byEmail: db.prepare(`SELECT * FROM agents WHERE email = ?`),
      update: db.prepare(`UPDATE agents SET name=@name, color=@color, active=@active, role=@role, perms=@perms, instances=@instances WHERE email=@email`),
      adminCount: db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE role='admin'`),
      recordMessage: db.prepare(`INSERT OR IGNORE INTO message_agents
        (message_id, agent_email, sent_at, chat_jid, instance) VALUES (?, ?, ?, ?, ?)`),
      forMessage: db.prepare(`SELECT m.message_id, m.agent_email, a.name, a.color
        FROM message_agents m LEFT JOIN agents a ON a.email = m.agent_email
        WHERE m.message_id = ?`),
      // who deleted a message for everyone (via our app); name/color from the roster
      recordDelete: db.prepare(`INSERT OR REPLACE INTO message_deletes
        (message_id, agent_email, chat_jid, deleted_at) VALUES (?, ?, ?, ?)`),
      forDelete: db.prepare(`SELECT d.agent_email, d.deleted_at, a.name, a.color
        FROM message_deletes d LEFT JOIN agents a ON a.email = d.agent_email
        WHERE d.message_id = ?`),
      // who last edited a message (via our app); name/color from the roster
      recordEdit: db.prepare(`INSERT OR REPLACE INTO message_editors
        (message_id, agent_email, chat_jid, edited_at) VALUES (?, ?, ?, ?)`),
      forEdit: db.prepare(`SELECT e.agent_email, a.name, a.color
        FROM message_editors e LEFT JOIN agents a ON a.email = e.agent_email
        WHERE e.message_id = ?`),
    };
  }

  /** Auto-provision / bump last_seen_at, at most once a minute per agent. */
  seen(email: string): void {
    const now = Date.now();
    if (now - (this.seenAt.get(email) ?? 0) < SEEN_THROTTLE_MS) return;
    this.seenAt.set(email, now);
    const iso = new Date(now).toISOString();
    this.q.seen.run(email, iso, iso);
  }

  all(): Agent[] {
    return (this.q.all.all() as AgentRow[]).map(rowToAgent);
  }

  /**
   * Idempotent upsert of the synthetic AI sender, called once at boot. Safe to
   * call again: an existing row keeps its name/color (the operator may have
   * restyled its badge) and only has is_bot re-asserted.
   */
  ensureBot(email: string, name: string, color: string): Agent | null {
    const iso = new Date().toISOString();
    this.q.ensureBot.run(email, name, color, iso, iso);
    return this.byEmail(email);
  }

  byEmail(email: string): Agent | null {
    const r = this.q.byEmail.get(email) as AgentRow | undefined;
    return r ? rowToAgent(r) : null;
  }

  update(
    email: string,
    patch: {
      name?: string;
      color?: string;
      active?: boolean;
      role?: AgentRole;
      perms?: PermOverrides;
      /** undefined = keep; null or [] = clear back to the default instance. */
      instances?: string[] | null;
    },
  ): Agent | null {
    const existing = this.byEmail(email);
    if (!existing) return null;
    const instances = patch.instances === undefined ? existing.instances : patch.instances;
    this.q.update.run({
      email,
      name: patch.name ?? existing.name,
      color: patch.color ?? existing.color,
      active: (patch.active ?? existing.active) ? 1 : 0,
      role: patch.role ?? existing.role,
      perms: JSON.stringify(patch.perms ?? existing.perms),
      instances: instances && instances.length ? JSON.stringify(instances) : null,
    });
    return this.byEmail(email);
  }

  /** Display name for {{agent_name}} — falls back to the email's local part. */
  displayName(email: string): string {
    const a = this.byEmail(email);
    return a?.name || email.split('@')[0] || '';
  }

  adminCount(): number {
    return (this.q.adminCount.get() as { n: number }).n;
  }

  recordMessage(messageId: string, email: string, chatJid?: string, instance?: string | null): void {
    this.q.recordMessage.run(messageId, email, new Date().toISOString(), chatJid ?? null, instance ?? null);
  }

  /** Remember which agent deleted a message for everyone (via our app). */
  recordDelete(messageId: string, email: string, chatJid?: string): void {
    this.q.recordDelete.run(messageId, email, chatJid ?? '', new Date().toISOString());
  }

  /** Remember which agent last edited a message (via our app). */
  recordEdit(messageId: string, email: string, chatJid?: string): void {
    this.q.recordEdit.run(messageId, email, chatJid ?? '', new Date().toISOString());
  }

  /**
   * Attribution for a batch of Evolution message ids (chat-bubble badges).
   * `email/name/color` is who SENT the message; `deletedBy`/`editedBy` (when
   * present) are the agents who deleted/edited it via our app. An entry is
   * returned when any is known — a message touched only from the phone has none.
   */
  forMessages(
    ids: string[],
  ): Record<
    string,
    {
      email: string;
      name: string;
      color: string;
      deletedBy?: { email: string; name: string; color: string };
      /** ISO time the delete-for-everyone was stamped (app deletes only). */
      deletedAt?: string;
      editedBy?: { email: string; name: string; color: string };
    }
  > {
    type Row = { agent_email: string; name: string | null; color: string | null };
    type DelRow = Row & { deleted_at: string };
    // name falls back to the email local part so the "Deleted/Edited by …" note
    // is never blank for agents who haven't set a display name in Settings
    const actor = (row: Row) => ({
      email: row.agent_email,
      name: row.name || row.agent_email.split('@')[0] || '',
      color: row.color ?? '',
    });
    const out: Record<
      string,
      {
        email: string;
        name: string;
        color: string;
        deletedBy?: { email: string; name: string; color: string };
        deletedAt?: string;
        editedBy?: { email: string; name: string; color: string };
      }
    > = {};
    for (const id of ids) {
      const s = this.q.forMessage.get(id) as Row | undefined;
      const d = this.q.forDelete.get(id) as DelRow | undefined;
      const e = this.q.forEdit.get(id) as Row | undefined;
      if (!s && !d && !e) continue;
      out[id] = {
        email: s?.agent_email ?? '',
        name: s?.name ?? '',
        color: s?.color ?? '',
        ...(d ? { deletedBy: actor(d), deletedAt: d.deleted_at } : {}),
        ...(e ? { editedBy: actor(e) } : {}),
      };
    }
    return out;
  }
}
