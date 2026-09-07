import type { Db } from '../db/index.js';
import { unwrapEvent } from './envelope.js';
import type { EventRelay } from './events.js';
import { messageTimeMs } from './msgstats.js';
import { contactKey } from './phone.js';

/** Instance scoping shared with every other line-scoped read in the app. */
export interface InstanceFilter {
  eff: string;
  def: string;
}

export const NO_FILTER: InstanceFilter = { eff: '', def: '' };

/**
 * Every outbound message this line has actually sent, one row per send, from
 * two independent write paths (see attachOutboundLog below for the second):
 * Sender.sendOne() — the single choke point every send made THROUGH this app
 * (campaigns, a chat reply, the AI agent, an opt-out acknowledgment) already
 * funnels through for the blacklist check — covers everything except one
 * thing it structurally cannot see: a message sent directly from the linked
 * phone's own WhatsApp app. "Recently contacted" means this line sent this
 * person ANYTHING, from any platform, not just that they were in a campaign.
 */
export class OutboundLog {
  private readonly insert;
  private readonly recent;
  private readonly roster;

  constructor(private readonly db: Db) {
    this.insert = db.prepare(
      `INSERT INTO outbound_sends (recipient, instance, sent_at) VALUES (?, ?, ?)`,
    );
    this.recent = db.prepare(`
      SELECT 1 AS hit FROM outbound_sends
      WHERE recipient = @recipient AND sent_at >= @cutoff
        AND (@eff = '' OR COALESCE(NULLIF(instance,''), @def) = @eff)
      LIMIT 1
    `);
    // Newest first so a recipient sent to more than once resolves to its most
    // recent send when the caller dedupes.
    this.roster = db.prepare(`
      SELECT recipient FROM outbound_sends
      WHERE sent_at >= @cutoff
        AND (@eff = '' OR COALESCE(NULLIF(instance,''), @def) = @eff)
      ORDER BY sent_at DESC
    `);
  }

  /**
   * Called after every successful send, and again (redundantly but
   * harmlessly — both reads below dedupe by recipient) from the live-relay
   * listener below for messages Evolution echoes back. Groups (no contact
   * key) are never logged. `at`: the message's own time when known (the
   * relay path), defaulting to now (the direct-send path).
   */
  record(recipient: string, instance: string | undefined, at?: number): void {
    const key = contactKey(recipient);
    if (!key) return;
    this.insert.run(key, instance ?? '', new Date(at ?? Date.now()).toISOString());
  }

  /**
   * Which of `recipients` this line has sent ANYTHING to within the last
   * `days` days. Groups and duplicates are dropped; a recipient never sent
   * to at all is never returned, even with the filter on.
   */
  recentlyContacted(
    recipients: readonly unknown[],
    days: number,
    filter: InstanceFilter = NO_FILTER,
  ): string[] {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of recipients) {
      const key = contactKey(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const hit = this.recent.get({ recipient: key, eff: filter.eff, def: filter.def, cutoff });
      if (hit) out.push(String(raw));
    }
    return out;
  }

  /**
   * Everyone this line has sent anything to within the last `days` days —
   * the roster Lists' "add from recent contacts" source populates a new
   * list with. Groups never appear here (record() drops them); no name is
   * available (unlike a job's saved recipients, a bare send has none
   * recorded), so every row comes back name-less.
   */
  recentRoster(
    days: number,
    filter: InstanceFilter = NO_FILTER,
  ): Array<{ recipient: string; isGroup: boolean; name: string }> {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
    const rows = this.roster.all({ eff: filter.eff, def: filter.def, cutoff }) as Array<{
      recipient: string;
    }>;
    const seen = new Set<string>();
    const out: Array<{ recipient: string; isGroup: boolean; name: string }> = [];
    for (const row of rows) {
      if (seen.has(row.recipient)) continue;
      seen.add(row.recipient);
      out.push({ recipient: row.recipient, isGroup: false, name: '' });
    }
    return out;
  }
}

interface UpsertRecord {
  key?: { remoteJid?: string; fromMe?: boolean };
  messageTimestamp?: unknown;
}

// Same replay guard as attachMessageStats: a websocket reconnect makes
// Evolution replay recent history (Baileys offline sync), which would
// otherwise flood outbound_sends with rows on every reconnect.
const MAX_AGE_MS = 7 * 86_400_000;
const MAX_FUTURE_MS = 86_400_000;

/**
 * Catches the one send path Sender.sendOne() can never see: a message sent
 * directly from the linked phone's own WhatsApp app, not through this
 * server. Evolution mirrors it back over the live websocket the same way it
 * mirrors an app-sent message (fromMe: true either way) — this is the only
 * way to observe it. App-sent messages arrive here too, redundantly; that's
 * fine, both recentlyContacted()/recentRoster() already dedupe by recipient.
 */
export function attachOutboundLog(
  relay: EventRelay,
  outbound: OutboundLog,
  log: (msg: string) => void = () => {},
): void {
  relay.subscribe((e) => {
    if (e.event !== 'MESSAGES_UPSERT' && e.event !== 'messages.upsert') return;
    const { instance, records } = unwrapEvent(e.data);
    for (const record of records as UpsertRecord[]) {
      try {
        if (!record.key?.fromMe) continue;
        const jid = record.key?.remoteJid ?? '';
        if (!jid || jid === 'status@broadcast') continue;
        const t = messageTimeMs(record.messageTimestamp) ?? Date.now();
        const now = Date.now();
        if (t < now - MAX_AGE_MS || t > now + MAX_FUTURE_MS) continue;
        outbound.record(jid, instance ?? '', t);
      } catch (err) {
        log(`[outbound] error: ${String(err)}`);
      }
    }
  });
}
