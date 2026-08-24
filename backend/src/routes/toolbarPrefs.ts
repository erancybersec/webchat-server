import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { emailFromRequest } from '../services/agents.js';
import type { ToolbarPrefsStore } from '../services/toolbarPrefs.js';

/**
 * Per-person nav tab order. No admin gate — every agent manages their own,
 * same posture as /api/notify-prefs.
 */
export function registerToolbarPrefs(
  app: FastifyInstance,
  deps: { cfg: Config; prefs: ToolbarPrefsStore },
): void {
  const { cfg, prefs } = deps;

  const subscriber = (req: FastifyRequest): string =>
    cfg.agentsEnabled ? (emailFromRequest(req) ?? '') : '';

  app.get('/api/toolbar-prefs', async (req) => prefs.get(subscriber(req)));

  app.put('/api/toolbar-prefs', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(b.order)) return reply.code(400).send({ error: 'order must be an array' });
    return prefs.set(subscriber(req), b.order);
  });
}
