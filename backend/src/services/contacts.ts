import type { EvolutionApi } from './evolution.js';
import { digitsOnly } from './phone.js';

const TTL_MS = 5 * 60_000;

/**
 * Resolves {{wa_name}}: phone digits → WhatsApp profile name (pushName) from
 * Evolution's contact book. One fetch per job run at most (short cache) — the
 * book is ~1k contacts and changes rarely.
 */
export class ContactNameResolver {
  private cache = new Map<string, { at: number; map: Map<string, string> }>();

  constructor(private readonly evo: EvolutionApi) {}

  async names(instance?: string): Promise<Map<string, string>> {
    const inst = instance || this.evo.instance;
    const hit = this.cache.get(inst);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.map;
    const r = await this.evo.call(`/chat/findContacts/${encodeURIComponent(inst)}`, {});
    if (!r.ok) throw new Error(`findContacts ${r.status}: ${r.text.slice(0, 120)}`);
    const list = JSON.parse(r.text) as unknown;
    const map = new Map<string, string>();
    if (Array.isArray(list)) {
      for (const c of list as Array<Record<string, unknown>>) {
        const jid = String(c?.id ?? c?.remoteJid ?? '');
        if (!jid || jid.includes('@g.us')) continue;
        const name = String(c?.pushName ?? c?.name ?? '').trim();
        const digits = digitsOnly(jid.split('@')[0]);
        if (digits && name) map.set(digits, name);
      }
    }
    this.cache.set(inst, { at: Date.now(), map });
    return map;
  }
}
