import { describe, expect, it } from 'vitest';
import { decryptPollVote, hashPollOption } from '../src/services/pollvote.js';

// Synthetic vectors exercising the real scheme (HKDF-SHA256 + AES-256-GCM,
// AAD = pollMsgId + "\0" + voter) — see pollvote.ts for the derivation. Two
// votes on one poll, decrypted with the poll creator's messageSecret.
const MESSAGE_SECRET = Buffer.from('zbqLoYoVdw29skpNiyo4PcKor0k4SJ45viQ3ITFmrdE=', 'base64');
const POLL_ID = 'TESTPOLL0000000000A1';
const CREATOR = ['972500000001@s.whatsapp.net', '900000000000001@lid'];
const OPTIONS = ['Option 1', 'Option 2', 'Option 3', 'Option 4'];

/** option-name → index by hash, the way the gateway resolves a decrypted vote */
function optionIndex(hashes: string[]): number[] {
  const byHash = new Map(OPTIONS.map((o, i) => [hashPollOption(o), i]));
  return hashes.map((h) => byHash.get(h) ?? -1);
}

const VOTE_A = {
  voters: ['972500000002@s.whatsapp.net', '900000000000002@lid'],
  encIv: Buffer.from('fsvLJRlOHqeLtU+I', 'base64'),
  encPayload: Buffer.from('v5sCY9rfapa4TMpkMdW2a/zxS+190TSkH6gxD6P3vtVrnmWtXu12QpkRBSkcpkb5fsw=', 'base64'),
  pollMsgId: POLL_ID,
};
const VOTE_B = {
  voters: ['972500000003@s.whatsapp.net', '900000000000003@lid'],
  encIv: Buffer.from('ybWfThTbn/Yug9tm', 'base64'),
  encPayload: Buffer.from('GB00r6Z97ar16dZcYqvLWTaNwPTuJg5bpPFdLOJgiiKyyDviK7G/d9fypn33NDGkaQQ=', 'base64'),
  pollMsgId: POLL_ID,
};

describe('decryptPollVote (encrypted poll-vote recovery)', () => {
  it('recovers vote A (option 4)', () => {
    const hashes = decryptPollVote(MESSAGE_SECRET, VOTE_A, [...CREATOR, ...VOTE_A.voters]);
    expect(hashes).not.toBeNull();
    expect(optionIndex(hashes!)).toEqual([3]); // 4th option, zero-based
  });

  it('recovers vote B (option 3)', () => {
    const hashes = decryptPollVote(MESSAGE_SECRET, VOTE_B, [...CREATOR, ...VOTE_B.voters]);
    expect(optionIndex(hashes!)).toEqual([2]);
  });

  it('finds the right combo among decoy candidates', () => {
    const hashes = decryptPollVote(MESSAGE_SECRET, VOTE_A, [
      '999999999@lid',
      ...CREATOR,
      '888888888@s.whatsapp.net',
      ...VOTE_A.voters,
    ]);
    expect(optionIndex(hashes!)).toEqual([3]);
  });

  it('returns null when no candidate decrypts (wrong key fails closed)', () => {
    expect(decryptPollVote(MESSAGE_SECRET, VOTE_A, ['999999999@lid'])).toBeNull();
  });

  it('returns null on a corrupted payload rather than throwing', () => {
    const bad = { ...VOTE_A, encPayload: Buffer.concat([VOTE_A.encPayload.subarray(0, -1), Buffer.from([0])]) };
    expect(decryptPollVote(MESSAGE_SECRET, bad, [...CREATOR, ...VOTE_A.voters])).toBeNull();
  });
});
