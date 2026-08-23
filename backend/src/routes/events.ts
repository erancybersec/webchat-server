import type { FastifyInstance } from 'fastify';
import type { EventRelay } from '../services/events.js';
import type { InstanceAccess } from '../services/instances.js';

/**
 * Server-Sent Events stream of Evolution events (MESSAGES_UPSERT,
 * PRESENCE_UPDATE, …). SSE over websocket-relay because the flow is strictly
 * server→client and EventSource reconnects for free.
 *
 * The relay carries every instance's events; each connection only receives
 * the ones its agent may see. Grants are resolved per event (cheap prepared
 * statement) so roster edits and the Settings toggle apply to live streams.
 * App-emitted events always pass — by explicit list, never shape detection,
 * so a future app payload carrying an `instance` field can't get dropped.
 */
const APP_EVENTS = new Set([
  'JOB_PROGRESS',
  'JOB_APPROVAL',
  'CHAT_ASSIGNED',
  'CHAT_STATUS',
  'CHAT_TAGS',
  'AGENT_PRESENCE',
  'REMINDER_DUE',
]);

export function registerEvents(
  app: FastifyInstance,
  relay: EventRelay,
  access?: InstanceAccess,
): void {
  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      // no-transform: Cloudflare (and other proxies) otherwise compress the
      // stream, which buffers events until the connection has produced enough
      // bytes — the browser then sees nothing for minutes.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.socket?.setNoDelay(true);
    // 2 KB comment padding flushes any remaining intermediary buffer so the
    // EventSource fires `open`/first events immediately.
    reply.raw.write(`:${' '.repeat(2048)}\n\nretry: 3000\n\n`);

    const unsubscribe = relay.subscribe((e) => {
      if (access && !APP_EVENTS.has(e.event)) {
        const env = e.data as { instance?: unknown } | null;
        const inst =
          env && typeof env === 'object' && typeof env.instance === 'string'
            ? env.instance
            : undefined;
        if (inst !== undefined) {
          const allowed = access.allowedForRequest(req);
          if (allowed && !allowed.includes(inst)) return;
        }
      }
      reply.raw.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data ?? null)}\n\n`);
    });
    // keep intermediaries from timing out the idle stream; a write can throw
    // if the socket errored before 'close' fired — that must not crash us
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': hb\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
