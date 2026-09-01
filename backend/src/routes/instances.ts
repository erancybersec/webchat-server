import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Config } from '../config.js';
import { emailFromRequest, type AgentsStore } from '../services/agents.js';
import { can } from '../services/authz.js';
import type { EvolutionApi } from '../services/evolution.js';
import { SAFE_INSTANCE, type InstanceAccess, type InstancesService } from '../services/instances.js';

/**
 * The Evolution instances visible to the requester — powers the header
 * switcher, the Settings instance pickers and the Insights storage card.
 * Message/chat counts (storage telemetry) ship only to insights viewers.
 */
export function registerInstances(
  app: FastifyInstance,
  deps: {
    cfg: Config;
    agents: AgentsStore;
    access: InstanceAccess;
    instances: InstancesService;
    evo: EvolutionApi;
    /** settings.manage — reconnecting a line affects every agent on it. */
    requireAdmin: preHandlerHookHandler;
  },
): void {
  const { cfg, agents, access, instances, evo, requireAdmin } = deps;

  /** Path-param instance, validated against this requester's grants. */
  const namedInst = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const { name } = req.params as { name: string };
    if (!access.isAllowed(req, name)) {
      void reply.code(403).send({ error: 'instance not allowed' });
      return null;
    }
    return name;
  };

  app.get('/api/instances', async (req, reply) => {
    let list;
    try {
      list = await instances.list();
    } catch (e) {
      return reply.code(502).send({ error: String((e as Error).message ?? e) });
    }
    const allowed = access.allowedForRequest(req);
    const visible = allowed === null ? list : list.filter((i) => allowed.includes(i.name));

    // counts/disconnect telemetry is an admin (insights) concern
    const email = cfg.agentsEnabled ? emailFromRequest(req) : null;
    const agent = email ? agents.byEmail(email) : null;
    const wantCounts = !agent || can(agent, 'insights.view');

    return {
      default: cfg.evo.instance,
      instances: visible.map((i) => ({
        name: i.name,
        connectionStatus: i.connectionStatus,
        profileName: i.profileName,
        number: i.number,
        ...(wantCounts ? { counts: i.counts ?? null, disconnectedAt: i.disconnectedAt ?? null } : {}),
      })),
    };
  });

  // New channel: create the Evolution instance and return its first QR, same
  // shape as the reconnect QR endpoint so the frontend can reuse one modal.
  app.post('/api/instances', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: unknown };
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || !SAFE_INSTANCE.test(name))
      return reply.code(400).send({ error: 'invalid channel name' });
    let existing;
    try {
      existing = await instances.list();
    } catch (e) {
      return reply.code(502).send({ error: String((e as Error).message ?? e) });
    }
    if (existing.some((i) => i.name === name))
      return reply.code(409).send({ error: `a channel named "${name}" already exists` });
    let r;
    try {
      r = await evo.call('/instance/create', {
        instanceName: name,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      });
    } catch (e) {
      return reply.code(502).send({ error: String((e as Error).message ?? e) });
    }
    if (!r.ok) return reply.code(r.status).send({ error: r.text.slice(0, 300) });
    instances.invalidate();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(r.text);
    } catch {
      // no QR in the response — the frontend's poll/refresh will pick it up
    }
    const qr = (data.qrcode ?? {}) as Record<string, unknown>;
    return {
      name,
      base64: typeof qr.base64 === 'string' ? qr.base64 : null,
      pairingCode: typeof qr.pairingCode === 'string' ? qr.pairingCode : null,
    };
  });

  // Permanently remove a channel: logs it out (best-effort) then deletes the
  // instance and every message/chat/contact Evolution stored for it. The
  // configured default can't be removed this way — pick a new default first.
  app.delete('/api/instances/:name', { preHandler: requireAdmin }, async (req, reply) => {
    const name = namedInst(req, reply);
    if (!name) return reply;
    if (name === cfg.evo.instance)
      return reply
        .code(400)
        .send({ error: 'cannot delete the default channel — change it in Settings → Connection first' });
    try {
      await evo.call(`/instance/logout/${encodeURIComponent(name)}`, undefined, 'DELETE');
    } catch {
      // best-effort — already logged out (or never connected) is fine, delete below still runs
    }
    let r;
    try {
      r = await evo.call(`/instance/delete/${encodeURIComponent(name)}`, undefined, 'DELETE');
    } catch (e) {
      return reply.code(502).send({ error: String((e as Error).message ?? e) });
    }
    if (!r.ok) return reply.code(r.status).send({ error: r.text.slice(0, 300) });
    instances.invalidate();
    return { ok: true };
  });

  // Reconnect flow: fetch a QR (or pairing code) for a disconnected line, then
  // poll its live connection state until Evolution reports it's back online.
  app.get('/api/instances/:name/qr', { preHandler: requireAdmin }, async (req, reply) => {
    const name = namedInst(req, reply);
    if (!name) return reply;
    let r;
    try {
      r = await evo.call(`/instance/connect/${encodeURIComponent(name)}`, undefined, 'GET');
    } catch (e) {
      return reply.code(502).send({ error: String((e as Error).message ?? e) });
    }
    if (!r.ok) return reply.code(r.status).send({ error: r.text.slice(0, 300) });
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(r.text);
    } catch {
      return reply.code(502).send({ error: 'connect returned non-JSON' });
    }
    // Evolution returns instance info (no base64/code) when already connected.
    if (!data.base64 && !data.code) return { connected: true, base64: null, pairingCode: null };
    return {
      connected: false,
      base64: typeof data.base64 === 'string' ? data.base64 : null,
      pairingCode: typeof data.pairingCode === 'string' ? data.pairingCode : null,
    };
  });

  app.get('/api/instances/:name/state', { preHandler: requireAdmin }, async (req, reply) => {
    const name = namedInst(req, reply);
    if (!name) return reply;
    let r;
    try {
      r = await evo.call(`/instance/connectionState/${encodeURIComponent(name)}`, undefined, 'GET');
    } catch (e) {
      return reply.code(502).send({ error: String((e as Error).message ?? e) });
    }
    if (!r.ok) return reply.code(r.status).send({ error: r.text.slice(0, 300) });
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(r.text);
    } catch {
      return reply.code(502).send({ error: 'connectionState returned non-JSON' });
    }
    const inst = data.instance as Record<string, unknown> | undefined;
    const state = String(inst?.state ?? data.state ?? '');
    // the switcher's instance list is TTL-cached — a scan wouldn't otherwise
    // show as connected until that cache naturally expires
    if (state === 'open') instances.invalidate();
    return { state };
  });
}
