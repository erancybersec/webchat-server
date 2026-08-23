import { describe, expect, it } from 'vitest';
import { decryptEdit, normalizeJid, parseEditPlaintext } from '../src/services/secretedit.js';

// Synthetic vector exercising the real scheme (HKDF-SHA256 + AES-256-GCM, no
// AAD) — see secretedit.ts for the derivation. An incoming image whose caption
// was edited via a secretEncryptedMessage (secretEncType 2 = MESSAGE_EDIT);
// the original image carries the messageSecret, the edit carries encIv/encPayload.
const MESSAGE_SECRET = Buffer.from('2bW23zUD4M0C7InsHTQe+QJbE62K4+f7QwLv5d4gdiQ=', 'base64');
const ORIG_MSG_ID = 'TESTMSG00000000000D4';
const SENDER = '900000000000030@lid'; // customer lid (origSender == modSender here)
const EDIT = {
  origMsgId: ORIG_MSG_ID,
  encIv: Buffer.from('C8wfvNfTtDBEzzik', 'base64'),
  encPayload: Buffer.from('4KwNPmGtJnJ6nahU7TfnRVE//iEMnImefafwjpLLnQwzpS4DRcrGZnTZATlhtv8=', 'base64'),
};

describe('decryptEdit (encrypted MESSAGE_EDIT recovery)', () => {
  it('recovers the edited image caption from the vector', () => {
    const content = decryptEdit(MESSAGE_SECRET, EDIT, [SENDER]);
    expect(content).toEqual({ type: 'image', text: '', caption: 'updated caption text :)' });
  });

  it('finds the right sender combo when extra candidates are present', () => {
    const content = decryptEdit(MESSAGE_SECRET, EDIT, [
      '972500000060@s.whatsapp.net',
      '900000000000031@lid',
      SENDER, // the real one, buried among decoys
    ]);
    expect(content?.caption).toBe('updated caption text :)');
  });

  it('returns null when no candidate sender decrypts (wrong key fails closed)', () => {
    const content = decryptEdit(MESSAGE_SECRET, EDIT, ['999999999@lid']);
    expect(content).toBeNull();
  });

  it('returns null on a corrupted payload rather than throwing', () => {
    const bad = { ...EDIT, encPayload: Buffer.concat([EDIT.encPayload.subarray(0, -1), Buffer.from([0x00])]) };
    expect(decryptEdit(MESSAGE_SECRET, bad, [SENDER])).toBeNull();
  });
});

describe('parseEditPlaintext', () => {
  it('returns null for non-protocolMessage plaintext', () => {
    expect(parseEditPlaintext(Buffer.from('not a protobuf'))).toBeNull();
  });
});

describe('normalizeJid', () => {
  it('strips the device suffix (ToNonAD)', () => {
    expect(normalizeJid('900000000000030:12@lid')).toBe('900000000000030@lid');
    expect(normalizeJid('972500000060@s.whatsapp.net')).toBe('972500000060@s.whatsapp.net');
    expect(normalizeJid('')).toBe('');
  });
});
