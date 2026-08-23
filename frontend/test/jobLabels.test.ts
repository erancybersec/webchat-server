import { describe, expect, it } from 'vitest';
import { jobKind, jobOriginLabel } from '../src/lib/jobLabels';
import type { JobItem, Recipient } from '../src/types';

const TEXT: JobItem = { type: 'text', data: { text: 'hi' } };
const CONTACT: Recipient = { id: '972520000001' };
const GROUP: Recipient = { id: '123456789-987654@g.us', isGroup: true };

const job = (recipients: Recipient[], items: JobItem[], type: string | null) => ({
  recipients,
  items,
  type,
});

describe('job kind', () => {
  it('reads Compose sends as plain contact sends', () => {
    expect(jobKind(job([CONTACT], [TEXT], 'immediate'))).toBe('contacts');
  });

  it('reads an all-group audience as a broadcast, whatever the stored type', () => {
    expect(jobKind(job([GROUP, GROUP], [TEXT], 'immediate'))).toBe('groups');
    expect(jobKind(job([GROUP], [TEXT], 'group-broadcast'))).toBe('groups');
  });

  it('does not call a mixed audience a group broadcast', () => {
    expect(jobKind(job([GROUP, CONTACT], [TEXT], 'immediate'))).toBe('contacts');
  });

  it('reads Tools item types as a tool send', () => {
    const loc: JobItem = { type: 'location', data: { latitude: 1, longitude: 2 } };
    expect(jobKind(job([CONTACT], [loc], 'immediate'))).toBe('tools');
  });

  it('prefers tools over groups — a Status/Story is addressed to a group jid', () => {
    const status: JobItem = { type: 'status', data: { statusType: 'text', content: 'hi' } };
    const broadcast: Recipient = { id: 'status@broadcast', isGroup: true };
    expect(jobKind(job([broadcast], [status], 'immediate'))).toBe('tools');
  });

  it('needs every item to be a tool item — a mixed sequence came from Compose', () => {
    const loc: JobItem = { type: 'location', data: {} };
    expect(jobKind(job([CONTACT], [TEXT, loc], 'immediate'))).toBe('contacts');
  });

  it('survives an empty job without claiming a kind', () => {
    expect(jobKind(job([], [], null))).toBe('contacts');
  });
});

describe('history chip label', () => {
  it('keeps the bare origin for contact sends', () => {
    expect(jobOriginLabel(job([CONTACT], [TEXT], 'immediate'))).toBe('sent now');
    expect(jobOriginLabel(job([CONTACT], [TEXT], null))).toBe('scheduled');
  });

  it('prefixes group broadcasts, immediate and scheduled alike', () => {
    expect(jobOriginLabel(job([GROUP], [TEXT], 'immediate'))).toBe('group · sent now');
    expect(jobOriginLabel(job([GROUP], [TEXT], 'group-broadcast'))).toBe('group · scheduled');
  });

  it('prefixes tool sends', () => {
    const loc: JobItem = { type: 'location', data: {} };
    expect(jobOriginLabel(job([CONTACT], [loc], 'immediate'))).toBe('tool · sent now');
    expect(jobOriginLabel(job([CONTACT], [loc], null))).toBe('tool · scheduled');
  });
});
