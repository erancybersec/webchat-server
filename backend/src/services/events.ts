import { io, type Socket } from 'socket.io-client';

export interface RelayEvent {
  event: string;
  data: unknown;
}

type Listener = (e: RelayEvent) => void;
type Logger = (msg: string) => void;

/**
 * Bridges Evolution's websocket (socket.io) to our own clients. The server
 * holds the single upstream connection (apikey stays here); browsers subscribe
 * via the /api/events SSE stream. socket.io-client handles reconnection.
 */
export class EventRelay {
  private socket: Socket | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly cfg: { base: string; instance: string; apikey: string; enabled: boolean },
    private readonly log: Logger = (m) => console.log(new Date().toISOString(), m),
  ) {}

  start(): void {
    if (this.socket || !this.cfg.enabled || !this.cfg.base) return;
    // Global-mode connection, exactly like the proven v1 app: base URL with the
    // apikey in query AND auth (Evolution accepts either depending on version).
    this.socket = io(this.cfg.base, {
      path: '/socket.io',
      transports: ['websocket'],
      // without forceNew, socket.io caches the Manager+Socket per origin: a
      // reconfigure() to the same base would get the old socket back — with
      // the previous handlers still attached (duplicate events) and the
      // previous apikey frozen into the connection query
      forceNew: true,
      query: { apikey: this.cfg.apikey },
      auth: { apikey: this.cfg.apikey },
    });
    this.socket.onAny((event: string, ...args: unknown[]) => {
      const data = (args[0] ?? null) as { instance?: string } | null;
      // global mode carries every instance's events. All of them are relayed —
      // the SSE route filters per connection by the agent's instance grants,
      // and backend listeners are instance-aware via the envelope tag.
      this.broadcast({ event, data });
    });
    this.socket.on('connect', () => this.log('[events] connected to Evolution websocket'));
    this.socket.on('connect_error', (e: Error) =>
      this.log(`[events] Evolution websocket unavailable (${e.message}) — retrying`),
    );
  }

  stop(): void {
    if (!this.socket) return;
    // disconnect() keeps handlers registered — drop them so a later start()
    // can never deliver through two generations of listeners
    this.socket.offAny();
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
  }

  /**
   * Apply new Evolution credentials (settings change). Always (re)starts —
   * this is what brings the relay up when Evolution is first configured via
   * the Settings UI on a server that booted unconfigured. start() still
   * no-ops when disabled or base is empty.
   */
  reconfigure(evo: { base: string; instance: string; apikey: string }): void {
    this.stop();
    Object.assign(this.cfg, evo);
    this.start();
  }

  /** Whether the upstream socket exists (it may still be retrying connects). */
  get upstreamActive(): boolean {
    return !!this.socket;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get clientCount(): number {
    return this.listeners.size;
  }

  /** Fan out one event to every subscriber (also the test seam). */
  broadcast(e: RelayEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* one bad subscriber must not break the rest */
      }
    }
  }
}
