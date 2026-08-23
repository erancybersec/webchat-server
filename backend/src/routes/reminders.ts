import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { emailFromRequest, type AgentsStore } from '../services/agents.js';
import type { RemindersStore } from '../services/reminders.js';

interface RemindersDeps {
  cfg: Config;
  agents: AgentsStore;
  reminders: RemindersStore;
}

/**
 * Follow-up reminders on chats. Agents see their own; admins see all; with
 * agent identification off there are no identities, so everything is shared.
 */
export function registerReminders(app: FastifyInstance, deps: RemindersDeps): void {
  const { cfg, agents, reminders } = deps;

  const identity = (req: FastifyRequest): { email: string; admin: boolean } => {
    if (!cfg.agentsEnabled) return { email: '', admin: true };
    const email = emailFromRequest(req) ?? '';
    return { email, admin: !email || agents.byEmail(email)?.role === 'admin' };
  };

  app.get('/api/reminders', async (req) => {
    const { email, admin } = identity(req);
    return reminders.list(admin ? '' : email);
  });

  app.post('/api/reminders', async (req, reply) => {
    const b = (req.body ?? {}) as { chatJid?: unknown; dueAt?: unknown; note?: unknown };
    if (typeof b.chatJid !== 'string' || !b.chatJid)
      return reply.code(400).send({ error: 'chatJid required' });
    if (typeof b.dueAt !== 'string' || Number.isNaN(new Date(b.dueAt).getTime()))
      return reply.code(400).send({ error: 'valid dueAt required' });
    return reminders.create({
      chatJid: b.chatJid,
      agentEmail: identity(req).email,
      dueAt: b.dueAt,
      note: String(b.note ?? '').slice(0, 500),
    });
  });

  app.post('/api/reminders/:id/dismiss', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const r = reminders.byId(id);
    if (!r) return reply.code(404).send({ error: 'not found' });
    const { email, admin } = identity(req);
    if (!admin && r.agentEmail && r.agentEmail !== email)
      return reply.code(403).send({ error: 'permission required' });
    reminders.dismiss(id);
    return reminders.byId(id);
  });

  app.delete('/api/reminders/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const r = reminders.byId(id);
    if (!r) return reply.code(404).send({ error: 'not found' });
    const { email, admin } = identity(req);
    if (!admin && r.agentEmail && r.agentEmail !== email)
      return reply.code(403).send({ error: 'permission required' });
    reminders.delete(id);
    return { ok: true };
  });
}
