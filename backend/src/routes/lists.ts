import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { emailFromRequest, type AgentsStore } from '../services/agents.js';
import { can } from '../services/authz.js';
import type { InstanceAccess } from '../services/instances.js';
import { parseRecipe, type ListsStore, type MemberInput } from '../services/lists.js';
import type { RecipientList } from '../types.js';

export interface ListsDeps {
  cfg: Config;
  agents: AgentsStore;
  access: InstanceAccess;
}

export function registerLists(app: FastifyInstance, lists: ListsStore, deps: ListsDeps): void {
  // The signed-in agent's email, or null when there's nothing to identify
  // them by (agent id off / no Access identity) — those requests are
  // unrestricted, mirroring InstanceAccess and requirePerm.
  const identity = (req: FastifyRequest): string | null => {
    if (!deps.cfg.agentsEnabled) return null;
    return emailFromRequest(req) || null;
  };

  // The line a new list is scoped to (or the roster is filtered by): the
  // active instance, or the server default — same rule quick-replies' own
  // instanceFilter()/newInstance() use.
  const activeInstance = (req: FastifyRequest): string => {
    const def = deps.cfg.evo.instance ?? '';
    const asked = ((req.query as { instance?: string })?.instance ?? '').trim();
    return asked || def;
  };

  // Whether this request may see every list on every line, unfiltered.
  const maySeeAll = (req: FastifyRequest): boolean => {
    const email = identity(req);
    return email == null || can(deps.agents.byEmail(email), 'lists.manage');
  };

  // Admin, or the agent who created this list, may change its line_scope.
  const mayManageScope = (req: FastifyRequest, list: RecipientList): boolean => {
    const email = identity(req);
    if (email == null) return true;
    return can(deps.agents.byEmail(email), 'lists.manage') || list.createdBy === email;
  };

  // Validate a requested line_scope against what the requester may grant.
  // null (every line) is admin-only; otherwise every entry must be within
  // the requester's own InstanceAccess grants.
  const resolveScope = (
    req: FastifyRequest,
    requested: string[] | null,
  ): { value: string[] | null } | { error: string } => {
    if (requested === null) {
      return maySeeAll(req) ? { value: null } : { error: 'only an admin can grant every line' };
    }
    const allowed = deps.access.allowedForRequest(req);
    if (allowed === null) return { value: requested };
    const outside = requested.filter((n) => !allowed.includes(n));
    if (outside.length) return { error: `not allowed to grant: ${outside.join(', ')}` };
    return { value: requested };
  };

  // `lineScope: undefined` in the body = leave unset (or default-to-active on
  // create); `null` = every line; an array = specific lines.
  const readScope = (v: unknown): string[] | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (!Array.isArray(v)) return undefined;
    return v.map((x) => String(x ?? '').trim()).filter(Boolean);
  };

  app.get('/api/lists', async (req) => {
    const scope = (req.query as { scope?: string })?.scope;
    if (scope === 'all' && maySeeAll(req)) return lists.all();
    return lists.allFor(activeInstance(req));
  });

  app.get('/api/lists/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const list = lists.byId(id);
    if (!list) return reply.code(404).send({ error: 'not found' });
    return { ...list, members: lists.members(id) };
  });

  // Create; members optional (same shape as PUT). No explicit lineScope in
  // the body defaults the list to the active line.
  app.post('/api/lists', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'name required' });
    const requestedScope = readScope(b.lineScope);
    let lineScope: string[] | null;
    if (requestedScope === undefined) {
      const eff = activeInstance(req);
      lineScope = eff ? [eff] : null;
    } else {
      const r = resolveScope(req, requestedScope);
      if ('error' in r) return reply.code(403).send({ error: r.error });
      lineScope = r.value;
    }
    const list = lists.create(name, { lineScope, createdBy: identity(req) });
    const result = Array.isArray(b.members)
      ? lists.setMembers(list.id, b.members as MemberInput[])
      : { members: 0, invalid: [] };
    // A combined list posts the recipe next to the members it produced.
    if (b.recipe != null) lists.setRecipe(list.id, parseRecipe(b.recipe, list.id));
    return { ...lists.byId(list.id)!, ...result };
  });

  // Rename and/or replace members. lineScope changes are gated to admin/creator.
  app.put('/api/lists/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = lists.byId(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.name != null) {
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name) return reply.code(400).send({ error: 'name must be a non-empty string' });
      lists.rename(id, name);
    }
    const requestedScope = readScope(b.lineScope);
    if (requestedScope !== undefined) {
      if (!mayManageScope(req, existing))
        return reply.code(403).send({ error: "only an admin or this list's creator may change its visibility" });
      const r = resolveScope(req, requestedScope);
      if ('error' in r) return reply.code(403).send({ error: r.error });
      lists.setLineScope(id, r.value);
    }
    let result = { members: lists.members(id).length, invalid: [] as string[] };
    if (b.members != null) {
      if (!Array.isArray(b.members)) return reply.code(400).send({ error: 'members must be an array' });
      result = lists.setMembers(id, b.members as MemberInput[]);
    }
    // `recipe: null` freezes a combined list into a plain hand-made one; an
    // absent key leaves whatever recipe the list already carries.
    if ('recipe' in b) lists.setRecipe(id, parseRecipe(b.recipe, id));
    return { ...lists.byId(id)!, ...result };
  });

  app.delete('/api/lists/:id', async (req, reply) => {
    const removed = lists.delete((req.params as { id: string }).id);
    return removed ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });
}
