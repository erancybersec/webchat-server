import type { FastifyInstance } from 'fastify';
import type { VerificationService, VerifyStatus } from '../services/verification.js';

const PAGE_MAX = 500;
/**
 * This route runs the sweep inside the request, and a sweep is paced on purpose
 * (a batch every verifyBatchPauseMs), so a big list would hold the connection
 * open past most proxy timeouts. Campaigns don't come through here — the
 * scheduler calls VerificationService.ensure() directly and has no such limit —
 * so this only keeps the manual/debug entry point from hanging.
 */
const CHECK_MAX = 200;

function asStatus(v: unknown): VerifyStatus | undefined {
  return v === 'valid' || v === 'invalid' ? v : undefined;
}

/**
 * The number-verification cache: what WhatsApp said about a number and when it
 * expires. Deliberately NOT part of /api/blacklist — see migration 019 for why
 * an observation and a policy decision are kept in separate tables.
 */
export function registerVerification(app: FastifyInstance, verification: VerificationService): void {
  const store = verification.store;

  app.get('/api/verification', async (req) => {
    const qs = (req.query ?? {}) as Record<string, string | undefined>;
    const limit = Math.min(PAGE_MAX, Math.max(1, Number(qs.limit) || 100));
    const offset = Math.max(0, Number(qs.offset) || 0);
    const { rows, total } = store.page({
      status: asStatus(qs.status),
      q: qs.q,
      limit,
      offset,
    });
    return { rows, total, counts: store.counts() };
  });

  /**
   * Verify a set of numbers now — an ad-hoc check, not the campaign path.
   * Sending a campaign verifies its own recipients with no size limit.
   */
  app.post('/api/verification/check', async (req, reply) => {
    const raw = ((req.body ?? {}) as { numbers?: unknown }).numbers;
    if (!Array.isArray(raw) || raw.length === 0)
      return reply.code(400).send({ error: 'numbers[] required' });
    if (raw.length > CHECK_MAX)
      return reply.code(413).send({
        error: `${raw.length} numbers is more than this endpoint checks at once (max ${CHECK_MAX}). Sending a campaign verifies all of its recipients automatically, with no limit.`,
      });
    const result = await verification.ensure(raw.map((n) => String(n)));
    return { ok: !result.aborted && !result.tripped, ...result };
  });

  /** Forget one verdict — the number is looked up fresh next time. */
  app.delete('/api/verification/:phone', async (req) => {
    const { phone } = req.params as { phone: string };
    return { ok: true, removed: store.remove(phone) ? 1 : 0 };
  });

  /**
   * Forget everything, or just one verdict. The escape hatch for a sweep that
   * cached bad answers: clearing 'invalid' puts those numbers back in play
   * without touching the manual blacklist or the known-good cache.
   */
  app.post('/api/verification/clear', async (req) => {
    const status = asStatus(((req.body ?? {}) as { status?: unknown }).status);
    return { ok: true, cleared: store.clear(status) };
  });
}
