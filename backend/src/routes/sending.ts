import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { emailFromRequest, type AgentsStore } from '../services/agents.js';
import type { ChatMetaStore } from '../services/chatmeta.js';
import type { InstanceAccess } from '../services/instances.js';
import type { Sender } from '../services/sender.js';
import { toChatJid } from '../services/phone.js';
import type { JobItem } from '../types.js';

/**
 * Native immediate send: one recipient, one item, blacklist-checked.
 * Clients pace themselves and show their own progress (short requests survive
 * tunnels/proxies better than one long-held connection).
 */
export function registerSending(
  app: FastifyInstance,
  sender: Sender,
  cfg: Config,
  agents: AgentsStore,
  meta?: ChatMetaStore,
  access?: InstanceAccess,
): void {
  app.post('/api/send', async (req, reply) => {
    const b = (req.body ?? {}) as { recipient?: string; item?: JobItem };
    if (!b.recipient || !b.item)
      return reply.code(400).send({ error: 'recipient and item required' });
    const instance = access ? access.resolve(req) : cfg.evo.instance;
    if (instance == null) return reply.code(403).send({ error: 'instance not allowed' });
    try {
      const r = await sender.sendOne(b.recipient, b.item, instance);
      if (r.status === 'skipped') return { ok: true, routed: 'skipped', skipped: true };
      // agent identification: remember which agent the Evolution message id
      // belongs to, and which chat it landed in (per-agent insights)
      if (cfg.agentsEnabled && r.messageId) {
        const email = emailFromRequest(req);
        const chatJid = toChatJid(b.recipient);
        if (email) agents.recordMessage(r.messageId, email, meta?.canon(chatJid) ?? chatJid, instance);
      }
      return { ok: true, routed: 'evo', skipped: false, messageId: r.messageId ?? null };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: String((e as Error).message ?? e) });
    }
  });
}
