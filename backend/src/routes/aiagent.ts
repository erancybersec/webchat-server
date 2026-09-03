import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Config } from '../config.js';
import type { AiAgentRunner, AiAuditLog } from '../services/aiagent.js';
import { AGE_GROUPS, DAYS_OF_WEEK, MAX_HISTORY_MESSAGES } from '../services/aiLimits.js';
import type { AiTurn } from '../services/aiProviders.js';
import type { KnowledgeInput, KnowledgeStore } from '../services/knowledge.js';
import { HHMM, ISO_DATE, type OfferingInput, type StudioDataStore } from '../services/studioData.js';

interface AiAgentDeps {
  cfg: Config;
  knowledge: KnowledgeStore;
  studio: StudioDataStore;
  runner: AiAgentRunner;
  audit: AiAuditLog;
  requireAdmin: preHandlerHookHandler;
}

const MAX_TITLE = 200;
const MAX_CONTENT = 8000;
const MAX_KEYWORDS = 500;
const MAX_NOTES = 2000;
const MAX_TEST_MESSAGE = 2000;

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * The AI agent's own admin surface: the knowledge base, the structured studio
 * data behind the four retrieval tools, the Test sandbox, and the audit log.
 *
 * Everything here is admin-only. These rows are what the AI states as fact to
 * customers, so editing them is a Settings-grade action, not a chat-agent one.
 */
