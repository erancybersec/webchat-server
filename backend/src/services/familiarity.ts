import type { Db } from '../db/index.js';
import { unwrapEvent } from './envelope.js';
import type { EventRelay } from './events.js';
import type { EvolutionApi } from './evolution.js';
import { contactKey, isGroupJid } from './phone.js';

/**
 * How well this line knows a recipient, which is the only thing the cold-contact
 * cap cares about:
 *
 * - `group`   — a group jid. Never capped: you are already in the room.
 * - `known`   — there is a conversation on record with this person.
 * - `cold`    — first contact. This is the risky class: an unsolicited first
 *               message is what recipients report, and reports are what get a
 *               number banned. Only these are rationed.
 */
export type Familiarity = 'group' | 'known' | 'cold';

export interface FamiliaritySplit {
  known: string[];
  cold: string[];
  groups: string[];
}

/**
 * Who this WhatsApp line has a real conversation with.
 *
 * Deliberately scoped per instance: a contact your studio line talks to daily
 * is a stranger to a different number, and the risk is per-number.
 *
 * Two ways in, with different weight:
 *
 * 1. **The bootstrap seed** (`seed`, from Evolution's chat list) — every thread
 *    that already exists when the feature is first switched on. Without this,
 *    switching the cap on would classify years of existing students as cold and
 *    ration messages to people you speak with every week.
 * 2. **An inbound message** (`record` from the relay) — they wrote to us.
 *
 * What deliberately does NOT make someone known: us messaging them. Otherwise a
 * cold list would launder itself — blast the daily allowance, and tomorrow those
 * same strangers count as "known" and the cap never applies again. Outbound
 * traffic only refreshes `last_seen` for a contact that is already known.
 */
export class ContactFamiliarityStore {
  private readonly q;

  constructor(private readonly db: Db) {
    this.q = {
      get: db.prepare(
        `SELECT inbound FROM known_contacts WHERE phone_number = ? AND instance = ?`,
      ),
      touch: db.prepare(
        `UPDATE known_contacts SET last_seen = @last_seen,
           inbound = MAX(inbound, @inbound)
         WHERE phone_number = @phone_number AND instance = @instance`,
      ),
      put: db.prepare(
        `INSERT INTO known_contacts (phone_number, instance, first_seen, last_seen, inbound)
         VALUES (@phone_number, @instance, @seen, @seen, @inbound)
         ON CONFLICT(phone_number, instance) DO UPDATE SET
           last_seen = excluded.last_seen,
           inbound = MAX(known_contacts.inbound, excluded.inbound)`,
      ),
      countFor: db.prepare(`SELECT COUNT(*) AS n FROM known_contacts WHERE instance = ?`),
    };
  }

  /** Whether this line has ever been seeded — drives the one-time bootstrap. */
  seeded(instance: string): boolean {
    return (this.q.countFor.get(instance) as { n: number }).n > 0;
  }

  count(instance: string): number {
    return (this.q.countFor.get(instance) as { n: number }).n;
  }

  classify(recipient: unknown, instance: string): Familiarity {
    if (isGroupJid(recipient)) return 'group';
    const key = contactKey(recipient);
    if (!key) return 'cold';
    return this.q.get.get(key, instance) ? 'known' : 'cold';
  }

  /** Bulk classification for pre-flight counts. Groups are listed separately. */
  split(recipients: readonly unknown[], instance: string): FamiliaritySplit {
    const out: FamiliaritySplit = { known: [], cold: [], groups: [] };
    const seen = new Set<string>();
    for (const r of recipients) {
      const raw = String(r ?? '');
      if (seen.has(raw)) continue;
      seen.add(raw);
      const kind = this.classify(r, instance);
      if (kind === 'group') out.groups.push(raw);
      else if (kind === 'known') out.known.push(raw);
      else out.cold.push(raw);
    }
    return out;
  }

  /**
   * A message was observed. `fromMe` traffic never PROMOTES a stranger — see
   * the class comment — it only keeps an existing contact's last_seen current.
   */
  record(instance: string, jid: unknown, fromMe: boolean, whenMs?: number | null): void {
    const key = contactKey(jid);
    if (!key) return;
    const seen = new Date(whenMs && Number.isFinite(whenMs) ? whenMs : Date.now()).toISOString();
    if (fromMe) {
      this.q.touch.run({ phone_number: key, instance, last_seen: seen, inbound: 0 });
      return;
    }
    this.q.put.run({ phone_number: key, instance, seen, inbound: 1 });
  }

