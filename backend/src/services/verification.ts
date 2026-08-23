import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { EvolutionApi } from './evolution.js';
import { digitsOnly, isGroupJid, normalizePhone } from './phone.js';
import { inQuietHours } from './time.js';

export type VerifyStatus = 'valid' | 'invalid';

export interface VerificationEntry {
  phone_number: string;
  status: VerifyStatus;
  checked_at: string;
  expires_at: string;
  instance: string;
  jid: string | null;
  wa_name: string | null;
}

export interface SweepResult {
  /** Distinct, non-group numbers the caller asked about. */
  requested: number;
  /** Already cached and still inside their TTL — not re-checked. */
  cached: number;
  /** Actually sent to Evolution this sweep. */
  checked: number;
  valid: number;
  invalid: number;
  /** exists:false results thrown away because the breaker tripped. */
  discarded: number;
  tripped: boolean;
  /** Set when the sweep stopped early (Evolution error, or not configured). */
  aborted?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The configured batch size and pause are a BASE, not a schedule. A drip that
 * asks about exactly 10 numbers exactly every 60s is a metronome, and a
 * metronome is the easiest thing in the world to spot in a request log — the
 * pacing was chosen to look unremarkable, so it has to be irregular too.
 */
const PAUSE_JITTER = 0.35;
const SIZE_JITTER = 0.3;
/**
 * …and roughly one batch in eight takes a real break. Someone working through a
 * list gets up and makes coffee; nothing else in the sweep ever produces a gap
 * of that shape, and the sweep has nobody waiting on it, so it costs nothing.
 */
const LONG_BREAK_CHANCE = 1 / 8;
const LONG_BREAK_MS = 7 * 60_000;

const jitter = (base: number, band: number) => base * (1 - band) + Math.random() * base * band * 2;

/** The gap before the next lookup batch: jittered, occasionally a long break. */
export function nextBatchPauseMs(baseMs: number): number {
  if (baseMs <= 0) return 0;
  return Math.random() < LONG_BREAK_CHANCE
    ? jitter(LONG_BREAK_MS, PAUSE_JITTER)
    : jitter(baseMs, PAUSE_JITTER);
}

/** How many numbers to ask about in the next call. At least one. */
export function nextChunkSize(base: number): number {
  return Math.max(1, Math.round(jitter(base, SIZE_JITTER)));
}

/**
 * Canonical cache key. Mirrors the blacklist's tolerance of any input form, but
 * collapses to ONE key so the same subscriber can't be cached twice under two
 * spellings: the normalized form where phone.ts recognizes it, bare digits
 * otherwise — a number our regex rejects is still worth asking about, since
 * WhatsApp is the authority on what is real, not us. Groups are never verified.
 */
export function verifyKey(raw: unknown): string | null {
  if (raw == null || isGroupJid(raw)) return null;
  const d = digitsOnly(String(raw).split('@')[0]);
  if (!d) return null;
  return normalizePhone(d) ?? d;
}

/**
 * Parses Evolution's "not on WhatsApp" rejection out of a failed send. Shape:
 *   { status:400, error:'Bad Request',
 *     response:{ message:[{ jid, exists:false, number }] } }
 * Anything else (a timeout, a 500, a message array of plain strings) is NOT
 * this, and returning false there keeps those on the normal retry path.
 */
export function isNotOnWhatsAppError(text: string): boolean {
  try {
    const body = JSON.parse(text) as { response?: { message?: unknown } };
    const msg = body?.response?.message;
    if (!Array.isArray(msg) || msg.length === 0) return false;
    return msg.every(
      (m) => !!m && typeof m === 'object' && (m as { exists?: unknown }).exists === false,
    );
  } catch {
    return false;
  }
}

export class VerificationStore {
  private readonly q;
  constructor(private readonly db: Db) {
    this.q = {
      byPhone: db.prepare(`SELECT * FROM number_verification WHERE phone_number = ?`),
      put: db.prepare(`INSERT INTO number_verification
        (phone_number, status, checked_at, expires_at, instance, jid, wa_name)
        VALUES (@phone_number, @status, @checked_at, @expires_at, @instance, @jid, @wa_name)
        ON CONFLICT(phone_number) DO UPDATE SET
          status = excluded.status, checked_at = excluded.checked_at,
          expires_at = excluded.expires_at, instance = excluded.instance,
          jid = excluded.jid, wa_name = excluded.wa_name`),
      del: db.prepare(`DELETE FROM number_verification WHERE phone_number = ?`),
      clearAll: db.prepare(`DELETE FROM number_verification`),
      clearStatus: db.prepare(`DELETE FROM number_verification WHERE status = ?`),
      purge: db.prepare(`DELETE FROM number_verification WHERE expires_at <= ?`),
      counts: db.prepare(`SELECT status, COUNT(*) AS n FROM number_verification
        WHERE expires_at > ? GROUP BY status`),
      checkedSince: db.prepare(
        `SELECT COUNT(*) AS n FROM number_verification WHERE checked_at > ?`,
      ),
      page: db.prepare(`SELECT * FROM number_verification
        WHERE (@status IS NULL OR status = @status)
          AND (@q IS NULL OR phone_number LIKE '%' || @q || '%')
        ORDER BY checked_at DESC LIMIT @limit OFFSET @offset`),
      pageCount: db.prepare(`SELECT COUNT(*) AS n FROM number_verification
        WHERE (@status IS NULL OR status = @status)
          AND (@q IS NULL OR phone_number LIKE '%' || @q || '%')`),
    };
  }

