import crypto from 'node:crypto';
import { normalizeJid } from './secretedit.js';

/**
 * Decrypt a WhatsApp poll VOTE (`pollUpdateMessage`).
 *
 * Most votes reach Evolution already decrypted — it fills `vote.selectedOptions`
 * with the chosen option NAMES, and we use those directly (see gateway). But some
 * votes (notably the freshest ones, and any whose poll secret Evolution lacked)
 * arrive as an encrypted `vote.{encIv,encPayload}` with an empty `selectedOptions`.
 * Those are invisible — they're exactly the `[pollUpdateMessage]` placeholders.
 *
 * We CAN decrypt them ourselves. WhatsApp derives the vote's AES-GCM key from the
 * POLL CREATION message's `messageContextInfo.messageSecret` (which Evolution does
 * store on the poll record) via the same "message secret" scheme used for edits
 * (secretedit.ts), but with modType "Poll Vote" AND a non-empty AAD. Ported from
 * whatsmeow's msgsecret.go and verified against real prod votes (see pollvote.test.ts):
 *
 *   info = pollMsgId ++ pollCreatorJid ++ voterJid ++ "Poll Vote"
 *   key  = HKDF-SHA256(ikm = messageSecret, salt = ∅, info, len = 32)
 *   AAD  = pollMsgId ++ "\0" ++ voterJid          (voter/creator both ToNonAD)
 *   pt   = AES-256-GCM(key, iv = encIv, ct||tag = encPayload)
 *
 * `pt` is a serialized `PollVoteMessage` proto whose field 1 is a repeated set of
 * 32-byte SHA-256 hashes of the selected option names. The caller maps each hash
 * back to an option via `hashPollOption`.
 */

const MOD_TYPE = 'Poll Vote';

/** SHA-256 of an option's UTF-8 name (hex) — matches a decrypted vote's selectedOptions. */
export function hashPollOption(optionName: string): string {
  return crypto.createHash('sha256').update(Buffer.from(optionName, 'utf8')).digest('hex');
}

function deriveKey(secret: Buffer, pollMsgId: string, creator: string, voter: string): Buffer {
  const info = Buffer.concat([
    Buffer.from(pollMsgId, 'utf8'),
    Buffer.from(creator, 'utf8'),
    Buffer.from(voter, 'utf8'),
    Buffer.from(MOD_TYPE, 'utf8'),
  ]);
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
}

function gcmDecrypt(key: Buffer, iv: Buffer, payload: Buffer, aad?: Buffer): Buffer {
  const tag = payload.subarray(payload.length - 16);
  const ct = payload.subarray(0, payload.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/**
 * Parse a `PollVoteMessage` plaintext → the selected option hashes (hex).
 * Only field 1 (repeated bytes, wire type 2) matters; everything else is skipped.
 */
function parsePollVote(buf: Buffer): string[] {
  const hashes: string[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = buf[pos++]!;
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 2) {
      let len = 0;
      let shift = 0;
      let b: number;
      do {
        b = buf[pos++]!;
        len += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } while (b & 0x80);
      const bytes = buf.subarray(pos, pos + len);
      pos += len;
      if (field === 1) hashes.push(bytes.toString('hex'));
    } else if (wire === 0) {
      while (buf[pos++]! & 0x80) {
        /* skip varint */
      }
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      break; // unknown wire type — stop rather than misparse
    }
  }
  return hashes;
}

export interface EncryptedVote {
  encIv: Buffer;
  encPayload: Buffer;
  /** the poll creation message's id (vote.pollCreationMessageKey.id) */
  pollMsgId: string;
}

/**
 * Decrypt one encrypted poll vote into its selected option-name hashes (hex).
 * `senderCandidates` are the possible creator/voter JIDs (lid/phone forms off the
 * vote + poll records); every (creator, voter) pair is tried, with and without the
 * AAD, because AES-GCM's auth tag makes a wrong combo fail closed — so brute-forcing
 * the handful is safe and sidesteps the @lid/@s.whatsapp.net ambiguity.
 * `creatorOnlyCandidates` are extra jids tried on the CREATOR side only (e.g. the
 * group's participant lids: our own group poll's key carries no participant, and
 * Evolution never exposes our account's @lid — which the key derivation requires —
 * anywhere else). Kept creator-side to avoid a full cross-product blowup on large
 * groups. Returns null if none decrypt.
 */
export function decryptPollVote(
  messageSecret: Buffer,
  vote: EncryptedVote,
  senderCandidates: string[],
  creatorOnlyCandidates: string[] = [],
): string[] | null {
  const cands = [...new Set(senderCandidates.map(normalizeJid).filter(Boolean))];
  const creators = [
    ...new Set([...cands, ...creatorOnlyCandidates.map(normalizeJid).filter(Boolean)]),
  ];
  const aadOf = (voter: string): (Buffer | undefined)[] => [
    Buffer.concat([Buffer.from(vote.pollMsgId, 'utf8'), Buffer.from([0]), Buffer.from(voter, 'utf8')]),
    undefined,
  ];
  for (const creator of creators) {
    for (const voter of cands) {
      const key = deriveKey(messageSecret, vote.pollMsgId, creator, voter);
      for (const aad of aadOf(voter)) {
        try {
          return parsePollVote(gcmDecrypt(key, vote.encIv, vote.encPayload, aad));
        } catch {
          // auth failed → wrong sender/aad combo, keep trying
        }
      }
    }
  }
  return null;
}