export function registerAiAgent(app: FastifyInstance, deps: AiAgentDeps): void {
  const { knowledge, studio, runner, audit, requireAdmin } = deps;
  const admin = { preHandler: requireAdmin };

  // ---- knowledge base ----------------------------------------------------

  app.get('/api/ai-agent/knowledge', admin, async () => knowledge.all());

  app.post('/api/ai-agent/knowledge', admin, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const title = str(b.title, MAX_TITLE);
    const content = str(b.content, MAX_CONTENT);
    if (!title) return reply.code(400).send({ error: 'title required' });
    if (!content) return reply.code(400).send({ error: 'content required' });
    return knowledge.create({
      title,
      content,
      category: str(b.category, 80),
      keywords: str(b.keywords, MAX_KEYWORDS),
      active: b.active !== false,
    });
  });

  app.put('/api/ai-agent/knowledge/:id', admin, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!knowledge.byId(id)) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<KnowledgeInput> = {};
    if (b.title != null) {
      const title = str(b.title, MAX_TITLE);
      if (!title) return reply.code(400).send({ error: 'title must be non-empty' });
      patch.title = title;
    }
    if (b.content != null) {
      const content = str(b.content, MAX_CONTENT);
      if (!content) return reply.code(400).send({ error: 'content must be non-empty' });
      patch.content = content;
    }
    if (b.category != null) patch.category = str(b.category, 80);
    if (b.keywords != null) patch.keywords = str(b.keywords, MAX_KEYWORDS);
    if (typeof b.active === 'boolean') patch.active = b.active;
    return knowledge.update(id, patch) ?? reply.code(404).send({ error: 'not found' });
  });

  app.delete('/api/ai-agent/knowledge/:id', admin, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    return knowledge.delete(id) ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  // ---- studio data -------------------------------------------------------

  /**
   * Validated offering fields. The enums are the same ones the retrieval tools
   * match on exactly, so an operator typo like age_group "kids" has to be caught
   * HERE — a row nobody can query is a row the AI silently never mentions.
   */
  const readOffering = (
    b: Record<string, unknown>,
    partial: boolean,
  ): { value: OfferingInput } | { error: string } => {
    const out: OfferingInput = { title: '' };
    if (!partial || b.title != null) {
      const title = str(b.title, MAX_TITLE);
      if (!title) return { error: 'title required' };
      out.title = title;
    }
    if (b.ageGroup != null) {
      const v = str(b.ageGroup, 20).toLowerCase();
      if (v && !(AGE_GROUPS as readonly string[]).includes(v))
        return { error: `ageGroup must be empty or one of: ${AGE_GROUPS.join(', ')}` };
      out.ageGroup = v;
    }
    if (b.dayOfWeek != null) {
      const v = str(b.dayOfWeek, 10).toLowerCase();
      if (v && !(DAYS_OF_WEEK as readonly string[]).includes(v))
        return { error: `dayOfWeek must be empty or one of: ${DAYS_OF_WEEK.join(', ')}` };
      out.dayOfWeek = v;
    }
    if (b.time != null) {
      const v = str(b.time, 5);
      if (v && !HHMM.test(v)) return { error: 'time must be HH:MM' };
      out.time = v;
    }
    if (b.validUntil !== undefined) {
      if (b.validUntil === null || b.validUntil === '') out.validUntil = null;
      else {
        const v = str(b.validUntil, 10);
        if (!ISO_DATE.test(v)) return { error: 'validUntil must be YYYY-MM-DD' };
        out.validUntil = v;
      }
    }
    if (b.spotsLeft !== undefined) {
      if (b.spotsLeft === null || b.spotsLeft === '') out.spotsLeft = null;
      else {
        const n = Number(b.spotsLeft);
        if (!Number.isInteger(n) || n < 0)
          return { error: 'spotsLeft must be an integer >= 0, or null' };
        out.spotsLeft = n;
      }
    }
    if (b.branch != null) out.branch = str(b.branch, 100);
    if (b.level != null) out.level = str(b.level, 60);
    if (b.price != null) out.price = str(b.price, 100);
    if (b.notes != null) out.notes = str(b.notes, MAX_NOTES);
    if (typeof b.isOffer === 'boolean') out.isOffer = b.isOffer;
    if (typeof b.active === 'boolean') out.active = b.active;
    // An offer with no expiry is never returned by get_available_offers, so
    // refuse to store one rather than let the operator create a row that looks
    // live in the table and is invisible to the model.
    if (out.isOffer && !partial && out.validUntil == null)
      return { error: 'an offer needs a validUntil date (YYYY-MM-DD)' };
    return { value: out };
  };

  app.get('/api/ai-agent/offerings', admin, async () => studio.all());

  app.post('/api/ai-agent/offerings', admin, async (req, reply) => {
    const r = readOffering((req.body ?? {}) as Record<string, unknown>, false);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return studio.create(r.value);
  });

  app.put('/api/ai-agent/offerings/:id', admin, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!studio.byId(id)) return reply.code(404).send({ error: 'not found' });
    const r = readOffering((req.body ?? {}) as Record<string, unknown>, true);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return studio.update(id, r.value) ?? reply.code(404).send({ error: 'not found' });
  });

  /**
   * "I just recounted" — the ONE action that stamps availabilityUpdatedAt, kept
   * off the general edit path so a notes fix can never make a week-old spot
   * count look freshly verified.
   */
  app.post('/api/ai-agent/offerings/:id/recheck', admin, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!studio.byId(id)) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    let spots: number | null = null;
    if (b.spotsLeft !== undefined && b.spotsLeft !== null && b.spotsLeft !== '') {
      const n = Number(b.spotsLeft);
      if (!Number.isInteger(n) || n < 0)
        return reply.code(400).send({ error: 'spotsLeft must be an integer >= 0, or null' });
      spots = n;
    }
    return studio.recheckAvailability(id, spots) ?? reply.code(404).send({ error: 'not found' });
  });

  app.delete('/api/ai-agent/offerings/:id', admin, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    return studio.delete(id) ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  // ---- test sandbox ------------------------------------------------------

  /**
   * Runs the real engine and sends nothing, ever. Stateless: `history` carries
   * the whole sandbox conversation, so the multi-turn UI needs no server-side
   * session and no scratch chat rows.
   */
  app.post('/api/ai-agent/test', admin, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const message = str(b.message, MAX_TEST_MESSAGE);
    if (!message) return reply.code(400).send({ error: 'message required' });
    if (!deps.cfg.aiAgentApiKey) return reply.code(400).send({ error: 'no AI API key configured' });
    const history: AiTurn[] = Array.isArray(b.history)
      ? (b.history as Array<Record<string, unknown>>)
          .filter((t) => typeof t?.text === 'string' && (t.text as string).trim())
          .map(
            (t): AiTurn => ({
              role: t.role === 'agent' ? 'agent' : 'customer',
              text: str(t.text, MAX_TEST_MESSAGE),
            }),
          )
          .slice(-MAX_HISTORY_MESSAGES)
      : [];
    try {
      const r = await runner.runTest(message, history);
      return {
        reply: r.reply,
        handoff: r.handoff,
        handoffReason: r.handoffReason,
        invalidFinal: r.invalidFinal,
        memoryUpdates: r.memoryUpdates,
        toolsCalled: r.toolsCalled,
        knowledgeUsed: r.knowledgeUsed,
        usage: r.usage,
        rounds: r.rounds,
        latencyMs: r.latencyMs,
        provider: r.provider,
        model: r.model,
        promptHash: r.promptHash,
        error: r.error,
      };
    } catch (e) {
      return reply.code(502).send({ error: String((e as Error).message ?? e) });
    }
  });

  // ---- audit log ---------------------------------------------------------

  app.get('/api/ai-agent/audit', admin, async (req) => {
    const q = req.query as { chatJid?: string; limit?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    return { rows: audit.recent(q.chatJid?.trim() || undefined, limit) };
  });
}