  /** The cached verdict, or undefined when absent OR past its TTL. */
  fresh(raw: unknown, now = new Date()): VerificationEntry | undefined {
    const key = verifyKey(raw);
    if (!key) return undefined;
    const row = this.q.byPhone.get(key) as VerificationEntry | undefined;
    if (!row) return undefined;
    return row.expires_at > now.toISOString() ? row : undefined;
  }

  put(
    key: string,
    status: VerifyStatus,
    ttlDays: number,
    extra: { instance?: string; jid?: string | null; waName?: string | null } = {},
    now = new Date(),
  ): void {
    this.q.put.run({
      phone_number: key,
      status,
      checked_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlDays * 86_400_000).toISOString(),
      instance: extra.instance ?? '',
      jid: extra.jid ?? null,
      wa_name: extra.waName ?? null,
    });
  }

  putManyInvalid(keys: readonly string[], ttlDays: number, instance: string): void {
    this.db.transaction(() => {
      for (const k of keys) this.put(k, 'invalid', ttlDays, { instance });
    })();
  }

  page(opts: { status?: VerifyStatus; q?: string; limit: number; offset: number }): {
    rows: VerificationEntry[];
    total: number;
  } {
    const args = {
      status: opts.status ?? null,
      q: opts.q?.trim() ? digitsOnly(opts.q) : null,
      limit: opts.limit,
      offset: opts.offset,
    };
    return {
      rows: this.q.page.all(args) as VerificationEntry[],
      total: (this.q.pageCount.get(args) as { n: number }).n,
    };
  }

