/**
 * Phone normalization — must stay identical to the backend's normalizePhone
 * (backend/src/services/phone.ts) so the compose blacklist warning predicts
 * exactly what the server will skip.
 */
export function normalizePhone(raw: unknown): string | null {
  if (raw == null) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.startsWith('972') && d.length === 12 && d[3] === '5') return d;
  if (d.startsWith('0') && d.length === 10 && d[1] === '5') return '972' + d.slice(1);
  if (d.startsWith('5') && d.length === 9) return '972' + d;
  if (d.startsWith('972')) return null;
  if (/^[1-9]\d{9,14}$/.test(d)) return d;
  return null;
}

/** Valid recipient id: a normalizable phone or any JID (groups, lids). */
export function normalizeRecipientId(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.includes('@')) return s; // JID — pass through
  return normalizePhone(s);
}

/**
 * A key for matching a job's `recipients[].id` (often bare digits — a
 * mass-imported list never touched a contact picker) against an open chat's
 * jid (always `<digits>@s.whatsapp.net`/`@g.us`). `normalizePhone` strips
 * everything non-digit, so it already collapses either shape to the same
 * phone — falls back to the raw value for a group/lid id that isn't phone-
 * shaped, so those still match by plain equality.
 */
export function phoneKey(id: string): string {
  return normalizePhone(id) ?? id;
}
