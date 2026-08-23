import { describe, expect, it } from 'vitest';
import { enrichMessages } from '../src/routes/gateway.js';

// Synthetic poll (id TESTPOLL0000000000B2): creator 900000000000010@lid. Most
// votes reach Evolution already decrypted (vote.selectedOptions holds the option
// NAMES); the freshest two arrived encrypted (empty selectedOptions). enrichMessages
// must tally both kinds onto the poll-creation record as `pollVotes`.
const cache = { originalFor: () => null, versionsFor: () => [] };
const jsonResponse = (records: unknown[]) => ({
  status: 200,
  ok: true,
  contentType: 'application/json',
  text: JSON.stringify({ messages: { records } }),
});

const POLL_ID = 'TESTPOLL0000000000B2';
const OPTS = [
  '1️⃣ א',
  '2️⃣ ב',
  'OPT3', // option index 2 — what the encrypted vector below selects
  'OPT4', // option index 3
];
const pollRecord = (options: string[], secret?: string) => ({
  key: { id: POLL_ID, remoteJid: 'g@g.us', fromMe: false, participant: '900000000000010@lid' },
  messageTimestamp: 1000,
  message: {
    ...(secret ? { messageContextInfo: { messageSecret: secret } } : {}),
    pollCreationMessageV3: { name: 'Q?', options: options.map((optionName) => ({ optionName })) },
  },
});
const plaintextVote = (voter: string, name: string, optionNames: string[], ts: number) => ({
  key: { id: `v-${voter}-${ts}`, remoteJid: 'g@g.us', fromMe: false, participant: voter },
  pushName: name,
  messageTimestamp: ts,
  message: {
    pollUpdateMessage: {
      pollCreationMessageKey: { id: POLL_ID },
      vote: { selectedOptions: optionNames },
    },
  },
});

const tallyOf = (out: { text: string }) =>
  JSON.parse(out.text).messages.records.find((r: any) => r.key.id === POLL_ID).pollVotes;

