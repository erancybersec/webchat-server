import type { Db } from '../db/index.js';

export interface Reminder {
  id: number;
  chatJid: string;
  agentEmail: string;
  dueAt: string;
  note: string;
  status: 'pending' | 'fired' | 'dismissed';
  createdAt: string;
}

interface ReminderRow {
  id: number;
  chat_jid: string;
  agent_email: string;
  due_at: string;
  note: string;
  status: string;
  created_at: string;
}

const rowToReminder = (r: ReminderRow): Reminder => ({
  id: r.id,
  chatJid: r.chat_jid,
  agentEmail: r.agent_email,
  dueAt: r.due_at,
  note: r.note,
  status: r.status as Reminder['status'],
  createdAt: r.created_at,
});

/** Follow-up reminders on chats; the scheduler poll fires the due ones. */
export class RemindersStore {
  private readonly q;

  constructor(db: Db) {
    this.q = {
      byAgent: db.prepare(`SELECT * FROM reminders WHERE agent_email = ? AND status != 'dismissed'
        ORDER BY due_at ASC`),
      all: db.prepare(`SELECT * FROM reminders WHERE status != 'dismissed' ORDER BY due_at ASC`),
      byId: db.prepare(`SELECT * FROM reminders WHERE id = ?`),
      insert: db.prepare(`INSERT INTO reminders (chat_jid, agent_email, due_at, note, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)`),
      due: db.prepare(`SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ?`),
      fireOne: db.prepare(`UPDATE reminders SET status='fired' WHERE id = ? AND status = 'pending'`),
      setStatus: db.prepare(`UPDATE reminders SET status = ? WHERE id = ?`),
      del: db.prepare(`DELETE FROM reminders WHERE id = ?`),
    };
  }

  /** empty agentEmail = all reminders (admin view). */
  list(agentEmail: string): Reminder[] {
    const rows = (agentEmail ? this.q.byAgent.all(agentEmail) : this.q.all.all()) as ReminderRow[];
    return rows.map(rowToReminder);
  }

  byId(id: number): Reminder | null {
    const r = this.q.byId.get(id) as ReminderRow | undefined;
    return r ? rowToReminder(r) : null;
  }

  create(input: { chatJid: string; agentEmail: string; dueAt: string; note: string }): Reminder {
    const r = this.q.insert.run(
      input.chatJid,
      input.agentEmail,
      new Date(input.dueAt).toISOString(),
      input.note,
      new Date().toISOString(),
    );
    return this.byId(Number(r.lastInsertRowid))!;
  }

  /** Due reminders, atomically marked fired so a poll race can't double-fire. */
  fireDue(now: Date = new Date()): Reminder[] {
    const due = (this.q.due.all(now.toISOString()) as ReminderRow[]).map(rowToReminder);
    const fired: Reminder[] = [];
    for (const r of due) {
      if (this.q.fireOne.run(r.id).changes > 0) fired.push({ ...r, status: 'fired' });
    }
    return fired;
  }

  dismiss(id: number): boolean {
    return this.q.setStatus.run('dismissed', id).changes > 0;
  }

  delete(id: number): boolean {
    return this.q.del.run(id).changes > 0;
  }
}
