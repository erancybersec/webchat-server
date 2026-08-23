import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EvoResponse, EvolutionApi } from '../services/evolution.js';
import type { InstanceAccess } from '../services/instances.js';

const PRIVACY_KEYS = ['readreceipts', 'profile', 'status', 'online', 'last', 'groupadd'] as const;

/**
 * Own-account profile + privacy. Endpoints verified against Evolution v2.3.x:
 * the /profile/* routes the v1 app used return 404 there — the live ones are
 * /instance/fetchInstances and /chat/updateProfile*, /chat/*PrivacySettings.
 * Instance-aware: the "own account" is whichever instance is selected.
 */
export function registerProfile(
  app: FastifyInstance,
  evo: EvolutionApi,
  access: InstanceAccess,
): void {
  const mirror = (reply: FastifyReply, r: EvoResponse) =>
    reply
      .code(r.status)
      .type(r.contentType || 'application/json')
      .send(r.text);

  /** Resolved instance (raw name for query params, encode for paths). */
  const inst = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const i = access.resolve(req);
    if (i == null) {
      void reply.code(403).send({ error: 'instance not allowed' });
      return null;
    }
    return i;
  };

  // Own profile = instance info (name/picture/owner/connection), enriched
  // with the about-text via fetchProfile on the owner number.
  app.get('/api/profile', async (req, reply) => {
    const name = inst(req, reply);
    if (!name) return reply;
    const i = encodeURIComponent(name);
    const instRes = await evo.call(
      `/instance/fetchInstances?instanceName=${i}`,
      undefined,
      'GET',
    );
    if (!instRes.ok) return mirror(reply, instRes);
    let info: Record<string, unknown> = {};
    try {
      const arr = JSON.parse(instRes.text);
      info = (Array.isArray(arr) ? arr[0] : arr) ?? {};
    } catch {
      return mirror(reply, instRes);
    }
    const out: Record<string, unknown> = {
      profileName: info.profileName ?? '',
      profilePicUrl: info.profilePicUrl ?? '',
      ownerJid: info.ownerJid ?? '',
      connectionStatus: info.connectionStatus ?? '',
    };
    const owner = String(info.ownerJid ?? '').split('@')[0];
    if (owner) {
      try {
        const prof = await evo.call(`/chat/fetchProfile/${i}`, { number: owner });
        if (prof.ok) {
          const p = JSON.parse(prof.text);
          out.status = p?.status?.status ?? p?.status ?? '';
          if (!out.profilePicUrl && p?.picture) out.profilePicUrl = p.picture;
        }
      } catch {
        /* about-text is best-effort */
      }
    }
    return out;
  });

  app.put('/api/profile/name', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string };
    if (!b.name) return reply.code(400).send({ error: 'name required' });
    const name = inst(req, reply);
    if (!name) return reply;
    return mirror(
      reply,
      await evo.call(`/chat/updateProfileName/${encodeURIComponent(name)}`, { name: b.name }),
    );
  });

  app.put('/api/profile/status', async (req, reply) => {
    const b = (req.body ?? {}) as { status?: string };
    if (!b.status) return reply.code(400).send({ error: 'status required' });
    const name = inst(req, reply);
    if (!name) return reply;
    return mirror(
      reply,
      await evo.call(`/chat/updateProfileStatus/${encodeURIComponent(name)}`, { status: b.status }),
    );
  });

  // picture: a URL Evolution fetches and encodes
  app.put('/api/profile/picture', async (req, reply) => {
    const b = (req.body ?? {}) as { picture?: string };
    if (!b.picture) return reply.code(400).send({ error: 'picture required' });
    const name = inst(req, reply);
    if (!name) return reply;
    return mirror(
      reply,
      await evo.call(`/chat/updateProfilePicture/${encodeURIComponent(name)}`, { picture: b.picture }),
    );
  });

  app.delete('/api/profile/picture', async (req, reply) => {
    const name = inst(req, reply);
    if (!name) return reply;
    return mirror(
      reply,
      await evo.call(`/chat/removeProfilePicture/${encodeURIComponent(name)}`, undefined, 'DELETE'),
    );
  });

  app.get('/api/profile/privacy', async (req, reply) => {
    const name = inst(req, reply);
    if (!name) return reply;
    return mirror(
      reply,
      await evo.call(`/chat/fetchPrivacySettings/${encodeURIComponent(name)}`, undefined, 'GET'),
    );
  });

  // Evolution validates that ALL six keys are present (flat body).
  app.put('/api/profile/privacy', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const body: Record<string, string> = {};
    const missing: string[] = [];
    for (const k of PRIVACY_KEYS) {
      if (b[k]) body[k] = b[k]!;
      else missing.push(k);
    }
    if (missing.length)
      return reply.code(400).send({ error: `missing privacy keys: ${missing.join(', ')}` });
    const name = inst(req, reply);
    if (!name) return reply;
    return mirror(
      reply,
      await evo.call(`/chat/updatePrivacySettings/${encodeURIComponent(name)}`, body),
    );
  });
}
