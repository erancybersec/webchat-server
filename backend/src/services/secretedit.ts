import crypto from 'node:crypto';
import type { CachedContent } from './msgcache.js';

/**
 * Recover the new text of a WhatsApp edit that arrived END-TO-END ENCRYPTED.
 *
 * Most edits reach Evolution decrypted, as a `protocolMessage.editedMessage`
 * that overwrites the row in place (handled in msgcache.ts / chatModel.ts).
 * But some — notably media-caption edits, and edits on HD photos — arrive as a
 * `secretEncryptedMessage` with `secretEncType = 2` (MESSAGE_EDIT) that this
 * Evolution build cannot decrypt. The new text is then invisible: the original
 * row keeps its pre-edit caption and gets no EDITED marker, so the chat shows
 * stale content (e.g. an old coupon-code caption instead of the edited reply).
 *
 * We CAN decrypt it ourselves. WhatsApp derives the addon's AES-GCM key from
 * the ORIGINAL message's `messageContextInfo.messageSecret` (which Evolution
 * does store on the original record) via the same "message secret" scheme used
 * for encrypted poll votes. Ported from whatsmeow's msgsecret.go and verified
 * against a real prod record (see secretedit.test.ts):
 *
 *   info = origMsgId ++ origSenderJid ++ modSenderJid ++ "Message Edit"
 *   key  = HKDF-SHA256(ikm = messageSecret, salt = ∅, info, len = 32)
 *   AAD  = none (only Poll Vote / Event Response use "<id>\0<sender>")
 *   pt   = AES-256-GCM(key, iv = encIv, ct||tag = encPayload)
 *
 * `pt` is a serialized `Message` proto carrying protocolMessage.editedMessage.
 */

const MOD_TYPE = 'Message Edit';
const SECRET_ENC_TYPE_MESSAGE_EDIT = 2;

// ── minimal protobuf reader (length-delimited fields are all we navigate) ────

type PbField = { wire: number; bytes?: Buffer; value?: number };

/** Read a base-128 varint. Uses float math so 64-bit lengths can't overflow. */
function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p++]!;
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [result, p];
    shift += 7;
  }
  return [result, p];
}

/** Parse one protobuf message into fieldNumber → occurrences (last wins on read). */
function readMessage(buf: Buffer): Map<number, PbField[]> {
  const out = new Map<number, PbField[]>();
  let pos = 0;
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos);
    pos = afterTag;
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    let f: PbField;
    if (wire === 0) {
      const [v, p] = readVarint(buf, pos);
      f = { wire, value: v };
      pos = p;
    } else if (wire === 2) {
      const [len, p] = readVarint(buf, pos);
      f = { wire, bytes: buf.subarray(p, p + len) };
      pos = p + len;
    } else if (wire === 1) {
      f = { wire, bytes: buf.subarray(pos, pos + 8) };
      pos += 8;
    } else if (wire === 5) {
      f = { wire, bytes: buf.subarray(pos, pos + 4) };
      pos += 4;
    } else {
      break; // unknown/illegal wire type — stop rather than misparse
    }
    const arr = out.get(field);
    if (arr) arr.push(f);
    else out.set(field, [f]);
  }
  return out;
}

const sub = (m: Map<number, PbField[]>, field: number): Buffer | undefined =>
  m.get(field)?.find((f) => f.wire === 2)?.bytes;
const str = (m: Map<number, PbField[]>, field: number): string => sub(m, field)?.toString('utf8') ?? '';

// WAProto field numbers (Message / ProtocolMessage / media caption fields).
const F = {
  conversation: 1,
  imageMessage: 3,
  extendedTextMessage: 6,
  documentMessage: 7,
  videoMessage: 9,
  protocolMessage: 12,
  editedMessage: 14, // within ProtocolMessage
  extendedText_text: 1,
  image_caption: 3,
  video_caption: 7,
  document_caption: 20,
} as const;

/** Pull renderable content out of a decrypted `Message` proto. Mirrors extractCacheContent. */
function contentFromMessage(m: Map<number, PbField[]>): CachedContent | null {
  if (m.has(F.conversation)) return { type: 'text', text: str(m, F.conversation), caption: '' };
  const ext = sub(m, F.extendedTextMessage);
  if (ext) return { type: 'text', text: str(readMessage(ext), F.extendedText_text), caption: '' };
  const img = sub(m, F.imageMessage);
  if (img) return { type: 'image', text: '', caption: str(readMessage(img), F.image_caption) };
  const vid = sub(m, F.videoMessage);
  if (vid) return { type: 'video', text: '', caption: str(readMessage(vid), F.video_caption) };
  const doc = sub(m, F.documentMessage);
  if (doc) return { type: 'document', text: '', caption: str(readMessage(doc), F.document_caption) };
  return null;
}

/** Decode the decrypted plaintext (a Message → protocolMessage → editedMessage). */
export function parseEditPlaintext(plaintext: Buffer): CachedContent | null {
  try {
    const proto = sub(readMessage(plaintext), F.protocolMessage);
    if (!proto) return null;
    const edited = sub(readMessage(proto), F.editedMessage);
    if (!edited) return null;
    return contentFromMessage(readMessage(edited));
  } catch {
    return null;
  }
}

// ── decryption ───────────────────────────────────────────────────────────

/** ToNonAD: drop the device suffix ("user:dev@server" → "user@server"). */
export function normalizeJid(jid: string): string {
  if (!jid) return '';
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  return `${jid.slice(0, at).split(':')[0]}@${jid.slice(at + 1)}`;
}

function deriveKey(secret: Buffer, origMsgId: string, origSender: string, modSender: string): Buffer {
  const info = Buffer.concat([
    Buffer.from(origMsgId, 'utf8'),
    Buffer.from(origSender, 'utf8'),
    Buffer.from(modSender, 'utf8'),
    Buffer.from(MOD_TYPE, 'utf8'),
  ]);
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
}

function gcmDecrypt(key: Buffer, iv: Buffer, payload: Buffer): Buffer {
  const tag = payload.subarray(payload.length - 16);
  const ct = payload.subarray(0, payload.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export interface EncryptedEdit {
  encIv: Buffer;
  encPayload: Buffer;
  /** the edited message's id (secretEncryptedMessage.targetMessageKey.id) */
  origMsgId: string;
}

/**
 * Decrypt one encrypted MESSAGE_EDIT into its new content. `senderCandidates`
 * are the possible orig/mod sender JIDs (the lid/phone forms off the edit and
 * original records) — every (orig, mod) pair is tried; AES-GCM's auth tag
 * makes a wrong combo fail closed, so brute-forcing the handful is safe and
 * sidesteps the @lid/@s.whatsapp.net ambiguity. Returns null if none decrypt.
 */
export function decryptEdit(
  messageSecret: Buffer,
  edit: EncryptedEdit,
  senderCandidates: string[],
): CachedContent | null {
  const cands = [...new Set(senderCandidates.map(normalizeJid).filter(Boolean))];
  for (const origS of cands) {
    for (const modS of cands) {
      let plaintext: Buffer;
      try {
        plaintext = gcmDecrypt(deriveKey(messageSecret, edit.origMsgId, origS, modS), edit.encIv, edit.encPayload);
      } catch {
        continue; // auth failed → wrong sender combo
      }
      const content = parseEditPlaintext(plaintext);
      if (content) return content;
    }
  }
  return null;
}

export { SECRET_ENC_TYPE_MESSAGE_EDIT };
