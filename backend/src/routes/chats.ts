import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { AiAgentStore } from '../services/aiagent.js';
import { emailFromRequest, type AgentsStore } from '../services/agents.js';
import { can } from '../services/authz.js';
import { CHAT_STATUSES, type ChatMetaStore, type ChatStatus } from '../services/chatmeta.js';
import type { Db } from '../db/index.js';
import type { AgentPresence } from '../services/presence.js';

const MAX_TAG_LEN = 40;
const MAX_NOTE_LEN = 4000;

interface ChatsDeps {
  cfg: Config;
  meta: ChatMetaStore;
  agents: AgentsStore;
  presence: AgentPresence;
  emit: (event: string, data: unknown) => void;
  /** Present once the AI agent is wired; the routes below degrade without it. */
  ai?: AiAgentStore;
  /** Needed only to make take-over one atomic write. */
  db?: Db;
}

/**
 * Chat workbench metadata: assignment, workflow status, tags, internal notes,
 * the jid alias map, and live agent presence. All chat keys are canonicalized
 * server-side; jids travel in POST bodies (matching the gateway convention —
 * no @-bearing jids in paths).
 */
export function registerChats(app: FastifyInstance, deps: ChatsDeps): void {
  const { cfg, meta, agents, presence, emit, ai } = deps;

  const identity = (req: FastifyRequest): string =>
    cfg.agentsEnabled ? (emailFromRequest(req) ?? '') : '';

  // One fetch for everything the chat list needs to decorate rows.
  app.get('/api/chat-meta', async () => {
    const tags = meta.tags();
    return {
      assignments: meta.assignments(),
      statuses: meta.statuses(),
      tags: tags.byChat,
      allTags: tags.all,
      aliases: meta.aliases(),
      // AI control state, deliberately separate from `assignments`: human
      // ownership lives there and only there, and 'PAUSED' here is a resume
      // latch rather than a mirror of it.
      aiStates: ai ? ai.states() : {},
    };
  });

  // Clients sync the alias pairs their dedup discovers (profile-pic joins
  // etc. that the server can't derive) so server-side lookups converge.
  app.post('/api/chat-aliases', async (req, reply) => {
    const b = (req.body ?? {}) as { pairs?: unknown };
    if (!Array.isArray(b.pairs)) return reply.code(400).send({ error: 'pairs required' });
    let learned = 0;
    for (const p of b.pairs.slice(0, 1000)) {
      if (!Array.isArray(p) || typeof p[0] !== 'string' || typeof p[1] !== 'string') continue;
      meta.learnAlias(p[0], p[1]);
      learned++;
    }
    return { ok: true, learned, aliases: meta.aliases() };
  });

  // Assign / claim / unassign (agentEmail null or '' = unassign).
  app.post('/api/chats/assign', async (req, reply) => {
    const b = (req.body ?? {}) as { jid?: unknown; agentEmail?: unknown };
    if (typeof b.jid !== 'string' || !b.jid) return reply.code(400).send({ error: 'jid required' });
    const agentEmail =
      b.agentEmail == null ? null : String(b.agentEmail).trim().toLowerCase() || null;
    if (agentEmail && !agents.byEmail(agentEmail))
      return reply.code(400).send({ error: 'unknown agent' });
    const jid = meta.assign(b.jid, agentEmail, identity(req));
    emit('CHAT_ASSIGNED', { jid, agentEmail, by: identity(req) });
    return { ok: true, jid, agentEmail };
  });

  /**
   * "Take Over": claim the chat AND stop the AI, as ONE request wrapped in one
   * transaction. Two independent client calls would leave a window where the
   * assignment landed and the pause didn't (or the reverse) — and that window is
   * exactly the moment the AI would answer over a human who just stepped in.
   */
  app.post('/api/chats/take-over', async (req, reply) => {
    if (!ai) return reply.code(503).send({ error: 'AI agent not available' });
    const b = (req.body ?? {}) as { jid?: unknown; agentEmail?: unknown };
    if (typeof b.jid !== 'string' || !b.jid) return reply.code(400).send({ error: 'jid required' });
    // The Access identity when agent identification is on; an explicit body
    // value is the fallback for a LAN/token deployment that has no identities.
    const who = identity(req) || String(b.agentEmail ?? '').trim().toLowerCase();
    if (!who) return reply.code(400).send({ error: 'agentEmail required' });
    if (!identity(req) && !agents.byEmail(who))
      return reply.code(400).send({ error: 'unknown agent' });
    const jid = meta.canon(b.jid);
    const apply = () => {
      meta.assign(jid, who, who);
      ai.setState(jid, 'PAUSED', 'human_takeover', who);
    };
    if (deps.db) deps.db.transaction(apply)();
    else apply();
    emit('CHAT_ASSIGNED', { jid, agentEmail: who, by: who });
    emit('AI_AGENT_STATE', { jid, state: 'PAUSED', reason: 'human_takeover', changedBy: who });
    return { ok: true, jid, agentEmail: who, aiState: 'PAUSED' };
  });

  /**
   * "Resume AI". Refused while a human still owns the chat — handing it back to
   * the AI under someone's name makes no sense, and the eligibility gate would
   * skip it anyway. Being unassigned is necessary but not sufficient: a released
   * chat stays PAUSED until someone explicitly resumes it here.
   */
  app.post('/api/chats/resume-ai', async (req, reply) => {
    if (!ai) return reply.code(503).send({ error: 'AI agent not available' });
    const b = (req.body ?? {}) as { jid?: unknown };
    if (typeof b.jid !== 'string' || !b.jid) return reply.code(400).send({ error: 'jid required' });
    const jid = meta.canon(b.jid);
    const assignee = meta.assigneeOf(jid);
    if (assignee)
      return reply.code(409).send({ error: 'chat is still assigned to a human', assignee });
    const by = identity(req);
    ai.setState(jid, 'ACTIVE', '', by);
    emit('AI_AGENT_STATE', { jid, state: 'ACTIVE', reason: '', changedBy: by });
    return { ok: true, jid, aiState: 'ACTIVE' };
  });

  app.post('/api/chats/status', async (req, reply) => {
    const b = (req.body ?? {}) as { jid?: unknown; status?: unknown };
    if (typeof b.jid !== 'string' || !b.jid) return reply.code(400).send({ error: 'jid required' });
    if (!CHAT_STATUSES.includes(b.status as ChatStatus))
      return reply.code(400).send({ error: `status must be one of: ${CHAT_STATUSES.join(', ')}` });
    const jid = meta.setStatus(b.jid, b.status as ChatStatus, identity(req));
    emit('CHAT_STATUS', { jid, status: b.status, by: identity(req) });
    return { ok: true, jid, status: b.status };
  });

  app.post('/api/chats/tags', async (req, reply) => {
    const b = (req.body ?? {}) as { jid?: unknown; tags?: unknown };
    if (typeof b.jid !== 'string' || !b.jid) return reply.code(400).send({ error: 'jid required' });
    if (!Array.isArray(b.tags)) return reply.code(400).send({ error: 'tags required (array)' });
    const tags = [
      ...new Set(
        b.tags
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim().slice(0, MAX_TAG_LEN))
          .filter(Boolean),
      ),
    ].slice(0, 50);
    const jid = meta.setTags(b.jid, tags);
    emit('CHAT_TAGS', { jid, tags });
    return { ok: true, jid, tags };
  });

  // Recipients carrying a tag — Compose's "add by tag" audience.
  app.get('/api/chats/by-tag', async (req, reply) => {
    const tag = String((req.query as { tag?: string }).tag ?? '').trim();
    if (!tag) return reply.code(400).send({ error: 'tag required' });
    return { tag, jids: meta.chatsWithTag(tag) };
  });

  // ---- internal notes (never enter any send path) ------------------------

  app.get('/api/chats/notes', async (req, reply) => {
    const jid = String((req.query as { jid?: string }).jid ?? '');
    if (!jid) return reply.code(400).send({ error: 'jid required' });
    return meta.notes(jid);
  });

  app.post('/api/chats/notes', async (req, reply) => {
    const b = (req.body ?? {}) as { jid?: unknown; body?: unknown };
    if (typeof b.jid !== 'string' || !b.jid) return reply.code(400).send({ error: 'jid required' });
    const body = String(b.body ?? '').trim();
    if (!body) return reply.code(400).send({ error: 'body required' });
    return meta.addNote(b.jid, identity(req), body.slice(0, MAX_NOTE_LEN));
  });

  // Own notes only — unless the requester manages agents (admin) or the
  // toggle is off (no identities to own anything).
  app.delete('/api/chats/notes/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const owner = meta.noteOwner(id);
    if (owner == null) return reply.code(404).send({ error: 'not found' });
    if (cfg.agentsEnabled) {
      const email = emailFromRequest(req);
      if (email && owner !== email && !can(agents.byEmail(email), 'agents.manage'))
        return reply.code(403).send({ error: 'permission required' });
    }
    meta.deleteNote(id);
    return { ok: true };
  });

  // ---- agent presence (collision avoidance, in-memory) -------------------

  app.post('/api/agent-presence', async (req) => {
    if (!cfg.agentsEnabled) return { ok: false };
    const email = emailFromRequest(req);
    if (!email) return { ok: false };
    const b = (req.body ?? {}) as { tabId?: unknown; chatJid?: unknown; typing?: unknown };
    const tabId = String(b.tabId ?? '').slice(0, 64);
    if (!tabId) return { ok: false };
    const chatJid = typeof b.chatJid === 'string' && b.chatJid ? meta.canon(b.chatJid) : '';
    const snapshot = presence.beat(email, tabId, chatJid, !!b.typing);
    emit('AGENT_PRESENCE', { agents: snapshot });
    return { ok: true };
  });
}
