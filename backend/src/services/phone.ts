/**
 * Phone normalization shared with the SPA (its blNorm mirrors this).
 * Returns the canonical digit string the blacklist stores, or null when the
 * input can't be a valid subscriber number.
 */
export function normalizePhone(raw: unknown): string | null {
  if (raw == null) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.startsWith('972') && d.length === 12 && d[3] === '5') return d; // 972 5X XXXXXXX
  if (d.startsWith('0') && d.length === 10 && d[1] === '5') return '972' + d.slice(1); // 05X…
  if (d.startsWith('5') && d.length === 9) return '972' + d; // 5X…
  if (d.startsWith('972')) return null; // malformed IL number
  if (/^[1-9]\d{9,14}$/.test(d)) return d; // generic international
  return null;
}

export function digitsOnly(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '');
}

export function isGroupJid(id: unknown): boolean {
  return typeof id === 'string' && id.includes('@g.us');
}

/** Recipient (raw phone or any jid) → the chat jid it lands in. */
export function toChatJid(recipient: string): string {
  return recipient.includes('@') ? recipient : `${digitsOnly(recipient)}@s.whatsapp.net`;
}

/**
 * Canonical per-subscriber key for the caches that must agree with each other
 * (number verification, contact familiarity). Tolerates any input form but
 * collapses to ONE key, so the same person can't be filed twice under two
 * spellings: the normalized form where normalizePhone recognizes it, bare
 * digits otherwise — a number our regex rejects is still a real person to
 * WhatsApp, which is the authority here, not us. Groups have no subscriber
 * key and return null.
 */
export function contactKey(raw: unknown): string | null {
  if (raw == null || isGroupJid(raw)) return null;
  const d = digitsOnly(String(raw).split('@')[0]);
  if (!d) return null;
  return normalizePhone(d) ?? d;
}