  /** Live (non-expired) totals, for the UI header. */
  counts(now = new Date()): { valid: number; invalid: number } {
    const rows = this.q.counts.all(now.toISOString()) as Array<{ status: VerifyStatus; n: number }>;
    const out = { valid: 0, invalid: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  remove(raw: unknown): boolean {
    const key = verifyKey(raw);
    return !!key && this.q.del.run(key).changes > 0;
  }

  /** Operator escape hatch: forget everything, or just one verdict. */
  clear(status?: VerifyStatus): number {
    return status ? this.q.clearStatus.run(status).changes : this.q.clearAll.run().changes;
  }

  purgeExpired(now = new Date()): number {
    return this.q.purge.run(now.toISOString()).changes;
  }

  /**
   * Lookups recorded since `since` — the daily budget's meter. Reading it off
   * the cache rather than an in-memory counter means a restart can't reset the
   * budget, which is the whole point of having one. It slightly UNDERCOUNTS (a
   * run discarded by the breaker wrote nothing), and undercounting spends less
   * than allowed rather than more, so the error falls the safe way.
   */
  checkedSince(since: string): number {
    return (this.q.checkedSince.get(since) as { n: number }).n;
  }
}

/**
 * Asks WhatsApp which numbers are real, in bulk, and caches the answers.
 *
 * Decoupling this from the send loop is the whole point: a sweep has nothing
 * waiting on it, so it can be paced gently enough not to get rate-limited —
 * which is what makes its answers trustworthy in the first place.
 */
export class VerificationService {
  private sweeping = false;
  private current: Promise<unknown> | null = null;

  constructor(
    private readonly evo: EvolutionApi,
    readonly store: VerificationStore,
    private readonly cfg: Config,
    private readonly log: (m: string) => void = () => {},
  ) {}

  /** Whether a background sweep is in flight (one at a time, by design). */
  get busy(): boolean {
    return this.sweeping;
  }

  private quiet(now = new Date()): boolean {
    return !!this.cfg.quietEnabled && inQuietHours(now, this.cfg.quietStart, this.cfg.quietEnd);
  }

  /** Resolves when the in-flight sweep (if any) is done. For tests and probes. */
  async whenIdle(): Promise<void> {
    await this.current;
  }

  /**
   * Kicks a sweep off and returns immediately.
   *
   * A campaign must NEVER wait on verification. Awaiting it inline is what
   * turned a safety feature into a 1,000-lookup burst: the sweep had to finish
   * before the first message could go out, so it had to be fast, so it was
   * fast enough to look like scraping. Decoupled, the drip can take hours and
   * nobody minds — the send path already treats an unverified number as
   * sendable, so the sweep only ever saves wasted sends rather than gating them.
   *
   * One sweep at a time: a second campaign starting mid-drip would otherwise
   * double the lookup rate, which is precisely the rate we are pacing.
   */
  sweepInBackground(recipients: readonly string[], instance?: string): boolean {
    if (this.sweeping || !recipients.length) return false;
    this.sweeping = true;
    this.current = this.ensure(recipients, instance)
      .then((r) => {
        this.log(
          `[verify] background sweep: ${r.checked} checked, ${r.valid} live, ${r.invalid} not on ` +
            `WhatsApp, ${r.cached} already known${r.aborted ? ` (stopped: ${r.aborted})` : ''}`,
        );
      })
      .catch((e) => this.log(`[verify] background sweep failed: ${String((e as Error).message ?? e)}`))
      .finally(() => {
        this.sweeping = false;
        this.current = null;
      });
    return true;
  }

  /** One /chat/whatsappNumbers call, keyed by the number we asked about. */
  private async lookup(
    numbers: string[],
    instance: string,
  ): Promise<Map<string, { exists: boolean; jid?: string; name?: string }>> {
    const r = await this.evo.call(`/chat/whatsappNumbers/${instance}`, { numbers });
    if (!r.ok) throw new Error(`evolution ${r.status}: ${r.text.slice(0, 200)}`);
    const parsed = JSON.parse(r.text) as Array<{
      exists?: unknown;
      jid?: unknown;
      number?: unknown;
      name?: unknown;
    }>;
    const out = new Map<string, { exists: boolean; jid?: string; name?: string }>();
    if (!Array.isArray(parsed)) return out;
    for (const e of parsed) {
      // match on the echoed number, never on position — a dropped entry would
      // otherwise shift every later result onto the wrong subscriber
      const key = verifyKey(e?.number ?? e?.jid);
      if (!key) continue;
      out.set(key, {
        exists: e?.exists === true,
        jid: typeof e?.jid === 'string' ? e.jid : undefined,
        name: typeof e?.name === 'string' ? e.name : undefined,
      });
    }
    return out;
  }

  /**
   * Verifies every given recipient that isn't already cached-fresh.
   *
   * The breaker: exists:false results are buffered rather than written straight
   * away. A live number flushes the buffer — an invalid sitting among live ones
   * is a scattered result, which is exactly what a genuinely dead number looks
   * like. If the buffer instead reaches `verifyBreakerRun` with no live number
   * to break it up, that is the shape of rate-limiting, so the whole run is
   * discarded and the sweep stops rather than caching a lie.
   */
  async ensure(recipients: readonly string[], instance?: string): Promise<SweepResult> {
    const inst = instance || this.evo.instance;
    const res: SweepResult = {
      requested: 0,
      cached: 0,
      checked: 0,
      valid: 0,
      invalid: 0,
      discarded: 0,
      tripped: false,
    };

    const keys: string[] = [];
    const seen = new Set<string>();
    for (const r of recipients) {
      const key = verifyKey(r);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    res.requested = keys.length;
    if (!this.evo.configured) {
      res.aborted = 'Evolution not configured';
      return res;
    }

    const uncached = keys.filter((k) => {
      if (this.store.fresh(k)) {
        res.cached++;
        return false;
      }
      return true;
    });
    if (!uncached.length) return res;

    // Daily budget. Existence lookups are the one call here that looks exactly
    // like scraping whoever makes it, so the total across all sweeps is bounded
    // per day and the remainder simply waits for tomorrow — nothing depends on
    // this finishing, because the send path treats "unknown" as "send anyway".
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const budget = this.cfg.verifyDailyCap - this.store.checkedSince(startOfDay.toISOString());
    if (budget <= 0) {
      res.aborted = `daily lookup cap (${this.cfg.verifyDailyCap}) already spent`;
      return res;
    }
    const todo = uncached.slice(0, budget);
    if (todo.length < uncached.length)
      res.aborted = `daily lookup cap (${this.cfg.verifyDailyCap}) reached — ${uncached.length - todo.length} left for tomorrow`;

    const buffered: string[] = [];
    const flush = () => {
      if (!buffered.length) return;
      this.store.putManyInvalid(buffered, this.cfg.verifyInvalidDays, inst);
      res.invalid += buffered.length;
      buffered.length = 0;
    };

    const size = this.cfg.verifyBatchSize;
    for (let i = 0; i < todo.length && !res.tripped; ) {
      // Quiet hours bind the sweep as much as they bind a send: existence
      // lookups at 03:00 from a line whose owner is asleep are the anomaly,
      // whether or not a message follows. Checked per batch, so a sweep that
      // was mid-drip when the window opened stops rather than running through.
      if (this.quiet()) {
        res.aborted = `quiet hours — ${todo.length - i} left for after the window`;
        break;
      }
      const chunk = todo.slice(i, i + nextChunkSize(size));
      i += chunk.length;
      let found: Map<string, { exists: boolean; jid?: string; name?: string }>;
      try {
        found = await this.lookup(chunk, inst);
      } catch (e) {
        // a lookup outage must never be read as "these numbers are dead"
        res.aborted = String((e as Error).message ?? e);
        break;
      }
      res.checked += chunk.length;
      for (const key of chunk) {
        const hit = found.get(key);
        if (!hit) continue; // Evolution said nothing about it — leave it unknown
        if (hit.exists) {
          flush();
          this.store.put(key, 'valid', this.cfg.verifyValidDays, {
            instance: inst,
            jid: hit.jid,
            waName: hit.name,
          });
          res.valid++;
        } else {
          buffered.push(key);
          if (buffered.length >= this.cfg.verifyBreakerRun) {
            res.tripped = true;
            break;
          }
        }
      }
      if (!res.tripped && i < todo.length)
        await sleep(nextBatchPauseMs(this.cfg.verifyBatchPauseMs));
    }

    if (res.tripped) {
      res.discarded = buffered.length;
      buffered.length = 0;
      this.log(
        `[verify] breaker tripped after ${res.discarded} consecutive not-on-WhatsApp results — ` +
          `that is the shape of rate-limiting, so nothing from that run was cached`,
      );
    } else {
      flush();
    }
    return res;
  }

  /**
   * Records a not-on-WhatsApp verdict observed at SEND time (Evolution's 400).
   * A single rejection is one data point rather than a run, so there is nothing
   * to breaker against here — but it is the same fact the sweep records, and
   * caching it is what stops the next campaign retrying the number.
   */
  recordInvalid(recipient: unknown, instance?: string): void {
    const key = verifyKey(recipient);
    if (!key) return;
    this.store.put(key, 'invalid', this.cfg.verifyInvalidDays, {
      instance: instance || this.evo.instance,
    });
  }
}
