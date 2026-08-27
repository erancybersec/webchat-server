import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { emailFromRequest, type Agent, type AgentsStore } from './agents.js';
import type { EvolutionApi } from './evolution.js';

/**
 * Multi-instance access control. One Evolution server hosts several
 * instances (one per WhatsApp number); agents only reach the instances an
 * admin granted them, admins reach all of them, and the instance from
 * Settings is the default for everyone with no explicit grants.
 *
 * Validation deliberately works off the stored grants alone — never the live
 * instance list — so Evolution being unreachable can't lock agents out of
 * permission checks (the calls themselves will fail loudly anyway).
 */
/**
 * Instance names are string-interpolated into Evolution URL paths by every
 * gateway route — an unvalidated name is a path-injection vector that would
 * turn the deliberately-typed gateway into a generic tunnel. Validated for
 * EVERY requester, including admins and identity-less automation.
 */
export const SAFE_INSTANCE = /^[A-Za-z0-9 _.-]{1,64}$/;

export class InstanceAccess {
  constructor(
    private readonly cfg: Config,
    private readonly agents: AgentsStore,
  ) {}

  /** Instance names this agent may use; null = unrestricted. */
  allowedFor(agent: Agent | null): string[] | null {
    if (!agent || agent.role === 'admin') return null;
    const grants = (agent.instances ?? []).map((n) => n.trim()).filter(Boolean);
    if (grants.length) return grants;
    return this.cfg.evo.instance ? [this.cfg.evo.instance] : null;
  }

  /** null = unrestricted (toggle off, no Access identity, admin, unknown). */
  allowedForRequest(req: FastifyRequest): string[] | null {
    if (!this.cfg.agentsEnabled) return null;
    const email = emailFromRequest(req);
    if (!email) return null;
    return this.allowedFor(this.agents.byEmail(email));
  }

  /**
   * The effective instance for a request (`?instance=` / body.instance), or
   * null when the requester may not use it — the caller replies 403.
   * Without an explicit instance, the Settings default applies — unless the
   * agent's grants exclude the default, in which case their first granted
   * line stands in (an agent granted only line B must not be 403'd out of
   * the whole app just because the team default is line A).
   */
  resolve(req: FastifyRequest): string | null {
    const q = (req.query as Record<string, unknown> | undefined)?.instance;
    const b = (req.body as Record<string, unknown> | null | undefined)?.instance;
    const requested =
      (typeof q === 'string' && q.trim()) || (typeof b === 'string' && b.trim()) || '';
    if (requested) return this.isAllowed(req, requested) ? requested : null;
    const def = this.cfg.evo.instance;
    const allowed = this.allowedForRequest(req);
    if (allowed === null || allowed.includes(def)) return def;
    return allowed[0] ?? null;
  }

  /** Whether the requester may act on the given instance name. */
  isAllowed(req: FastifyRequest, instance: string): boolean {
    // '' = server not configured yet — pass through so the Evolution call
    // itself fails with the honest "not configured" error, as before v2.9.
    if (instance !== '' && !SAFE_INSTANCE.test(instance)) return false;
    const allowed = this.allowedForRequest(req);
    return allowed === null || allowed.includes(instance);
  }
}

export interface InstanceSummary {
  name: string;
  connectionStatus: string;
  profileName: string;
  number: string;
  /** Storage visuals (Insights) — only shipped to admins. */
  counts?: { messages: number; contacts: number; chats: number };
  disconnectedAt?: string | null;
}

const TTL_MS = 15_000;

/**
 * Cached view of Evolution's instance list. fetchInstances returns each
 * instance's API token — this service exists so only a whitelist of safe
 * fields can ever reach a browser. Failures are cached too: while Evolution
 * is down, concurrent /api/instances + /api/maintenance requests must not
 * each wait out a fresh upstream timeout.
 */
export class InstancesService {
  private cache: { at: number; list?: InstanceSummary[]; error?: string } | null = null;

  constructor(private readonly evo: EvolutionApi) {}

  async list(): Promise<InstanceSummary[]> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) {
      if (this.cache.list) return this.cache.list;
      throw new Error(this.cache.error ?? 'fetchInstances failed');
    }
    let r;
    try {
      r = await this.evo.call('/instance/fetchInstances', undefined, 'GET');
    } catch (e) {
      const error = String((e as Error).message ?? e);
      this.cache = { at: Date.now(), error };
      throw new Error(error);
    }
    if (!r.ok) {
      const error = `fetchInstances ${r.status}: ${r.text.slice(0, 120)}`;
      this.cache = { at: Date.now(), error };
      throw new Error(error);
    }
    let arr: unknown;
    try {
      arr = JSON.parse(r.text);
    } catch {
      this.cache = { at: Date.now(), error: 'fetchInstances returned non-JSON' };
      throw new Error('fetchInstances returned non-JSON');
    }
    const list = (Array.isArray(arr) ? arr : [])
      .map((i: Record<string, any>): InstanceSummary => ({
        name: String(i?.name ?? i?.instance?.instanceName ?? i?.instanceName ?? ''),
        connectionStatus: String(i?.connectionStatus ?? i?.instance?.status ?? ''),
        profileName: String(i?.profileName ?? ''),
        number: String(i?.number ?? ''),
        counts: i?._count
          ? {
              messages: Number(i._count.Message ?? 0),
              contacts: Number(i._count.Contact ?? 0),
              chats: Number(i._count.Chat ?? 0),
            }
          : undefined,
        disconnectedAt: i?.disconnectionAt ? String(i.disconnectionAt) : null,
      }))
      .filter((i) => i.name);
    this.cache = { at: Date.now(), list };
    return list;
  }

  /** Drop the cached list — call after an action that changes connection state (e.g. a QR scan). */
  invalidate(): void {
    this.cache = null;
  }
}
