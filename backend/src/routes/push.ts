import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { emailFromRequest } from '../services/agents.js';
import type { NotifyPrefs, NotifyPrefsStore } from '../services/notifyprefs.js';
import type { PushService, PushSub } from '../services/push.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Web Push subscription endpoints. Any signed-in browser registers its own
 * device here — no admin gate, every agent manages their own notifications.
 * The public VAPID key is needed before a browser can subscribe.
 */
export function registerPush(
  app: FastifyInstance,
  deps: { cfg: Config; push: PushService; prefs: NotifyPrefsStore },
): void {
  const { cfg, push, prefs } = deps;

  // who this subscription belongs to (empty when identification is off, so an
  // unassigned chat still notifies it)
  const subscriber = (req: FastifyRequest): string =>
    cfg.agentsEnabled ? (emailFromRequest(req) ?? '') : '';

  app.get('/api/push/key', async () => ({ publicKey: push.publicKey() }));

  app.post('/api/push/subscribe', async (req, reply) => {
    const b = (req.body ?? {}) as Partial<PushSub>;
    const keys = b.keys;
    if (
      typeof b.endpoint !== 'string' ||
      !b.endpoint ||
      !keys ||
      typeof keys.p256dh !== 'string' ||
      typeof keys.auth !== 'string'
    ) {
      return reply.code(400).send({ error: 'endpoint and keys.{p256dh,auth} are required' });
    }
    push.saveSubscription(subscriber(req), { endpoint: b.endpoint, keys });
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req, reply) => {
    const endpoint = ((req.body ?? {}) as { endpoint?: unknown }).endpoint;
    if (typeof endpoint !== 'string' || !endpoint)
      return reply.code(400).send({ error: 'endpoint is required' });
    push.removeSubscription(endpoint);
    return { ok: true };
  });

  // Per-person notification preferences (category mutes, quiet hours, keyword
  // alerts). Open to every agent — each manages their own, same posture as
  // subscribe. Keyed by the caller's identity (anonymous '' when ID is off).
  app.get('/api/notify-prefs', async (req) => prefs.get(subscriber(req)));

  app.put('/api/notify-prefs', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<NotifyPrefs> = {};
    for (const k of ['groups', 'dms', 'jobsEnded', 'jobsFailuresOnly', 'quietEnabled'] as const)
      if (typeof b[k] === 'boolean') patch[k] = b[k] as boolean;
    for (const field of ['quietStart', 'quietEnd'] as const) {
      const v = b[field];
      if (v == null) continue;
      if (typeof v !== 'string' || !HHMM.test(v))
        return reply.code(400).send({ error: `${field} must be HH:MM` });
      patch[field] = v;
    }
    if (typeof b.keywords === 'string') patch.keywords = b.keywords.trim();
    return prefs.set(subscriber(req), patch);
  });

  // Fire a test notification to the caller's own device(s). The browser passes
  // its subscription endpoint so the test hits exactly that device; without one
  // we fall back to the caller's identity. This is the direct way to confirm a
  // phone actually DISPLAYS a push (an OS-blocked channel still 201s at FCM).
  app.post('/api/push/test', async (req) => {
    const endpoint = ((req.body ?? {}) as { endpoint?: unknown }).endpoint;
    const payload = {
      title: 'Test notification',
      body: 'Notifications are working ✓',
      tag: 'webchat-test',
    };
    const sent =
      typeof endpoint === 'string' && endpoint
        ? await push.sendToEndpoint(endpoint, payload)
        : await push.send(subscriber(req) || null, payload);
    return { sent };
  });
}
