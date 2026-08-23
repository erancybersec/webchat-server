import webpush from 'web-push';
import type { Db } from '../db/index.js';
import type { ChatMetaStore } from './chatmeta.js';
import { unwrapEvent } from './envelope.js';
import type { EventRelay } from './events.js';
import { messageTimeMs } from './msgstats.js';
import {
  DEFAULT_NOTIFY_PREFS,
  shouldNotifyJob,
  shouldNotifyMessage,
  type NotifyPrefs,
} from './notifyprefs.js';

/** Just the read this module needs from NotifyPrefsStore (keeps tests light). */
export interface PrefsSource {
  get(email: string): NotifyPrefs;
}

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  /** collapse-tag + click-target chat (the canonical jid) */
  tag: string;
  /** deep-link the click opens: `/?chat=<jid>&msg=<id>` or `/?job=<id>` */
  url?: string;
}

/** Result of one delivery attempt — only the status code matters to us. */
export interface DeliverResult {
  statusCode?: number;
}

/**
 * Injectable transport so the relay→push path is testable without hitting a
 * real push service. Production uses web-push; tests pass a recording stub.
 */
export type PushTransport = (sub: PushSub, payload: string) => Promise<DeliverResult>;

/**
 * Web Push (Push API) delivery. This is the half of notifications that works
 * when the app is closed on a phone — the page-driven path can't fire once the
 * OS suspends the tab. The VAPID keypair is generated once and persisted in
 * SQLite so push works with zero manual key config; subscriptions are stored
 * per browser endpoint and pruned when the push service reports them gone.
 */
export class PushService {
  private readonly q;
  private readonly subject: string;
  private readonly transport: PushTransport;
  private readonly log: (msg: string) => void;
  private vapid: { publicKey: string; privateKey: string } | null = null;

