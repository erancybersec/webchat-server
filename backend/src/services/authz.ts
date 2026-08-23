import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { emailFromRequest, type Agent, type AgentRole, type AgentsStore } from './agents.js';

/**
 * Central permission registry: role defaults + per-agent overrides
 * (agents.perms). Routes only ever name a PermissionKey; can() is the single
 * decision seam.
 */
export type PermissionKey =
  | 'settings.manage'
  | 'insights.view'
  | 'insights.viewOwn'
  | 'agents.manage'
  | 'jobs.sendWithoutApproval'
  | 'jobs.approve'
  | 'jobs.clearHistory';

export const PERMISSION_KEYS: readonly PermissionKey[] = [
  'settings.manage',
  'insights.view',
  'insights.viewOwn',
  'agents.manage',
  'jobs.sendWithoutApproval',
  'jobs.approve',
  'jobs.clearHistory',
];

const PERMS: Record<PermissionKey, readonly AgentRole[]> = {
  'settings.manage': ['admin'],
  'insights.view': ['admin'],
  'insights.viewOwn': ['admin', 'agent'],
  'agents.manage': ['admin'],
  'jobs.sendWithoutApproval': ['admin'],
  'jobs.approve': ['admin'],
  // bulk-deleting finished/cancelled jobs + their ledger is irreversible —
  // admins only by default.
  'jobs.clearHistory': ['admin'],
};

export function roleDefault(role: AgentRole, key: PermissionKey): boolean {
  return PERMS[key].includes(role);
}

export function can(agent: Agent | null, key: PermissionKey): boolean {
  if (!agent) return false;
  const override = agent.perms[key];
  return typeof override === 'boolean' ? override : roleDefault(agent.role, key);
}

/** The full resolved map — what /api/me ships for client-side gating. */
export function effectivePerms(agent: Agent | null): Record<PermissionKey, boolean> {
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, can(agent, k)])) as Record<
    PermissionKey,
    boolean
  >;
}

/**
 * Route guard (preHandler). Allows when agent identification is off (the
 * Settings toggle is the master switch) or when the request carries no Access
 * identity — LAN, bearer-token, automation; Cloudflare Access is the
 * perimeter. Otherwise the signed-in agent needs the permission.
 */
export function requirePerm(key: PermissionKey, deps: { cfg: Config; agents: AgentsStore }) {
  // cfg is read at request time — the Settings toggle mutates it live.
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!deps.cfg.agentsEnabled) return;
    const email = emailFromRequest(req);
    if (!email) return;
    if (!can(deps.agents.byEmail(email), key)) {
      return reply.code(403).send({ error: 'permission required' });
    }
  };
}
