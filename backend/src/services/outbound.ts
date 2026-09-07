import type { Db } from '../db/index.js';
import { contactKey } from './phone.js';

/** Instance scoping shared with every other line-scoped read in the app. */
export interface InstanceFilter {
  eff: string;
  def: string;
}

export const NO_FILTER: InstanceFilter = { eff: '', def: '' };

/**
 * Every outbound message this line has actually sent, one row per send —
 * written from Sender.sendOne(), the single choke point every send path
 * (campaigns, a chat reply, the AI agent, an opt-out acknowledgment) already
 * funnels through for the blacklist check. This is deliberately broader than
 * the job ledger (job_sends): "recently contacted" means this line sent this
 * person ANYTHING, not just that they were in a campaign — a manual reply
 * from the Chat tab counts exactly the same as a scheduled broadcast.
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

  /** Called after every successful send. Groups (no contact key) are never logged. */
  record(recipient: string, instance: string | undefined): void {
    const key = contactKey(recipient);
    if (!key) return;
    this.insert.run(key, instance ?? '', new Date().toISOString());
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
