import { buildApp, type App } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import type { EvoResponse, EvolutionApi } from '../src/services/evolution.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  const cfg = loadConfig({
    DB_PATH: ':memory:',
    DELAY_MIN: '0',
    DELAY_MAX: '0',
    // tests drive the relay manually — never open real upstream sockets
    EVENTS_ENABLED: 'false',
    SEND_MAX_ATTEMPTS: '3',
    EVOLUTION_BASE: 'https://evolution.test',
    EVOLUTION_INSTANCE: 'Test',
    EVOLUTION_APIKEY: 'test-key',
  });
  return { ...cfg, ...overrides };
}

/** Records every Evolution call; can be told to fail N times per recipient. */
export class FakeEvo implements EvolutionApi {
  instance = 'Test';
  configured = true;
  calls: Array<{ endpoint: string; body: any; method: string }> = [];
  failuresLeft = new Map<string, number>(); // recipient -> remaining failures
  /** Numbers /chat/whatsappNumbers reports as NOT registered on WhatsApp. */
  notOnWhatsApp = new Set<string>();
  /** Contact book served on /chat/findContacts (the {{wa_name}} source). */
  contacts: Array<{ id: string; pushName?: string }> = [];
  /** Thread served on /chat/findMessages — set per test. */
  thread: { records: any[]; pages: number } = { records: [], pages: 1 };
  /** Instance list served on /instance/fetchInstances — note the token field
   * that must NEVER reach a browser. */
  evoInstances: Array<Record<string, unknown>> = [
    {
      name: 'Test',
      connectionStatus: 'open',
      profileName: 'Test Line',
      number: '972500000000',
      token: 'SECRET-TOKEN-A',
      _count: { Message: 10, Contact: 2, Chat: 3 },
    },
    {
      name: 'Second',
      connectionStatus: 'close',
      profileName: 'Second Line',
      number: '972500000001',
      token: 'SECRET-TOKEN-B',
      disconnectionAt: '2026-05-10T22:58:27.128Z',
      _count: { Message: 222531, Contact: 8070, Chat: 5921 },
    },
  ];

  async call(endpoint: string, body?: unknown, method = 'POST'): Promise<EvoResponse> {
    this.calls.push({ endpoint, body, method });
    if (endpoint.startsWith('/instance/fetchInstances')) {
      return { status: 200, ok: true, text: JSON.stringify(this.evoInstances), contentType: 'application/json' };
    }
    if (endpoint.startsWith('/chat/findContacts/')) {
      return { status: 200, ok: true, text: JSON.stringify(this.contacts), contentType: 'application/json' };
    }
    if (endpoint.startsWith('/chat/whatsappNumbers/')) {
      // Every number is on WhatsApp unless a test says otherwise, so the
      // verification sweep is a no-op for the tests that don't care about it.
      const asked = ((body as { numbers?: string[] } | undefined)?.numbers ?? []).map(String);
      const rows = asked.map((n) =>
        this.notOnWhatsApp.has(n)
          ? { jid: `${n}@s.whatsapp.net`, exists: false, number: n }
          : { jid: `${n}@s.whatsapp.net`, exists: true, number: n, name: '' },
      );
      return { status: 200, ok: true, text: JSON.stringify(rows), contentType: 'application/json' };
    }
    if (endpoint.startsWith('/chat/findMessages/')) {
      const messages = { records: this.thread.records, pages: this.thread.pages, currentPage: 1 };
      return { status: 200, ok: true, text: JSON.stringify({ messages }), contentType: 'application/json' };
    }
    const number = (body as { number?: string } | undefined)?.number ?? '';
    const left = this.failuresLeft.get(number) ?? 0;
    if (left > 0) {
      this.failuresLeft.set(number, left - 1);
      return { status: 500, ok: false, text: 'simulated failure', contentType: 'application/json' };
    }
    // a key.id like real Evolution sends — the ack-tracking seam
    return {
      status: 201,
      ok: true,
      text: JSON.stringify({ key: { id: `msg-${this.calls.length}` } }),
      contentType: 'application/json',
    };
  }

  /** Recipients of actual message sends — never the lookup/admin calls. */
  sentTo(): string[] {
    return this.calls.filter((c) => c.endpoint.startsWith('/message/send')).map((c) => c.body?.number);
  }
}

export interface TestApp extends App {
  cfg: Config;
  db: Db;
  evo: FakeEvo;
}

export async function makeApp(overrides: Partial<Config> = {}): Promise<TestApp> {
  const cfg = testConfig(overrides);
  const db = openDb(':memory:');
  const evo = new FakeEvo();
  const built = await buildApp({ cfg, db, evo });
  return { ...built, cfg, db, evo };
}
