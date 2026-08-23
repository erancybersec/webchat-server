import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { emailFromRequest, type AgentsStore } from '../services/agents.js';
import { can } from '../services/authz.js';
import type { InstanceAccess, InstancesService } from '../services/instances.js';

/**
 * The Evolution instances visible to the requester — powers the header
 * switcher, the Settings instance pickers and the Insights storage card.
 * Message/chat counts (storage telemetry) ship only to insights viewers.
 */
export function registerInstances(
  app: FastifyInstance,
  deps: { cfg: Config; agents: AgentsStore; access: InstanceAccess; instances: InstancesService },
): void {
  const { cfg, agents, access, instances } = deps;

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
}
