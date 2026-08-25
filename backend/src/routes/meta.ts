import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** What the sending-limits probe needs; kept as a seam so meta stays testable. */
export interface SendingLimits {
  quota: {
    state(instance: string): {
      spent: number;
      cap: number;
      remaining: number;
      activeDays: number;
      enabled: boolean;
    };
  };
  familiarity: {
    count(instance: string): number;
    split(
      recipients: readonly unknown[],
      instance: string,
    ): { known: string[]; cold: string[]; groups: string[] };
  };
}

export function registerMeta(app: FastifyInstance, cfg: Config, limits?: SendingLimits): void {
  const version = readVersion();

  // Health / mode probe — the SPA uses this to detect "server mode".
  app.get('/api/health', async () => ({ ok: true, mode: 'server', version }));

  // Current send config (no secrets).
  app.get('/api/config', async () => ({
    defaultTarget: 'evo',
    targets: ['evo'],
    delayMin: cfg.delayMinMs / 1000,
    delayMax: cfg.delayMaxMs / 1000,
  }));

  // Why a campaign is pacing the way it is: today's cold-contact ration, how
  // much of it is spent, and how many contacts this line counts as known. The
  // remaining budget is what decides whether a campaign finishes today.
  if (limits)
    app.get('/api/sending-limits', async (req) => {
      const q = (req.query as { instance?: string } | undefined)?.instance;
      const instance = (typeof q === 'string' && q.trim()) || cfg.evo.instance;
      const state = limits.quota.state(instance);
      return {
        instance,
        coldContacts: {
          ...state,
          // JSON has no Infinity — an off cap reads as null, not as zero
          remaining: Number.isFinite(state.remaining) ? state.remaining : null,
          warmupStart: cfg.coldWarmupStart,
          dailyCap: cfg.coldDailyCap,
        },
        knownContacts: limits.familiarity.count(instance),
        verification: {
          enabled: cfg.verifyEnabled,
          batchSize: cfg.verifyBatchSize,
          batchPauseMs: cfg.verifyBatchPauseMs,
          dailyCap: cfg.verifyDailyCap,
        },
      };
    });

  // Pre-flight classification of a candidate recipient list: how many have
  // never exchanged a message on this line (cold), how many already have a
  // thread (known), and how many are groups (never capped). Lets Compose show
  // a real count before send instead of only warning once the list is bigger
  // than the whole remaining ration.
  if (limits)
    app.post('/api/sending-limits/classify', async (req, reply) => {
      const body = req.body as { recipients?: unknown; instance?: string } | undefined;
      if (!Array.isArray(body?.recipients))
        return reply.code(400).send({ error: 'recipients required: string[]' });
      const q = (req.query as { instance?: string } | undefined)?.instance;
      const instance = (typeof q === 'string' && q.trim()) || body.instance || cfg.evo.instance;
      const { known, cold, groups } = limits.familiarity.split(body.recipients, instance);
      return { instance, known: known.length, cold: cold.length, groups: groups.length };
    });
}
