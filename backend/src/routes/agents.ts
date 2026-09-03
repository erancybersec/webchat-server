import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Config } from '../config.js';
import {
  emailFromRequest,
  type AgentRole,
  type AgentsStore,
  type PermOverrides,
} from '../services/agents.js';
import { effectivePerms, PERMISSION_KEYS, roleDefault, type PermissionKey } from '../services/authz.js';
import type { ChatMetaStore } from '../services/chatmeta.js';
import type { InstanceAccess } from '../services/instances.js';

/**
 * Agent identification (Settings toggle). Identity comes from the Cloudflare
 * Access header — agents are auto-provisioned on first request; Settings
 * edits their display name / badge color / role / permission overrides.
 */
export function registerAgents(
  app: FastifyInstance,
  agents: AgentsStore,
  cfg: Config,
  requireAdmin: preHandlerHookHandler,
  deps?: { meta?: ChatMetaStore; emit?: (event: string, data: unknown) => void; access?: InstanceAccess },
): void {
  // Who am I — drives the "signed in as" chip and client-side gating.
  // role: null = no Access identity → the client treats it as unrestricted,
  // mirroring the server's allow rule (perms all true for the same reason).
  app.get('/api/me', async (req) => {
    if (!cfg.agentsEnabled)
      return {
        enabled: false,
        email: null,
        name: '',
        color: '',
        role: null,
        perms: null,
        instances: null,
        defaultInstance: cfg.evo.instance,
      };
    const email = emailFromRequest(req);
    const agent = email ? agents.byEmail(email) : null;
    return {
      enabled: true,
      email,
      name: agent?.name ?? '',
      color: agent?.color ?? '',
      role: agent?.role ?? null,
      perms: agent ? effectivePerms(agent) : null,
      // null = unrestricted (admin / no identity)
      instances: deps?.access ? deps.access.allowedFor(agent) : null,
      defaultInstance: cfg.evo.instance,
    };
  });

  // Open to all agents: JobsPage resolves "sent by" chips from this roster.
  // Served even while the toggle is off so history stays explorable.
  // Instance grants are admin business — chips don't need them, and they'd
  // tell every agent which lines exist and who reaches them.
  app.get('/api/agents', async (req) => {
    const email = cfg.agentsEnabled ? emailFromRequest(req) : null;
    const requester = email ? agents.byEmail(email) : null;
    const isAdmin = !requester || requester.role === 'admin';
    // The synthetic AI sender is filtered out here rather than in each client:
    // this is the HUMAN roster (the "sent by" chips, the assignment picker, the
    // Settings agent table), and nothing in it should offer to assign a chat to
    // a bot. Its chat-bubble badge is unaffected — that comes from
    // /api/message-agents, which reads the row directly.
    return agents
      .all()
      .filter((a) => !a.isBot)
      .map((a) => ({
        ...a,
        instances: isAdmin ? a.instances : null,
        effectivePerms: effectivePerms(a),
      }));
  });

  app.put('/api/agents/:email', { preHandler: requireAdmin }, async (req, reply) => {
    const email = decodeURIComponent((req.params as { email: string }).email).toLowerCase();
    const b = (req.body ?? {}) as {
      name?: unknown;
      color?: unknown;
      active?: unknown;
      role?: unknown;
      perms?: unknown;
      instances?: unknown;
    };
    if (b.role !== undefined && b.role !== 'admin' && b.role !== 'agent')
      return reply.code(400).send({ error: "role must be 'admin' or 'agent'" });
    const role = b.role as AgentRole | undefined;
    // Lockout guard: someone must always be able to reach Settings.
    if (role === 'agent' && agents.byEmail(email)?.role === 'admin' && agents.adminCount() === 1)
      return reply.code(409).send({ error: 'cannot demote the last admin' });

    // Permission overrides: only known keys, only booleans, and only stored
    // when they differ from the (target) role's default — the JSON stays a
    // diff, so changing a role later changes the unset keys with it.
    let perms: PermOverrides | undefined;
    if (b.perms !== undefined) {
      if (!b.perms || typeof b.perms !== 'object' || Array.isArray(b.perms))
        return reply.code(400).send({ error: 'perms must be an object of booleans' });
      const targetRole = role ?? agents.byEmail(email)?.role ?? 'agent';
      perms = {};
      for (const [key, value] of Object.entries(b.perms)) {
        if (!PERMISSION_KEYS.includes(key as PermissionKey))
          return reply.code(400).send({ error: `unknown permission: ${key}` });
        if (typeof value !== 'boolean')
          return reply.code(400).send({ error: `perms.${key} must be a boolean` });
        if (value !== roleDefault(targetRole, key as PermissionKey)) perms[key] = value;
      }
    }

    // Instance grants: an array of names; null/[] clears back to the default.
    let instances: string[] | null | undefined;
    if (b.instances !== undefined) {
      if (b.instances === null) instances = null;
      else if (
        Array.isArray(b.instances) &&
        b.instances.every((n) => typeof n === 'string')
      )
        instances = (b.instances as string[]).map((n) => n.trim()).filter(Boolean);
      else return reply.code(400).send({ error: 'instances must be an array of names or null' });
    }

    const wasActive = agents.byEmail(email)?.active;
    const updated = agents.update(email, {
      name: typeof b.name === 'string' ? b.name.trim() : undefined,
      color: typeof b.color === 'string' ? b.color.trim() : undefined,
      active: typeof b.active === 'boolean' ? b.active : undefined,
      role,
      perms,
      instances,
    });
    if (!updated) return reply.code(404).send({ error: 'unknown agent' });

    // A deactivated agent's chats must not route notifications to nobody.
    // jid:null = bulk change, clients refetch the assignment map.
    if (wasActive && !updated.active && deps?.meta) {
      const released = deps.meta.unassignAgent(email);
      if (released) deps.emit?.('CHAT_ASSIGNED', { jid: null, agentEmail: null, by: '' });
    }
    return { ...updated, effectivePerms: effectivePerms(updated) };
  });

  // Batch attribution for chat bubbles: Evolution message ids → agent.
  app.post('/api/message-agents', async (req, reply) => {
    if (!cfg.agentsEnabled) return {};
    const b = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(b.ids)) return reply.code(400).send({ error: 'ids required' });
    const ids = b.ids.filter((id): id is string => typeof id === 'string' && !!id).slice(0, 500);
    return agents.forMessages(ids);
  });
}
