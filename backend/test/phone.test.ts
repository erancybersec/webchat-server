import { describe, expect, it } from 'vitest';
import { isGroupJid, normalizePhone } from '../src/services/phone.js';

describe('normalizePhone', () => {
  it('keeps canonical israeli mobile numbers', () => {
    expect(normalizePhone('972529876543')).toBe('972529876543');
  });
  it('converts 05X local format', () => {
    expect(normalizePhone('0529876543')).toBe('972529876543');
  });
  it('converts bare 5X format', () => {
    expect(normalizePhone('529876543')).toBe('972529876543');
  });
  it('strips formatting characters', () => {
    expect(normalizePhone('+972 52-987-6543')).toBe('972529876543');
  });
  it('rejects malformed israeli numbers', () => {
    expect(normalizePhone('97212345678')).toBeNull();
    expect(normalizePhone('0312345678')).toBeNull();
  });
  it('accepts generic international numbers', () => {
    expect(normalizePhone('14155552671')).toBe('14155552671');
  });
  it('rejects garbage', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
  });
});

describe('isGroupJid', () => {
  it('detects group jids', () => {
    expect(isGroupJid('1234567890-123@g.us')).toBe(true);
    expect(isGroupJid('972529876543')).toBe(false);
    expect(isGroupJid(null)).toBe(false);
  });
});
