import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { emailFromRequest, type AgentsStore } from '../services/agents.js';
import { can } from '../services/authz.js';
import type { MediaInput, QuickRepliesStore } from '../services/quickreplies.js';

const MEDIATYPES = new Set(['image', 'video', 'audio', 'document']);

/** Validate a media descriptor off the request body. null = explicit clear. */
function readMedia(raw: unknown): { value: MediaInput | null } | { error: string } {
  if (raw == null) return { value: null };
  if (typeof raw !== 'object') return { error: 'media must be an object' };
  const m = raw as Record<string, unknown>;
  const kind = m.kind === 'url' ? 'url' : m.kind === 'file' ? 'file' : null;
  if (!kind) return { error: 'media.kind must be "file" or "url"' };
  const mediatype = String(m.mediatype ?? '');
  if (!MEDIATYPES.has(mediatype)) return { error: 'invalid media.mediatype' };
  const mimetype = typeof m.mimetype === 'string' ? m.mimetype.trim() : '';
  if (!mimetype) return { error: 'media.mimetype required' };
  const filename = typeof m.filename === 'string' && m.filename.trim() ? m.filename.trim() : undefined;
  const base: MediaInput = { kind, mediatype: mediatype as MediaInput['mediatype'], mimetype, filename };
  if (kind === 'url') {
    const url = typeof m.url === 'string' ? m.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) return { error: 'media.url must be an http(s) URL' };
    return { value: { ...base, url } };
  }
  const base64 = typeof m.base64 === 'string' ? m.base64 : '';
  if (!base64) return { error: 'media.base64 required for an uploaded file' };
  return { value: { ...base, base64 } };
}

export function registerQuickReplies(
  app: FastifyInstance,
  store: QuickRepliesStore,
  deps?: { cfg: Config; agents: AgentsStore },
): void {
  // null = agent identification off → no identity filter, everything visible.
  const identity = (req: FastifyRequest): string | null =>
    deps?.cfg.agentsEnabled ? (emailFromRequest(req) ?? '') : null;

  // Per-instance separation: a blank-instance (legacy) reply belongs to the
  // server default, so eff = the requested instance, or that default.
  const instanceFilter = (req: FastifyRequest) => {
    const def = deps?.cfg.evo.instance ?? '';
    const asked = ((req.query as { instance?: string })?.instance ?? '').trim();
    return { eff: asked || def, def };
  };
  // The line a new reply is pinned to: the active instance, else the default.
  const newInstance = (req: FastifyRequest): string | null => {
    const f = instanceFilter(req);
    return f.eff || null;
  };

  const mayEditPersonal = (req: FastifyRequest, owner: string): boolean => {
    const email = identity(req);
    if (email == null || email === owner) return true;
    return !!deps && can(deps.agents.byEmail(email), 'agents.manage');
  };

  // Whether this request may see the unfiltered roster — every instance and
  // every agent's personal replies. Mirrors requirePerm: identification off or
  // no Access identity is unrestricted; otherwise needs agents.manage.
  const maySeeAll = (req: FastifyRequest): boolean => {
    if (identity(req) == null) return true;
    const email = emailFromRequest(req);
    if (!email) return true;
    return !!deps && can(deps.agents.byEmail(email), 'agents.manage');
  };

  // scope=all is the admin manage view (all instances + all owners); anyone
  // else — or a missing permission — falls back to their per-instance roster.
  app.get('/api/quick-replies', async (req) => {
    const scope = (req.query as { scope?: string })?.scope;
    if (scope === 'all' && maySeeAll(req)) return store.everything();
    return store.allFor(identity(req), instanceFilter(req));
  });

  // Create one ({shortcut, text, personal?}) or many ({rows: [...]}) — bulk is
  // the one-time import of a device's localStorage replies (always shared).
  // Either way the reply is pinned to the active instance.
  app.post('/api/quick-replies', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (Array.isArray(b.rows)) {
      const rows = b.rows
        .map((r) => ({ shortcut: String((r as any)?.shortcut ?? '').trim(), text: String((r as any)?.text ?? '') }))
        .filter((r) => r.text.trim());
      return { ok: true, added: store.createMany(rows, newInstance(req)) };
    }
    const text = typeof b.text === 'string' ? b.text : '';
    let media: MediaInput | null = null;
    if (b.media != null) {
      const r = readMedia(b.media);
      if ('error' in r) return reply.code(400).send({ error: r.error });
      media = r.value;
    }
    // A reply needs a body: text (the caption) or media. Either alone is fine.
    if (!text.trim() && !media) return reply.code(400).send({ error: 'text or media required' });
    const email = identity(req);
    const personal = b.personal === true && !!email;
    return store.create(
      typeof b.shortcut === 'string' ? b.shortcut.trim() : '',
      text,
      personal ? email : null,
      newInstance(req),
      media,
    );
  });

  // The sendable media for a reply — bytes for an uploaded file, the URL for a
  // hosted one. The composer fetches this only when it stages a media reply.
  app.get('/api/quick-replies/:id/media', async (req, reply) => {
    const m = store.media(Number((req.params as { id: string }).id));
    return m ?? reply.code(404).send({ error: 'no media' });
  });

  app.put('/api/quick-replies/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = store.byId(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    if (existing.agentEmail && !mayEditPersonal(req, existing.agentEmail))
      return reply.code(403).send({ error: 'permission required' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    // undefined = leave media as-is; null = clear it; object = replace it.
    let media: MediaInput | null | undefined;
    if ('media' in b) {
      const r = readMedia(b.media);
      if ('error' in r) return reply.code(400).send({ error: r.error });
      media = r.value;
    }
    // Empty text is allowed only when the reply will still carry media.
    const willHaveMedia = media !== undefined ? !!media : !!existing.media;
    if (b.text != null && !String(b.text).trim() && !willHaveMedia)
      return reply.code(400).send({ error: 'text must be non-empty' });
    const updated = store.update(id, {
      shortcut: typeof b.shortcut === 'string' ? b.shortcut.trim() : undefined,
      text: typeof b.text === 'string' ? b.text : undefined,
      media,
    });
    return updated ?? reply.code(404).send({ error: 'not found' });
  });

  app.delete('/api/quick-replies/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = store.byId(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    if (existing.agentEmail && !mayEditPersonal(req, existing.agentEmail))
      return reply.code(403).send({ error: 'permission required' });
    return store.delete(id) ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });
}
