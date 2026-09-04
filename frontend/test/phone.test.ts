import { describe, expect, it } from 'vitest';
import { phoneKey } from '../src/lib/phone';

describe('phoneKey', () => {
  it('collapses a bare recipient id and a full chat jid to the same key', () => {
    // A mass-imported campaign's recipients are bare digits (never touched a
    // contact picker); an open chat's jid always carries the WhatsApp suffix.
    // Both must resolve to the same key or "is this job addressed to this
    // chat?" silently fails for every such campaign.
    expect(phoneKey('972500000001')).toBe(phoneKey('972500000001@s.whatsapp.net'));
  });

  it('falls back to the raw id for a group jid, which normalizePhone rejects', () => {
    expect(phoneKey('123-456@g.us')).toBe('123-456@g.us');
  });

  it('a lid that happens to be digit-shaped still normalizes — it is genuinely ambiguous with a phone', () => {
    // Documents the tradeoff, not a bug: normalizePhone can't tell a 15-digit
    // @lid from a real long phone number, so it normalizes both the same way.
    expect(phoneKey('141124085784604@lid')).toBe('141124085784604');
  });
});