describe('enrichMessages — poll votes', () => {
  it('tallies plaintext votes onto the poll and drops nothing wrong', () => {
    const out = enrichMessages(
      jsonResponse([
        pollRecord(OPTS),
        plaintextVote('111@lid', 'Alice', [OPTS[2]!], 10),
        plaintextVote('222@lid', 'Bob', [OPTS[2]!], 11),
        plaintextVote('333@lid', 'Cara', [OPTS[3]!], 12),
      ]),
      cache,
    );
    const tally = tallyOf(out);
    expect(tally.total).toBe(3);
    expect(tally.options[2]).toEqual({
      name: OPTS[2],
      count: 2,
      voters: [{ name: 'Alice', number: '' }, { name: 'Bob', number: '' }],
    });
    expect(tally.options[3]).toEqual({ name: OPTS[3], count: 1, voters: [{ name: 'Cara', number: '' }] });
    expect(tally.options[0].count).toBe(0);
  });

  it('keeps only a voter’s LATEST vote when they revote', () => {
    const out = enrichMessages(
      jsonResponse([
        pollRecord(OPTS),
        plaintextVote('111@lid', 'Alice', [OPTS[2]!], 10), // earlier
        plaintextVote('111@lid', 'Alice', [OPTS[3]!], 20), // changed her mind
      ]),
      cache,
    );
    const tally = tallyOf(out);
    expect(tally.total).toBe(1);
    expect(tally.options[2].count).toBe(0);
    expect(tally.options[3]).toEqual({ name: OPTS[3], count: 1, voters: [{ name: 'Alice', number: '' }] });
  });

  it('decrypts an encrypted vote (empty selectedOptions) using the poll secret', () => {
    // the decrypted hash only matches the poll's own option names, so use them here
    const SYNTH_OPTS = ['Option 1', 'Option 2', 'Option 3', 'Option 4'];
    // synthetic vote vector (see pollvote.test.ts scheme) — selects option index 3 (the 4th option)
    const encVote = {
      key: {
        id: 'enc-vote2',
        remoteJid: 'g@g.us',
        fromMe: false,
        participant: '900000000000011@lid',
        participantAlt: '972500000031@s.whatsapp.net',
      },
      pushName: 'Voter2',
      messageTimestamp: 30,
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey: { id: POLL_ID },
          vote: {
            encIv: 'kUiSG9upQdQ8nHkZ',
            encPayload: '/KW0995IjLMG1Xf+IP4rqUDDgNUFtoLqBBFS6+UC7bJIBbQ59vlrsIkqjUfaHG72lNU=',
            selectedOptions: [],
          },
        },
      },
    };
    const out = enrichMessages(
      jsonResponse([pollRecord(SYNTH_OPTS, 'PkArbD0qU5zSiLZtaJ1LH9u2WeYExXll37aWhOQd2xI='), encVote]),
      cache,
    );
    const tally = tallyOf(out);
    expect(tally.total).toBe(1);
    expect(tally.options[3]).toEqual({
      name: SYNTH_OPTS[3],
      count: 1,
      voters: [{ name: 'Voter2', number: '972500000031' }],
    });
  });

  it('tallies off-page votes passed as extraVoteRecords without adding bubbles', () => {
    const onPage = jsonResponse([
      pollRecord(OPTS),
      plaintextVote('111@lid', 'Alice', [OPTS[2]!], 10), // only Alice's vote is on this page
    ]);
    const offPage = [
      // Bob and Cara voted on other pages
      {
        key: { id: 'v-bob', remoteJid: 'g@g.us', fromMe: false, participant: '222@lid' },
        pushName: 'Bob',
        messageTimestamp: 11,
        message: { pollUpdateMessage: { pollCreationMessageKey: { id: POLL_ID }, vote: { selectedOptions: [OPTS[2]] } } },
      },
      {
        key: { id: 'v-cara', remoteJid: 'g@g.us', fromMe: false, participant: '333@lid' },
        pushName: 'Cara',
        messageTimestamp: 12,
        message: { pollUpdateMessage: { pollCreationMessageKey: { id: POLL_ID }, vote: { selectedOptions: [OPTS[3]] } } },
      },
    ];
    const out = enrichMessages(onPage, cache, undefined, undefined, offPage);
    const data = JSON.parse(out.text);
    const tally = data.messages.records.find((r: any) => r.key.id === POLL_ID).pollVotes;
    expect(tally.total).toBe(3); // Alice (on page) + Bob + Cara (off page)
    expect(tally.options[2].voters.map((v: any) => v.name).sort()).toEqual(['Alice', 'Bob']);
    expect(tally.options[3].voters.map((v: any) => v.name)).toEqual(['Cara']);
    // off-page vote records must NOT be spliced into the page the client renders
    expect(data.messages.records.map((r: any) => r.key.id)).not.toContain('v-bob');
    expect(data.messages.records.length).toBe(2);
  });

  it('does not double-count a vote present both on the page and in extraVoteRecords', () => {
    const dup = (ts: number) => ({
      key: { id: 'v-dup', remoteJid: 'g@g.us', fromMe: false, participant: '111@lid' },
      pushName: 'Alice',
      messageTimestamp: ts,
      message: { pollUpdateMessage: { pollCreationMessageKey: { id: POLL_ID }, vote: { selectedOptions: [OPTS[2]] } } },
    });
    const out = enrichMessages(jsonResponse([pollRecord(OPTS), dup(10)]), cache, undefined, undefined, [dup(10)]);
    const tally = tallyOf(out);
    expect(tally.total).toBe(1);
    expect(tally.options[2]).toEqual({ name: OPTS[2], count: 1, voters: [{ name: 'Alice', number: '' }] });
  });

  it('collapses a 1:1 vote stored under both the voter and our own lid (multi-device) to one', () => {
    // A direct-chat poll lives under the recipient's PHONE jid; the recipient's
    // single vote is mirrored under TWO @lid jids with the SAME message id — one
    // fromMe (our own account) and one not (the voter). It must count ONCE, and
    // be attributed to the voter (the fromMe:false copy), not to us.
    const poll = {
      key: { id: POLL_ID, remoteJid: '972500000050@s.whatsapp.net', fromMe: true },
      messageTimestamp: 1000,
      message: { pollCreationMessageV3: { name: 'Q?', options: OPTS.map((optionName) => ({ optionName })) } },
    };
    const echoOurs = {
      key: { id: 'v-1to1', remoteJid: '900000000000051@lid', remoteJidAlt: '972500000052@s.whatsapp.net', fromMe: true },
      pushName: '',
      messageTimestamp: 30,
      message: { pollUpdateMessage: { pollCreationMessageKey: { id: POLL_ID }, vote: { selectedOptions: [OPTS[0]] } } },
    };
    const voterCopy = {
      key: { id: 'v-1to1', remoteJid: '900000000000053@lid', remoteJidAlt: '972500000050@s.whatsapp.net', fromMe: false },
      pushName: 'Dana',
      messageTimestamp: 30,
      message: { pollUpdateMessage: { pollCreationMessageKey: { id: POLL_ID }, vote: { selectedOptions: [OPTS[0]] } } },
    };
    const out = enrichMessages(jsonResponse([poll, echoOurs, voterCopy]), cache);
    const tally = tallyOf(out);
    expect(tally.total).toBe(1);
    expect(tally.options[0]).toEqual({
      name: OPTS[0],
      count: 1,
      voters: [{ name: 'Dana', number: '972500000050' }],
    });
  });

  it('leaves the response untouched when there are no polls', () => {
    const r = jsonResponse([{ key: { id: 'M1', remoteJid: 'c@x' }, message: { conversation: 'hi' } }]);
    expect(enrichMessages(r, cache)).toBe(r);
  });

  it('maps a plaintext vote whose option name the voter’s client trimmed', () => {
    const poll = {
      key: { id: 'P-trim', remoteJid: 'g@g.us', fromMe: false, participant: '9@lid' },
      messageTimestamp: 1000,
      message: {
        pollCreationMessageV3: { name: 'Q?', options: [{ optionName: 'A ' }, { optionName: 'B' }] },
      },
    };
    const vote = {
      key: { id: 'v-t', remoteJid: 'g@g.us', fromMe: false, participant: '111@lid' },
      pushName: 'Alice',
      messageTimestamp: 10,
      message: { pollUpdateMessage: { pollCreationMessageKey: { id: 'P-trim' }, vote: { selectedOptions: ['A'] } } },
    };
    const out = enrichMessages(jsonResponse([poll, vote]), cache);
    const tally = JSON.parse(out.text).messages.records[0].pollVotes;
    expect(tally.total).toBe(1);
    expect(tally.options[0].count).toBe(1);
  });

  it('decrypts an iOS vote on a fromMe poll: creator lid from the mirror copy, trimmed-name hash', () => {
    // Synthetic vectors reproducing BOTH halves of a real invisible-votes bug:
    // (1) the page carries only the fromMe:true poll copy, whose key has no
    // participant — the creator's @lid, without which the vote cannot be
    // decrypted, exists only on the off-page fromMe:false mirror copy; (2) the
    // option was authored "Yes!! " with a trailing space, and the iOS voter's
    // hash is of the TRIMMED name.
    const PID = 'TESTPOLL0000000000C3';
    const GROUP = '900000000000099-1635279645@g.us';
    const SECRET = 'Y1YgoOKfaAzoBMjryLTWY7709i97rMTTM4bZNrgKO8E=';
    const OPTIONS = [{ optionName: 'Yes!! ' }, { optionName: 'No' }];
    const pagePoll = {
      key: { id: PID, remoteJid: GROUP, fromMe: true },
      messageTimestamp: 1783835983,
      message: {
        messageContextInfo: { messageSecret: SECRET },
        pollCreationMessageV3: { name: 'Q?', options: OPTIONS },
      },
    };
    const mirrorPoll = {
      key: {
        id: PID,
        remoteJid: GROUP,
        fromMe: false,
        participant: '900000000000020@lid',
        participantAlt: '972500000040@s.whatsapp.net',
      },
      messageTimestamp: 1783835984,
      message: {
        messageContextInfo: { messageSecret: SECRET },
        pollCreationMessageV3: { name: 'Q?', options: OPTIONS },
      },
    };
    const voterVote = {
      key: {
        id: 'v-ios-trim',
        remoteJid: GROUP,
        fromMe: false,
        participant: '900000000000021@lid',
        participantAlt: '972500000041@s.whatsapp.net',
      },
      pushName: 'Voter3',
      messageTimestamp: 1783836190,
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey: { id: PID },
          vote: {
            encIv: 'rwELnH5NznZeZ/D3',
            encPayload: 'Fwt9fEtWn73c5+xsCMaFRUsSMHpnIkf09MEFHD++oP1E3iOcptSwpZW2A8gz3C/4UE4=',
            selectedOptions: [],
          },
        },
      },
    };
    // the mirror copy arrives off-page (fetchThreadPollVotes sweep), like prod
    const out = enrichMessages(jsonResponse([pagePoll, voterVote]), cache, undefined, undefined, [mirrorPoll]);
    const rendered = JSON.parse(out.text).messages.records;
    const tally = rendered.find((r: any) => r.key.id === PID).pollVotes;
    expect(tally.total).toBe(1);
    expect(tally.options[0]).toEqual({
      name: 'Yes!! ',
      count: 1,
      voters: [{ name: 'Voter3', number: '972500000041' }],
    });
    // the off-page mirror copy must not be spliced into the rendered page
    expect(rendered.length).toBe(2);

    // The path prod actually takes: Evolution's findMessages DEDUPES by key.id,
    // so the mirror copy is unreachable through the API — the creator's @lid
    // arrives via the group PARTICIPANTS list instead (pollCreatorJids).
    const out2 = enrichMessages(
      jsonResponse([pagePoll, voterVote]),
      cache,
      undefined,
      undefined,
      undefined,
      ['900000000000098@lid', '900000000000020@lid', '900000000000021@lid'],
    );
    const tally2 = JSON.parse(out2.text).messages.records.find((r: any) => r.key.id === PID).pollVotes;
    expect(tally2.total).toBe(1);
    expect(tally2.options[0].voters).toEqual([{ name: 'Voter3', number: '972500000041' }]);
  });
});
