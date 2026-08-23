import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Config } from '../config.js';
import type { InstanceAccess, InstancesService } from '../services/instances.js';
import type { MaintenanceService } from '../services/maintenance.js';

interface MaintenanceDeps {
  cfg: Config;
  maintenance: MaintenanceService;
  instances: InstancesService;
  access: InstanceAccess;
  /** insights.view — the report feeds the Insights server-health card. */
  requireViewer: preHandlerHookHandler;
  /** settings.manage — cleanup mutates data. */
  requireAdmin: preHandlerHookHandler;
}

/** Storage telemetry + the retention/cleanup controls (admin surfaces). */
export function registerMaintenance(app: FastifyInstance, deps: MaintenanceDeps): void {
  const { cfg, maintenance, instances, access, requireViewer, requireAdmin } = deps;

  app.get('/api/maintenance', { preHandler: requireViewer }, async (req) => {
    const report = maintenance.report();
    // Evolution-side numbers (the Message table is where chats actually
    // accumulate) — best-effort: the report must work while Evolution is
    // down. Filtered by instance grants like /api/instances: an
    // insights-granted agent must not see lines they can't reach.
    let evolution: unknown = null;
    let evolutionError: string | null = null;
    try {
      const allowed = access.allowedForRequest(req);
      evolution = (await instances.list())
        .filter((i) => allowed === null || allowed.includes(i.name))
        .map((i) => ({
          name: i.name,
          connectionStatus: i.connectionStatus,
          counts: i.counts ?? null,
          disconnectedAt: i.disconnectedAt ?? null,
        }));
    } catch (e) {
      evolutionError = String((e as Error).message ?? e);
    }
    return {
      ...report,
      evolution,
      evolutionError,
      retentionDays: cfg.retentionDays,
      defaultInstance: cfg.evo.instance,
    };
  });

  app.post('/api/maintenance/cleanup', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { olderThanDays?: unknown; dryRun?: unknown; vacuum?: unknown };
    const days = Number(b.olderThanDays);
    if (!Number.isInteger(days) || days < 1)
      return reply.code(400).send({ error: 'olderThanDays must be an integer >= 1' });
    return maintenance.cleanup({
      olderThanDays: days,
      dryRun: !!b.dryRun,
      vacuum: !!b.vacuum,
    });
  });
}
