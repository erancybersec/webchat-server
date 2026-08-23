import type { JobItem } from '../types.js';
import type { BlacklistStore } from './blacklist.js';
import type { EvolutionApi } from './evolution.js';
import { buildEvoRequest } from './messages.js';
import { isNotOnWhatsAppError, type VerificationService } from './verification.js';

export type SendOutcome =
  | { status: 'sent'; messageId?: string }
  | { status: 'skipped'; reason: 'blacklisted' | 'not_on_whatsapp' };

export interface SendOptions {
  /** Evolution instance name; defaults to the Settings default. */
  instance?: string;
  /**
   * Refuse to send to a number WhatsApp has told us is not registered.
   * Campaigns pass true; 1:1 chat never does — a reply to a live conversation
   * must not be blockable by a stale cache entry or a lookup outage.
   */
  enforceVerification?: boolean;
}

/** Best-effort extraction of the message id Evolution assigned to a send. */
function extractMessageId(text: string): string | undefined {
  try {
    const data = JSON.parse(text) as { key?: { id?: unknown }; messageId?: unknown };
    const id = data?.key?.id ?? data?.messageId;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Sends one item to one recipient, enforcing the blacklist. Throws on failure. */
export class Sender {
  constructor(
    private readonly evo: EvolutionApi,
    private readonly blacklist: BlacklistStore,
    private readonly verification?: VerificationService,
  ) {}

  /**
   * `opts` may be an instance name for the original 3-arg callers, or the full
   * SendOptions bag.
   */
  async sendOne(
    recipient: string,
    item: JobItem,
    opts?: string | SendOptions,
  ): Promise<SendOutcome> {
    const { instance, enforceVerification } =
      typeof opts === 'string' ? { instance: opts, enforceVerification: false } : (opts ?? {});
    // isBlacklisted() already exempts group JIDs by format — deciding from a
    // caller-supplied "is a group" flag would let it bypass the blacklist.
    if (this.blacklist.isBlacklisted(recipient)) {
      return { status: 'skipped', reason: 'blacklisted' };
    }
    // Known-dead number: skip WITHOUT throwing, so the ledger records it as a
    // settled outcome instead of a retryable failure. verifyKey() returns null
    // for groups, so a group is never gated here.
    if (enforceVerification && this.verification?.store.fresh(recipient)?.status === 'invalid') {
      return { status: 'skipped', reason: 'not_on_whatsapp' };
    }
    const { endpoint, body } = buildEvoRequest(item, recipient, instance || this.evo.instance);
    const r = await this.evo.call(endpoint, body, 'POST');
    if (!r.ok) {
      // "not on WhatsApp" is PERMANENT — retrying it just burns the send gap
      // twice more for a number that can never receive. Record it so the next
      // campaign skips it up front, and settle this row now.
      if (isNotOnWhatsAppError(r.text)) {
        this.verification?.recordInvalid(recipient, instance);
        return { status: 'skipped', reason: 'not_on_whatsapp' };
      }
      throw new Error(`evolution ${r.status}: ${r.text.slice(0, 200)}`);
    }
    return { status: 'sent', messageId: extractMessageId(r.text) };
  }
}
