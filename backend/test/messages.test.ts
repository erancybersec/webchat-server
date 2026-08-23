import { describe, expect, it } from 'vitest';
import { buildEvoRequest } from '../src/services/messages.js';

const N = '972521111111';

describe('buildEvoRequest — full item type coverage', () => {
  it('location', () => {
    const r = buildEvoRequest(
      { type: 'location', data: { latitude: 32.08, longitude: 34.78, name: 'Studio', address: 'TLV' } },
      N,
      'Test',
    );
    expect(r.endpoint).toBe('/message/sendLocation/Test');
    expect(r.body).toEqual({ number: N, latitude: 32.08, longitude: 34.78, name: 'Studio', address: 'TLV' });
    expect(() => buildEvoRequest({ type: 'location', data: {} }, N, 'Test')).toThrow();
  });

  it('contact', () => {
    const r = buildEvoRequest(
      { type: 'contact', data: { fullName: 'Dana', phoneNumber: '972520000000' } },
      N,
      'Test',
    );
    expect(r.endpoint).toBe('/message/sendContact/Test');
    expect(r.body).toEqual({
      number: N,
      contact: [{ fullName: 'Dana', wuid: '972520000000', phoneNumber: '972520000000' }],
    });
  });

  it('reaction', () => {
    const r = buildEvoRequest(
      { type: 'reaction', data: { messageId: 'MSG1', reaction: '❤️', fromMe: true } },
      `${N}@s.whatsapp.net`,
      'Test',
    );
    expect(r.endpoint).toBe('/message/sendReaction/Test');
    expect(r.body).toEqual({
      key: { remoteJid: `${N}@s.whatsapp.net`, fromMe: true, id: 'MSG1' },
      reaction: '❤️',
    });
  });

  it('list', () => {
    const sections = [{ title: 'S1', rows: [{ title: 'R1', description: '', rowId: 'r1' }] }];
    const r = buildEvoRequest(
      { type: 'list', data: { title: 'Menu', buttonText: 'Open', sections, footerText: 'foot' } },
      N,
      'Test',
    );
    expect(r.endpoint).toBe('/message/sendList/Test');
    expect(r.body).toMatchObject({ number: N, title: 'Menu', buttonText: 'Open', sections, footerText: 'foot' });
    expect(() => buildEvoRequest({ type: 'list', data: { title: 'x', buttonText: 'y', sections: [] } }, N, 'Test')).toThrow();
  });

  it('status text and media', () => {
    const text = buildEvoRequest(
      {
        type: 'status',
        data: { statusType: 'text', content: 'hello', backgroundColor: '#25D366', font: 2, allContacts: true },
      },
      'status',
      'Test',
    );
    expect(text.endpoint).toBe('/message/sendStatus/Test');
    expect(text.body).toEqual({
      type: 'text',
      content: 'hello',
      allContacts: true,
      backgroundColor: '#25D366',
      font: 2,
    });

    const media = buildEvoRequest(
      {
        type: 'status',
        data: {
          statusType: 'image',
          content: 'https://x/img.jpg',
          caption: 'cap',
          allContacts: false,
          statusJidList: ['972521111111@s.whatsapp.net'],
        },
      },
      'status',
      'Test',
    );
    expect(media.body).toEqual({
      type: 'image',
      content: 'https://x/img.jpg',
      allContacts: false,
      statusJidList: ['972521111111@s.whatsapp.net'],
      caption: 'cap',
    });
  });

  describe('poll selectableCount normalization', () => {
    const opts = ['Yes', 'No', 'Maybe'];

    it('single-answer poll sends selectableCount 1', () => {
      const r = buildEvoRequest({ type: 'poll', data: { question: 'Q?', options: opts, selectable: 1 } }, N, 'Test');
      expect(r.endpoint).toBe('/message/sendPoll/Test');
      expect(r.body).toEqual({ number: N, name: 'Q?', values: opts, selectableCount: 1 });
    });

    it('multiple-answer poll sends selectableCount 0 (WhatsApp spec, not the option count)', () => {
      // The old build sent selectableCount = options.length (3) here, which made
      // votes undecryptable on WhatsApp itself. Must be 0.
      const r = buildEvoRequest({ type: 'poll', data: { question: 'Q?', options: opts, selectable: 0 } }, N, 'Test');
      expect((r.body as { selectableCount: number }).selectableCount).toBe(0);
    });

    it('repairs a legacy item that stored the option count for "multiple"', () => {
      const r = buildEvoRequest({ type: 'poll', data: { question: 'Q?', options: opts, selectable: 3 } }, N, 'Test');
      expect((r.body as { selectableCount: number }).selectableCount).toBe(0);
    });

    it('defaults a poll with no selectable to multiple (0)', () => {
      const r = buildEvoRequest({ type: 'poll', data: { question: 'Q?', options: opts } }, N, 'Test');
      expect((r.body as { selectableCount: number }).selectableCount).toBe(0);
    });

    it('rejects a poll with fewer than 2 options', () => {
      expect(() => buildEvoRequest({ type: 'poll', data: { question: 'Q?', options: ['only'] } }, N, 'Test')).toThrow(/2 options/);
    });
  });

  describe('poll whitespace trimming', () => {
    // Voting clients hash the option name inconsistently (iOS trims, others
    // don't), so an option with stray whitespace splits its votes into
    // visible/invisible — permanently, even on the WhatsApp app (option names
    // are immutable once sent). Prevent it at the source.
    it('trims the question and option names', () => {
      const r = buildEvoRequest(
        { type: 'poll', data: { question: ' Q? ', options: ['אני!! ', ' לא אוכל'] } },
        N,
        'Test',
      );
      expect(r.body).toEqual({ number: N, name: 'Q?', values: ['אני!!', 'לא אוכל'], selectableCount: 0 });
    });

    it('drops options that are only whitespace and still enforces the 2-option minimum', () => {
      expect(() =>
        buildEvoRequest({ type: 'poll', data: { question: 'Q?', options: ['Yes', '   '] } }, N, 'Test'),
      ).toThrow(/2 options/);
    });

    it('rejects a whitespace-only question', () => {
      expect(() =>
        buildEvoRequest({ type: 'poll', data: { question: '  ', options: ['Yes', 'No'] } }, N, 'Test'),
      ).toThrow(/question required/);
    });
  });

  it('still rejects unknown types', () => {
    expect(() => buildEvoRequest({ type: 'nope', data: {} }, N, 'Test')).toThrow(/Unknown/);
  });
});
