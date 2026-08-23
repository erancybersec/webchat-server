import { describe, expect, it } from 'vitest';
import { recipientLabel, recipientName } from '../src/lib/useRecipientNames';

describe('recipient name resolution', () => {
  const names = new Map([
    ['972520000001@s.whatsapp.net', 'Dana Levi'],
    ['972520000001', 'Dana Levi'],
    ['123456789-987654@g.us', 'Studio Crew'],
  ]);

  it('resolves a bare-number recipient via either key form', () => {
    expect(recipientName('972520000001', names)).toBe('Dana Levi');
    expect(recipientName('972520000001@s.whatsapp.net', names)).toBe('Dana Levi');
    expect(recipientLabel('972520000001', names)).toBe('Dana Levi');
  });

  it('resolves group subjects by full JID', () => {
    expect(recipientLabel('123456789-987654@g.us', names)).toBe('Studio Crew');
  });

  it('falls back to a readable number / bare group id when unnamed', () => {
    expect(recipientName('972529999999', names)).toBeNull();
    expect(recipientLabel('972529999999', names)).toBe('+972529999999');
    expect(recipientLabel('555-444@g.us', names)).toBe('555-444');
    // the scheduler's status-broadcast ledger row stays readable as-is
    expect(recipientLabel('status@broadcast', names)).toBe('status');
  });
});
