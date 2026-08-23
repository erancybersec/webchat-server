import type { FastifyInstance } from 'fastify';
import type { BlacklistInput, BlacklistStore } from '../services/blacklist.js';

export function registerBlacklist(app: FastifyInstance, blacklist: BlacklistStore): void {
  app.get('/api/blacklist', async () => blacklist.list());

  // Add one or many: { phone_number, name?, why_blacklisted? } | { rows:[…] } | { numbers:[…] }
  app.post('/api/blacklist', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const incoming: BlacklistInput[] = Array.isArray(b.rows)
      ? (b.rows as BlacklistInput[])
      : Array.isArray(b.numbers)
        ? (b.numbers as unknown[]).map((p) => ({ phone_number: p }))
        : [b as BlacklistInput];
    const { added, invalid } = blacklist.addMany(incoming);
    return { ok: true, added, invalid };
  });

  app.put('/api/blacklist/:phone', async (req, reply) => {
    const { phone } = req.params as { phone: string };
    const result = blacklist.update(phone, (req.body ?? {}) as Record<string, unknown>);
    if (result === 'not_found') return reply.code(404).send({ error: 'not found' });
    if (result === 'invalid_phone') return reply.code(400).send({ error: 'invalid phone_number' });
    if (result === 'conflict') return reply.code(409).send({ error: 'phone already on list' });
    return result;
  });

  app.delete('/api/blacklist/:phone', async (req) => {
    blacklist.remove((req.params as { phone: string }).phone);
    return { ok: true };
  });

  // Bulk delete (DELETE with a body is awkward for some clients).
  app.post('/api/blacklist/delete', async (req) => {
    const raw = ((req.body ?? {}) as { phones?: unknown }).phones;
    const phones = Array.isArray(raw) ? raw : [];
    return { ok: true, removed: blacklist.removeMany(phones) };
  });
}