  /**
   * Bootstrap from existing threads. `inbound` is 0 because a chat record alone
   * doesn't say who spoke first — it is the "we already had a thread before the
   * cap existed" grandfather clause, not evidence of a reply.
   */
  seed(instance: string, jids: readonly unknown[], now = new Date()): number {
    const seen = now.toISOString();
    let n = 0;
    this.db.transaction(() => {
      for (const jid of jids) {
        const key = contactKey(jid);
        if (!key) continue;
        this.q.put.run({ phone_number: key, instance, seen, inbound: 0 });
        n++;
      }
    })();
    return n;
  }
}

/**
 * A `@lid` jid is an opaque local id, not a subscriber number — its digits are
 * not a phone number and must never be filed as one. On this deployment that
 * matters more than it sounds: EVERY incoming direct message arrives under the
 * contact's @lid, so without resolving it to the real number first, a reply
 * would never mark anyone known and the whole contact book would look cold.
 */
export function isLid(jid: unknown): boolean {
  return typeof jid === 'string' && jid.includes('@lid');
}

/**
 * Relay listener: an inbound message is what makes someone known.
 *
 * `canon` resolves an @lid to the real number where the alias map knows it
 * (ChatMetaStore.canon in production); an @lid it cannot resolve is dropped
 * rather than filed under its own digits.
 */
export function attachContactFamiliarity(
  relay: EventRelay,
  store: ContactFamiliarityStore,
  defaultInstance: () => string,
  canon: (jid: string) => string | null = (j) => j,
  log: (msg: string) => void = () => {},
): void {
  relay.subscribe((e) => {
    if (e.event !== 'MESSAGES_UPSERT' && e.event !== 'messages.upsert') return;
    const { instance, records } = unwrapEvent(e.data);
    for (const record of records as Array<{
      key?: { remoteJid?: string; fromMe?: boolean };
      messageTimestamp?: unknown;
    }>) {
      try {
        const raw = record.key?.remoteJid ?? '';
        if (!raw || raw === 'status@broadcast' || isGroupJid(raw)) continue;
        const jid = canon(raw) ?? raw;
        if (isLid(jid)) continue; // unresolved alias — filing its digits would invent a contact
        store.record(instance || defaultInstance(), jid, !!record.key?.fromMe);
      } catch (err) {
        log(`[familiarity] error: ${String(err)}`);
      }
    }
  });
}

/**
 * One-time bootstrap per line: everyone Evolution already has a thread with.
 * Runs at boot only when the line has no rows yet, so it costs one findChats
 * call in the lifetime of a line, and a failure is non-fatal — an unseeded line
 * just means the first campaign sees more cold contacts than it should, which
 * errs toward sending less.
 */
export async function seedFamiliarityFromChats(
  evo: EvolutionApi,
  store: ContactFamiliarityStore,
  instance: string,
  log: (msg: string) => void = () => {},
): Promise<number> {
  if (!instance || store.seeded(instance)) return 0;
  const r = await evo.call(`/chat/findChats/${encodeURIComponent(instance)}`, {});
  if (!r.ok) throw new Error(`findChats ${r.status}: ${r.text.slice(0, 200)}`);
  const parsed = JSON.parse(r.text) as unknown;
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { records?: unknown })?.records)
      ? ((parsed as { records: unknown[] }).records)
      : Array.isArray((parsed as { chats?: unknown })?.chats)
        ? ((parsed as { chats: unknown[] }).chats)
        : [];
  const jids: string[] = [];
  for (const c of rows as Array<Record<string, unknown>>) {
    // a lid-only thread carries the real number on remoteJidAlt; the @lid
    // itself is skipped, since its digits are not a phone number
    for (const k of ['id', 'remoteJid', 'remoteJidAlt']) {
      const v = c?.[k];
      if (typeof v === 'string' && v && !isGroupJid(v) && !isLid(v)) jids.push(v);
    }
  }
  const n = store.seed(instance, jids);
  log(`[familiarity] seeded ${n} existing contacts for ${instance} from ${rows.length} chats`);
  return n;
}
