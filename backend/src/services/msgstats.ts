import type { Db } from '../db/index.js';
import { unwrapEvent } from './envelope.js';
import type { EventRelay } from './events.js';

export interface ActivityDay {
  day: string;
  inbound: number;
  outbound: number;
  chats: number;
}

export interface ActivityTotals {
  inbound: number;
  outbound: number;
  chats: number;
}

interface UpsertRecord {
  key?: { remoteJid?: string; fromMe?: boolean };
  messageTimestamp?: unknown;
}

/** Epoch ms from Evolution's messageTimestamp (seconds, ms, string, or Long). */
export function messageTimeMs(raw: unknown): number | null {
  let n: number | null = null;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim()) n = Number(raw);
  else if (raw && typeof raw === 'object' && typeof (raw as { low?: unknown }).low === 'number')
    n = (raw as { low: number }).low;
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n; // seconds vs ms
}

/**
 * Reconnects make Evolution replay history (Baileys offline sync) — counting
 * those at arrival time would dump days of traffic into one bucket. Bucket by
 * the message's own timestamp and ignore anything outside a sane window.
 */
const MAX_AGE_MS = 7 * 86_400_000;
const MAX_FUTURE_MS = 86_400_000;

// Per-instance separation: a blank-instance row belongs to the server default.
// @eff='' = no filter (whole-system totals).
const INSTANCE_SCOPE = `(@eff = '' OR COALESCE(NULLIF(instance,''), @def) = @eff)`;

/** Restrict activity to one Evolution line. eff='' = no filter. */
export interface InstanceFilter {
  eff: string;
  def: string;
}
const NO_FILTER: InstanceFilter = { eff: '', def: '' };

/**
 * Daily message counters fed by the event relay. One row per
 * day×instance×direction plus a distinct-chats set per day — proportional to
 * days × active chats, not to message volume, so it can run forever without
 * becoming the storage problem it reports on.
 */
export class MessageStatsStore {
  private readonly q;

  constructor(db: Db) {
    this.q = {
      bump: db.prepare(`INSERT INTO message_stats (day, instance, direction, count)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(day, instance, direction) DO UPDATE SET count = count + 1`),
      chat: db.prepare(`INSERT OR IGNORE INTO message_stat_chats (day, instance, chat_jid)
        VALUES (?, ?, ?)`),
      perDay: db.prepare(`SELECT day,
          SUM(CASE WHEN direction='in' THEN count ELSE 0 END) AS inbound,
          SUM(CASE WHEN direction='out' THEN count ELSE 0 END) AS outbound
        FROM message_stats WHERE day >= @cutoff AND day <= @until AND ${INSTANCE_SCOPE}
        GROUP BY day ORDER BY day`),
      // instance is part of the identity: the same contact on two lines is
      // two conversations
      chatsPerDay: db.prepare(`SELECT day, COUNT(DISTINCT instance || '|' || chat_jid) AS chats
        FROM message_stat_chats WHERE day >= @cutoff AND day <= @until AND ${INSTANCE_SCOPE}
        GROUP BY day`),
      totals: db.prepare(`SELECT
          SUM(CASE WHEN direction='in' THEN count ELSE 0 END) AS inbound,
          SUM(CASE WHEN direction='out' THEN count ELSE 0 END) AS outbound
        FROM message_stats WHERE day >= @cutoff AND day <= @until AND ${INSTANCE_SCOPE}`),
      totalChats: db.prepare(`SELECT COUNT(DISTINCT instance || '|' || chat_jid) AS chats
        FROM message_stat_chats WHERE day >= @cutoff AND day <= @until AND ${INSTANCE_SCOPE}`),
      firstDay: db.prepare(`SELECT MIN(day) AS day FROM message_stats`),
    };
  }

  /** at: the message's own time when known; replays beyond the window are dropped. */
  record(instance: string, jid: string, fromMe: boolean, at?: number | null): void {
    const now = Date.now();
    const t = at ?? now;
    if (t < now - MAX_AGE_MS || t > now + MAX_FUTURE_MS) return;
    const day = new Date(t).toISOString().slice(0, 10);
    this.q.bump.run(day, instance, fromMe ? 'out' : 'in');
    this.q.chat.run(day, instance, jid);
  }

  /** Window is [cutoff, until] inclusive; until defaults to no upper bound. */
  activity(
    cutoff: string,
    until = '9999-12-31',
    filter: InstanceFilter = NO_FILTER,
  ): { perDay: ActivityDay[]; totals: ActivityTotals; since: string | null } {
    const bounds = { cutoff, until, eff: filter.eff, def: filter.def };
    const chatsByDay = new Map<string, number>();
    for (const r of this.q.chatsPerDay.all(bounds) as Array<{ day: string; chats: number }>) {
      chatsByDay.set(r.day, r.chats);
    }
    const perDay = (this.q.perDay.all(bounds) as Array<{
      day: string;
      inbound: number | null;
      outbound: number | null;
    }>).map((r) => ({
      day: r.day,
      inbound: r.inbound ?? 0,
      outbound: r.outbound ?? 0,
      chats: chatsByDay.get(r.day) ?? 0,
    }));
    const t = this.q.totals.get(bounds) as { inbound: number | null; outbound: number | null };
    return {
      perDay,
      totals: {
        inbound: t.inbound ?? 0,
        outbound: t.outbound ?? 0,
        chats: (this.q.totalChats.get(bounds) as { chats: number }).chats,
      },
      // lets the UI say "tracked since …" instead of implying zero traffic
      since: (this.q.firstDay.get() as { day: string | null }).day,
    };
  }
}

/** Relay listener: count every real message, inbound and outbound. */
export function attachMessageStats(
  relay: EventRelay,
  stats: MessageStatsStore,
  log: (msg: string) => void = () => {},
): void {
  relay.subscribe((e) => {
    if (e.event !== 'MESSAGES_UPSERT' && e.event !== 'messages.upsert') return;
    const { instance, records } = unwrapEvent(e.data);
    for (const record of records as UpsertRecord[]) {
      try {
        const jid = record.key?.remoteJid ?? '';
        if (!jid || jid === 'status@broadcast') continue;
        stats.record(instance ?? '', jid, !!record.key?.fromMe, messageTimeMs(record.messageTimestamp));
      } catch (err) {
        log(`[msgstats] error: ${String(err)}`);
      }
    }
  });
}
