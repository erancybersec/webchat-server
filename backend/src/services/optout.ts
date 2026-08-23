import type { Config } from '../config.js';
import type { BlacklistStore } from './blacklist.js';
import { unwrapEvent } from './envelope.js';
import type { EventRelay } from './events.js';
import { isGroupJid } from './phone.js';
import type { Sender } from './sender.js';

type Logger = (msg: string) => void;

interface IncomingRecord {
  key?: { remoteJid?: string; fromMe?: boolean };
  pushName?: string;
  message?: { conversation?: string; extendedTextMessage?: { text?: string } };
}

function extractText(r: IncomingRecord): string {
  return r.message?.conversation ?? r.message?.extendedTextMessage?.text ?? '';
}

/** Comma/newline-separated keywords → trimmed lowercase set. */
export function parseKeywords(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Auto opt-out: an incoming direct message that exactly matches a keyword
 * ("STOP", "הסר") blacklists the sender. Off by default; the toggle, keywords
 * and optional confirmation reply live in Settings (managed from the
 * Blacklist page). cfg is held by reference, so changes apply live.
 */
export class OptOutListener {
  constructor(
    private readonly cfg: Config,
    private readonly blacklist: BlacklistStore,
    private readonly sender: Sender,
    private readonly log: Logger = (m) => console.log(new Date().toISOString(), m),
  ) {}

  attach(relay: EventRelay): void {
    relay.subscribe((e) => {
      if (e.event !== 'MESSAGES_UPSERT' && e.event !== 'messages.upsert') return;
      if (!this.cfg.optoutEnabled) return;
      const { instance, records } = unwrapEvent(e.data);
      // The relay carries every instance's events since v2.9. The blacklist
      // is global — a "STOP" on a secondary instance must not opt the sender
      // out of the main line, so opt-out only watches the default instance.
      if (instance !== undefined && instance !== this.cfg.evo.instance) return;
      for (const record of records as IncomingRecord[]) {
        // fire-and-forget: a failure here must never break the relay fan-out
        void this.handle(record, instance).catch((err) =>
          this.log(`[optout] error: ${String(err)}`),
        );
      }
    });
  }

  private async handle(r: IncomingRecord, instance?: string): Promise<void> {
    const jid = r.key?.remoteJid ?? '';
    if (!jid || r.key?.fromMe || isGroupJid(jid)) return;
    const text = extractText(r).trim().toLowerCase();
    if (!text || !parseKeywords(this.cfg.optoutKeywords).includes(text)) return;

    const phone = jid.split('@')[0]!;
    // confirmation goes out BEFORE the blacklist insert — afterwards the
    // sender's own blacklist check would skip it. It replies through the
    // instance the message arrived on, not the default.
    if (this.cfg.optoutReply.trim()) {
      try {
        await this.sender.sendOne(
          phone,
          { type: 'text', data: { text: this.cfg.optoutReply } },
          instance,
        );
      } catch (err) {
        this.log(`[optout] confirmation to ${phone} failed: ${String(err)}`);
      }
    }
    const { added } = this.blacklist.addMany([
      { phone_number: phone, name: r.pushName ?? '', why_blacklisted: 'opt-out (auto)' },
    ]);
    if (added) this.log(`[optout] ${phone} blacklisted (keyword match)`);
  }
}
