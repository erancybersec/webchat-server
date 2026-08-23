import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EvoResponse, EvolutionApi } from '../services/evolution.js';
import type { InstanceAccess } from '../services/instances.js';

/**
 * Group management — typed wrappers over Evolution's /group endpoints.
 * Shapes are ported verbatim from the proven v1 app (note the mix of
 * query-param groupJid and body groupJid across Evolution's API).
 * Instance-aware like the chat gateway: `?instance=` / body.instance,
 * default from Settings, enforced against the agent's grants.
 */
export function registerGroups(
  app: FastifyInstance,
  evo: EvolutionApi,
  access: InstanceAccess,
): void {
  const mirror = (reply: FastifyReply, r: EvoResponse) =>
    reply
      .code(r.status)
      .type(r.contentType || 'application/json')
      .send(r.text);

  const q = (jid: string) => `?groupJid=${encodeURIComponent(jid)}`;

  const inst = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const i = access.resolve(req);
    if (i == null) {
      void reply.code(403).send({ error: 'instance not allowed' });
      return null;
    }
    return encodeURIComponent(i);
  };

  app.post('/api/groups/create', async (req, reply) => {
    const b = (req.body ?? {}) as { subject?: string; description?: string; participants?: string[] };
    if (!b.subject) return reply.code(400).send({ error: 'subject required' });
    if (!Array.isArray(b.participants) || !b.participants.length)
      return reply.code(400).send({ error: 'participants required' });
    const i = inst(req, reply);
    if (!i) return reply;
    const body: Record<string, unknown> = { subject: b.subject, participants: b.participants };
    if (b.description) body.description = b.description;
    return mirror(reply, await evo.call(`/group/create/${i}`, body));
  });

  // Group info incl. participants (findGroupInfos is per-group).
  app.get('/api/groups/info', async (req, reply) => {
    const { jid } = (req.query ?? {}) as { jid?: string };
    if (!jid) return reply.code(400).send({ error: 'jid required' });
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(reply, await evo.call(`/group/findGroupInfos/${i}${q(jid)}`, undefined, 'GET'));
  });

  // add | remove | promote | demote
  app.post('/api/groups/participants', async (req, reply) => {
    const b = (req.body ?? {}) as { jid?: string; action?: string; participants?: string[] };
    const actions = ['add', 'remove', 'promote', 'demote'];
    if (!b.jid || !b.action || !actions.includes(b.action))
      return reply.code(400).send({ error: `jid and action (${actions.join('|')}) required` });
    if (!Array.isArray(b.participants) || !b.participants.length)
      return reply.code(400).send({ error: 'participants required' });
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(
      reply,
      await evo.call(`/group/updateParticipant/${i}${q(b.jid)}`, {
        action: b.action,
        participants: b.participants,
      }),
    );
  });

  app.post('/api/groups/subject', async (req, reply) => {
    const b = (req.body ?? {}) as { jid?: string; subject?: string };
    if (!b.jid || !b.subject) return reply.code(400).send({ error: 'jid and subject required' });
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(
      reply,
      await evo.call(`/group/updateGroupSubject/${i}`, { groupJid: b.jid, subject: b.subject }),
    );
  });

  app.post('/api/groups/description', async (req, reply) => {
    const b = (req.body ?? {}) as { jid?: string; description?: string };
    if (!b.jid || !b.description)
      return reply.code(400).send({ error: 'jid and description required' });
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(
      reply,
      await evo.call(`/group/updateGroupDescription/${i}`, {
        groupJid: b.jid,
        description: b.description,
      }),
    );
  });

  // image: a URL Evolution fetches, or a base64 data URL
  app.post('/api/groups/picture', async (req, reply) => {
    const b = (req.body ?? {}) as { jid?: string; image?: string };
    if (!b.jid || !b.image) return reply.code(400).send({ error: 'jid and image required' });
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(
      reply,
      await evo.call(`/group/updateGroupPicture/${i}`, { groupJid: b.jid, image: b.image }),
    );
  });

  // announcement | not_announcement | locked | unlocked
  app.post('/api/groups/setting', async (req, reply) => {
    const b = (req.body ?? {}) as { jid?: string; action?: string };
    const actions = ['announcement', 'not_announcement', 'locked', 'unlocked'];
    if (!b.jid || !b.action || !actions.includes(b.action))
      return reply.code(400).send({ error: `jid and action (${actions.join('|')}) required` });
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(reply, await evo.call(`/group/setting/${i}${q(b.jid)}`, { action: b.action }));
  });

  // disappearing messages: 0 (off) | 86400 | 604800 | 7776000 seconds
  app.post('/api/groups/ephemeral', async (req, reply) => {
    const b = (req.body ?? {}) as { jid?: string; expiration?: number };
    if (!b.jid || b.expiration == null)
      return reply.code(400).send({ error: 'jid and expiration required' });
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(
      reply,
      await evo.call(`/group/toggleEphemeral/${i}${q(b.jid)}`, {
        expiration: Number(b.expiration),
      }),
    );
  });

  app.get('/api/groups/invite', async (req, reply) => {
    const { jid } = (req.query ?? {}) as { jid?: string };
    if (!jid) return reply.code(400).send({ error: 'jid required' });
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(reply, await evo.call(`/group/inviteCode/${i}${q(jid)}`, undefined, 'GET'));
  });

  app.post('/api/groups/invite/revoke', async (req, reply) => {
    const b = (req.body ?? {}) as { jid?: string };
    if (!b.jid) return reply.code(400).send({ error: 'jid required' });
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(reply, await evo.call(`/group/revokeInviteCode/${i}${q(b.jid)}`, {}));
  });

  app.post('/api/groups/leave', async (req, reply) => {
    const b = (req.body ?? {}) as { jid?: string };
    if (!b.jid) return reply.code(400).send({ error: 'jid required' });
    const i = inst(req, reply);
    if (!i) return reply;
    return mirror(reply, await evo.call(`/group/leaveGroup/${i}${q(b.jid)}`, undefined, 'DELETE'));
  });
}
