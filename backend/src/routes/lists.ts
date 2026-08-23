import type { FastifyInstance } from 'fastify';
import { parseRecipe, type ListsStore, type MemberInput } from '../services/lists.js';

export function registerLists(app: FastifyInstance, lists: ListsStore): void {
  app.get('/api/lists', async () => lists.all());

  app.get('/api/lists/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const list = lists.byId(id);
    if (!list) return reply.code(404).send({ error: 'not found' });
    return { ...list, members: lists.members(id) };
  });

  // Create; members optional (same shape as PUT).
  app.post('/api/lists', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'name required' });
    const list = lists.create(name);
    const result = Array.isArray(b.members)
      ? lists.setMembers(list.id, b.members as MemberInput[])
      : { members: 0, invalid: [] };
    // A combined list posts the recipe next to the members it produced.
    if (b.recipe != null) lists.setRecipe(list.id, parseRecipe(b.recipe, list.id));
    return { ...lists.byId(list.id)!, ...result };
  });

  // Rename and/or replace members.
  app.put('/api/lists/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!lists.byId(id)) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.name != null) {
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name) return reply.code(400).send({ error: 'name must be a non-empty string' });
      lists.rename(id, name);
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
