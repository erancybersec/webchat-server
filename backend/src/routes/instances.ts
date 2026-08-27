import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Config } from '../config.js';
import { emailFromRequest, type AgentsStore } from '../services/agents.js';
import { can } from '../services/authz.js';
import type { EvolutionApi } from '../services/evolution.js';
import type { InstanceAccess, InstancesService } from '../services/instances.js';

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