  constructor(
    db: Db,
    opts: { subject?: string; transport?: PushTransport; log?: (m: string) => void } = {},
  ) {
    this.q = {
      keysGet: db.prepare(`SELECT public_key, private_key FROM push_keys WHERE id = 1`),
      keysPut: db.prepare(
        `INSERT INTO push_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)`,
      ),
      subPut: db.prepare(`INSERT INTO push_subscriptions (endpoint, agent_email, p256dh, auth, created_at)
        VALUES (@endpoint, @email, @p256dh, @auth, @now)
        ON CONFLICT(endpoint) DO UPDATE SET agent_email = excluded.agent_email,
          p256dh = excluded.p256dh, auth = excluded.auth`),
      subDel: db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`),
      subsAll: db.prepare(`SELECT endpoint, agent_email, p256dh, auth FROM push_subscriptions`),
      // an assigned chat notifies its agent; rows with no agent (subscribed
      // while identification was off) always notify
      subsFor: db.prepare(
        `SELECT endpoint, agent_email, p256dh, auth FROM push_subscriptions WHERE agent_email = ? OR agent_email = ''`,
      ),
      subByEndpoint: db.prepare(
        `SELECT endpoint, agent_email, p256dh, auth FROM push_subscriptions WHERE endpoint = ?`,
      ),
    };
    this.subject = opts.subject ?? 'mailto:admin@webchat.local';
    this.log = opts.log ?? (() => {});
    this.transport = opts.transport ?? this.webPushTransport.bind(this);
    this.ensureKeys();
  }

  /** Load the persisted VAPID keypair, or generate + persist one on first boot. */
  private ensureKeys(): void {
    const row = this.q.keysGet.get() as { public_key: string; private_key: string } | undefined;
    if (row) {
      this.vapid = { publicKey: row.public_key, privateKey: row.private_key };
      return;
    }
    const gen = webpush.generateVAPIDKeys();
    this.q.keysPut.run(gen.publicKey, gen.privateKey, new Date().toISOString());
    this.vapid = { publicKey: gen.publicKey, privateKey: gen.privateKey };
  }

  /** The VAPID public key browsers subscribe with (applicationServerKey). */
  publicKey(): string {
    return this.vapid?.publicKey ?? '';
  }

  saveSubscription(agentEmail: string, sub: PushSub): void {
    this.q.subPut.run({
      endpoint: sub.endpoint,
      email: agentEmail || '',
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      now: new Date().toISOString(),
    });
  }

  removeSubscription(endpoint: string): void {
    this.q.subDel.run(endpoint);
  }

  private webPushTransport(sub: PushSub, payload: string): Promise<DeliverResult> {
    return webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload,
      { vapidDetails: { subject: this.subject, ...this.vapid! }, TTL: 3600 },
    );
  }

  /** Deliver one payload to one subscription, pruning it if reported gone. */
  private async deliver(
    r: { endpoint: string; p256dh: string; auth: string },
    body: string,
  ): Promise<boolean> {
    const sub: PushSub = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
    try {
      await this.transport(sub, body);
      return true;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) this.removeSubscription(r.endpoint);
      else this.log(`[push] send failed (${code ?? '?'}): ${String((e as Error).message ?? e)}`);
      return false;
    }
  }

  /**
   * Deliver to one agent's devices, or to every subscription when
   * targetEmail is null (an unassigned chat notifies everyone). `opts.allow`
   * filters per subscription by its owner's email — that's how per-person
   * notification preferences are enforced; omitted = deliver to all (the
   * pre-prefs behavior). Endpoints reported gone (404/410) are pruned.
   */
  async send(
    targetEmail: string | null,
    payload: PushPayload,
    opts: { allow?: (agentEmail: string) => boolean } = {},
  ): Promise<number> {
    const all = (
      targetEmail ? this.q.subsFor.all(targetEmail) : this.q.subsAll.all()
    ) as Array<{ endpoint: string; agent_email: string; p256dh: string; auth: string }>;
    const rows = opts.allow ? all.filter((r) => opts.allow!(r.agent_email)) : all;
    if (!rows.length) return 0;
    const body = JSON.stringify(payload);
    const results = await Promise.all(rows.map((r) => this.deliver(r, body)));
    return results.filter(Boolean).length;
  }

  /** Deliver to a single known subscription (used by the "send test" button). */
  async sendToEndpoint(endpoint: string, payload: PushPayload): Promise<number> {
    const r = this.q.subByEndpoint.get(endpoint) as
      | { endpoint: string; p256dh: string; auth: string }
      | undefined;
    if (!r) return 0;
    return (await this.deliver(r, JSON.stringify(payload))) ? 1 : 0;
  }
}

interface UpsertRecord {
  key?: { remoteJid?: string; fromMe?: boolean; id?: string };
  pushName?: string;
  message?: Record<string, any>;
  messageTimestamp?: unknown;
}

/** A short, human preview of an incoming message for the notification body. */
export function messagePreview(message: Record<string, any> | undefined): string {
  const m = message ?? {};
  if (m.conversation) return String(m.conversation);
  if (m.extendedTextMessage?.text) return String(m.extendedTextMessage.text);
  if (m.imageMessage) return m.imageMessage.caption ? `📷 ${m.imageMessage.caption}` : '📷 Photo';
  if (m.videoMessage) return m.videoMessage.caption ? `🎥 ${m.videoMessage.caption}` : '🎥 Video';
  if (m.audioMessage) return '🎤 Voice message';
  if (m.documentMessage) return `📄 ${m.documentMessage.fileName ?? 'Document'}`;
  if (m.stickerMessage) return '🏷 Sticker';
  if (m.locationMessage) return '📍 Location';
  if (m.contactMessage) return '👤 Contact';
  if (m.pollCreationMessage || m.pollCreationMessageV3) return '📊 Poll';
  return 'New message';
}

/** Raw text/caption of a message, for keyword-alert matching (no emoji prefix). */
export function messageText(message: Record<string, any> | undefined): string {
  const m = message ?? {};
  return String(
    m.conversation ??
      m.extendedTextMessage?.text ??
      m.imageMessage?.caption ??
      m.videoMessage?.caption ??
      m.documentMessage?.caption ??
      '',
  );
}

const phoneFromJid = (jid: string): string => {
  const local = jid.split('@')[0] ?? jid;
  return jid.endsWith('@s.whatsapp.net') ? `+${local}` : local;
};

/**
 * A reconnecting instance replays history (Baileys offline sync): those arrive
 * as fresh upserts but carry their original (old) timestamps. Notify only for
 * messages sent within this window so a reconnect can't fire a flood of stale
 * notifications — the same defence msgstats uses for its day buckets.
 */
const NOTIFY_FRESH_MS = 5 * 60_000;

/**
 * Relay listener: send a Web Push for each incoming message so a phone is
 * notified even with the app closed. Mirrors the in-page rule — an assigned
 * chat pings only its agent, an unassigned chat pings everyone.
 *
 * Which Evolution lines notify is fully operator-controlled (Settings →
 * Notifications → channels): `notifyInstances()` is the complete allowlist,
 * the default line included. Nothing is implicit — an empty list means **no
 * notifications at all**, so an operator can switch every channel off.
 */
export function attachPushNotifier(
  relay: EventRelay,
  push: PushService,
  meta: ChatMetaStore,
  defaultInstance: () => string = () => '',
  notifyInstances: () => string[] = () => [],
  /** Per-person category/quiet/keyword prefs; omitted = notify all (pre-prefs). */
  prefs?: PrefsSource,
  log: (msg: string) => void = () => {},
): void {
  relay.subscribe((e) => {
    if (e.event !== 'MESSAGES_UPSERT' && e.event !== 'messages.upsert') return;
    const { instance, records } = unwrapEvent(e.data);
    const inst = instance ?? defaultInstance(); // a bare (untagged) event is the default line
    // Only the explicitly chosen lines notify; an empty list = none.
    if (!notifyInstances().includes(inst)) return;
    for (const record of records as UpsertRecord[]) {
      try {
        const jid = record.key?.remoteJid ?? '';
        if (!jid || jid === 'status@broadcast' || record.key?.fromMe) continue;
        if (record.message?.reactionMessage) continue; // reactions aren't messages
        const ts = messageTimeMs(record.messageTimestamp);
        if (ts !== null && Date.now() - ts > NOTIFY_FRESH_MS) continue; // replayed history
        const canon = meta.canon(jid);
        const target = meta.assigneeOf(canon); // null = notify everyone
        const who = record.pushName || phoneFromJid(jid);
        // deep-link the click straight to this conversation, scrolled to this
        // message — the SW reads payload.url (see frontend/public/sw.js).
        const msgId = record.key?.id ?? '';
        const url =
          `/?chat=${encodeURIComponent(canon)}` + (msgId ? `&msg=${encodeURIComponent(msgId)}` : '');
        // each subscription's owner decides via their own prefs (group/DM mute,
        // quiet hours, keyword alerts) — see shouldNotifyMessage.
        const isGroup = jid.endsWith('@g.us');
        const text = messageText(record.message);
        const allow = (email: string) =>
          shouldNotifyMessage(prefs ? prefs.get(email) : DEFAULT_NOTIFY_PREFS, { isGroup, text });
        void push.send(
          target,
          {
            title: who,
            body: messagePreview(record.message).slice(0, 140),
            tag: canon,
            url,
          },
          { allow },
        );
      } catch (err) {
        log(`[push] notifier error: ${String(err)}`);
      }
    }
  });
}

/** Minimal view of a finished job's progress event (scheduler JOB_PROGRESS). */
interface JobDoneEvent {
  jobId?: string;
  done?: boolean;
  total?: number;
  sent?: number;
  skipped?: number;
  failed?: number;
  status?: string;
}

/**
 * Relay listener: when a scheduled/bulk job finishes (JOB_PROGRESS done), push
 * a summary to the agent who created it (job.sentBy) — or everyone when it has
 * no owner (created while identification was off). Each device is gated by its
 * owner's job prefs (jobsEnded / failures-only / quiet hours). The scheduler
 * emits many done:false progress events per job; only done:true acts here.
 */
export function attachJobNotifier(
  relay: EventRelay,
  push: PushService,
  jobs: { byId(id: string): { sentBy: string | null } | null },
  prefs: PrefsSource,
  log: (msg: string) => void = () => {},
): void {
  relay.subscribe((e) => {
    if (e.event !== 'JOB_PROGRESS') return;
    const d = e.data as JobDoneEvent | null;
    if (!d || !d.done || !d.jobId) return;
    try {
      const target = jobs.byId(d.jobId)?.sentBy || null; // null = everyone
      const failed = Number(d.failed ?? 0);
      const sent = Number(d.sent ?? 0);
      const total = Number(d.total ?? 0);
      const skipped = Number(d.skipped ?? 0);
      const verb = d.status === 'failed' ? 'failed' : d.status === 'cancelled' ? 'cancelled' : 'finished';
      let body = `${sent}/${total} sent`;
      if (skipped) body += `, ${skipped} skipped`;
      if (failed) body += `, ${failed} failed`;
      const allow = (email: string) => shouldNotifyJob(prefs.get(email), { failed });
      // click opens History focused on this job (see frontend App deep-link)
      const url = `/?job=${encodeURIComponent(d.jobId)}`;
      void push.send(target, { title: `Job ${verb}`, body, tag: `job:${d.jobId}`, url }, { allow });
    } catch (err) {
      log(`[push] job notifier error: ${String(err)}`);
    }
  });
}
