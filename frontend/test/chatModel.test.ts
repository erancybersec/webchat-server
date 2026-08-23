import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  buildChatList,
  collapseReactions,
  displayConvNumber,
  extractMessages,
  parseMessage,
  resolveName,
  threadJids,
  tsNum,
  type ChatMsg,
} from '../src/lib/chatModel';

const SECS = 1_718_200_000; // 2024-06-12ish, epoch seconds
const MILLIS = SECS * 1000;

describe('tsNum', () => {
  it('coerces every Evolution timestamp shape to millis', () => {
    expect(tsNum(SECS)).toBe(MILLIS); // numeric seconds
    expect(tsNum(MILLIS)).toBe(MILLIS); // numeric millis
    expect(tsNum(String(SECS))).toBe(MILLIS); // numeric string (seconds)
    expect(tsNum(new Date(MILLIS).toISOString())).toBe(MILLIS); // ISO
    expect(tsNum({ low: SECS, high: 0, unsigned: true })).toBe(MILLIS); // protobuf Long
  });

  it('returns 0 for garbage instead of NaN', () => {
    for (const v of [null, undefined, 'garbage', NaN, {}, -5]) {
      expect(tsNum(v), String(v)).toBe(0);
    }
  });
});

describe('parseMessage timestamps (the v1 NaN-reshuffle bug)', () => {
  const record = (messageTimestamp: unknown) => ({
    key: { id: 'A1', remoteJid: '972521111111@s.whatsapp.net' },
    message: { conversation: 'hi' },
    messageTimestamp,
  });

  it('parses numeric, string, ISO and Long timestamps to the same seconds', () => {
    const expected = SECS;
    expect(parseMessage(record(SECS))!.timestamp).toBe(expected);
    expect(parseMessage(record(String(SECS)))!.timestamp).toBe(expected);
    expect(parseMessage(record(new Date(MILLIS).toISOString()))!.timestamp).toBe(expected);
    expect(parseMessage(record({ low: SECS, high: 0 }))!.timestamp).toBe(expected);
  });

  it('mixed timestamp shapes still sort deterministically (no NaN)', () => {
    const data = [
      { ...record(SECS + 20), key: { id: 'c', remoteJid: 'x@s.whatsapp.net' } },
      { ...record(String(SECS)), key: { id: 'a', remoteJid: 'x@s.whatsapp.net' } },
      { ...record(new Date((SECS + 10) * 1000).toISOString()), key: { id: 'b', remoteJid: 'x@s.whatsapp.net' } },
    ];
    expect(extractMessages(data).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('buildChatList dedup', () => {
  const chat = (id: string, extra: Record<string, unknown> = {}) => ({
    remoteJid: id,
    lastMsgTimestamp: SECS,
    ...extra,
  });

  it('pass 0 merges a chat with its remoteJidAlt twin', () => {
    const lid = '123456789@lid';
    const phone = '972521111111@s.whatsapp.net';
    const { convs, aliases } = buildChatList([
      chat(phone, { lastMsgTimestamp: SECS + 10, unreadCount: 1 }),
      chat(lid, {
        unreadCount: 2,
        lastMessage: { key: { remoteJidAlt: phone } },
      }),
    ]);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.unreadCount).toBe(3); // unread survives the merge
    const winner = convs[0]!.id;
    const loser = winner === phone ? lid : phone;
    expect(aliases.get(loser)).toBe(winner);
  });

  it('merging two unread-dot aliases keeps a single dot, not a summed count', () => {
    const lid = '900000000000090@lid';
    const phone = '972529876543@s.whatsapp.net';
    // both sides are flag-only (unreadDot, synthetic count 1) — like a chat the
    // server flags unread under both its phone jid and its @lid alias
    const { convs } = buildChatList([
      chat(phone, { unreadCount: 1, unreadDot: true }),
      chat(lid, { unreadCount: 1, unreadDot: true, lastMessage: { key: { remoteJidAlt: phone } } }),
    ]);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.unreadDot).toBe(true);
    expect(convs[0]!.unreadCount).toBe(1); // a dot, never "2"
  });

  it('a real count on one alias absorbs the dot flag on the other (shows a number)', () => {
    const lid = '900000000000090@lid';
    const phone = '972529876543@s.whatsapp.net';
    const { convs } = buildChatList([
      chat(phone, { unreadCount: 3 }), // real Evolution count
      chat(lid, { unreadCount: 1, unreadDot: true, lastMessage: { key: { remoteJidAlt: phone } } }),
    ]);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.unreadDot).toBe(false);
    expect(convs[0]!.unreadCount).toBe(3); // the synthetic 1 is dropped, not added
  });

  it('pass 0 never aliases a group, whatever remoteJidAlt claims', () => {
    const group = '123-456@g.us';
    const { convs } = buildChatList([
      chat(group),
      chat('999@lid', { lastMessage: { key: { remoteJidAlt: group } } }),
    ]);
    expect(convs).toHaveLength(2);
  });

  it('a lid-only chat recovers its number from the server alias map', () => {
    // WhatsApp LID-first: only the @lid chat row exists (no phone twin to dedup
    // against) and its last message dropped the remoteJidAlt link — so without
    // the server's learned alias the row would show the opaque LID digits.
    const lid = '900000000000091@lid';
    const phone = '972500000091@s.whatsapp.net';
    const { convs } = buildChatList(
      [chat(lid, { lastMessage: { key: {} } })],
      [],
      new Map(),
      { [lid]: phone },
    );
    expect(convs).toHaveLength(1);
    expect(convs[0]!.id).toBe(lid);
    expect(convs[0]!.name).toBe('+972500000091');
    expect(displayConvNumber(convs[0]!)).toBe('+972500000091'); // subtitle too
  });

  it('pass 3 merges a lid+phone duplicate the first passes miss, via the server alias', () => {
    // The screenshot bug: both rows exist, but the lid row's last message (a
    // reaction) carried no remoteJidAlt, the pics don't join, and the lid local
    // part doesn't match the phone's digits — passes 0/1/2 all miss. Only the
    // server-learned alias links them.
    const lid = '900000000000091@lid';
    const phone = '972500000092@s.whatsapp.net';
    const { convs, aliases } = buildChatList(
      [
        chat(phone, { pushName: 'Voter4', lastMsgTimestamp: SECS }),
        chat(lid, { lastMessage: { key: {} }, lastMsgTimestamp: SECS + 10 }),
      ],
      [],
      new Map(),
      { [lid]: phone },
    );
    expect(convs).toHaveLength(1);
    expect(convs[0]!.id).toBe(phone); // named phone row wins, not the recovered-number lid row
    expect(convs[0]!.name).toBe('Voter4');
    expect(aliases.get(lid)).toBe(phone); // and the thread fetches both jids
  });

  it('without a server alias, a lid-only chat still shows bare LID digits', () => {
    const lid = '900000000000091@lid';
    const { convs } = buildChatList([chat(lid, { lastMessage: { key: {} } })]);
    expect(convs[0]!.name).toBe('900000000000091');
  });

  it('the server alias never overrides a working remoteJidAlt link', () => {
    const lid = '111@lid';
    const realPhone = '972520000001@s.whatsapp.net';
    const stalePhone = '972529999999@s.whatsapp.net';
    const { convs } = buildChatList(
      [chat(lid, { lastMessage: { key: { remoteJidAlt: realPhone } } })],
      [],
      new Map(),
      { [lid]: stalePhone }, // ignored — the last message's own alt wins
    );
    expect(convs[0]!.name).toBe('+972520000001');
  });

  it('flattens alias chains so threadJids sees every member', () => {
    // A —(alt)→ B, and B + C share a numeric local part → chain A→B→C possible
    const a = '111222333@lid';
    const b = '972521111111@s.whatsapp.net';
    const c = '972521111111@lid';
    const { convs, aliases } = buildChatList([
      // B is newer than A so pass 0 makes B the primary (A→B)…
      chat(a, { lastMessage: { key: { remoteJidAlt: b } } }),
      chat(b, { lastMsgTimestamp: SECS + 10 }),
      // …then pass 2 prefers the named C over B (B→C): chain A→B→C
      chat(c, { lastMsgTimestamp: SECS + 99, pushName: 'Real Name' }),
    ]);
    expect(convs).toHaveLength(1);
    const root = convs[0]!.id;
    for (const alias of aliases.keys()) {
      expect(aliases.get(alias)).toBe(root); // no multi-hop chains left
    }
    expect(new Set(threadJids(root, aliases))).toEqual(new Set([a, b, c]));
  });
});

describe('group names', () => {
  it('never uses pushName for a group (it is the last sender, not the group)', () => {
    const { convs } = buildChatList([
      { remoteJid: '123-456@g.us', pushName: 'Dana', lastMsgTimestamp: SECS },
    ]);
    expect(convs[0]!.name).not.toBe('Dana');
  });

  it('authoritative subjects win, and chat-record name is the fallback', () => {
    const subjects = new Map([['123-456@g.us', 'Real Subject']]);
    const { convs } = buildChatList(
      [
        { remoteJid: '123-456@g.us', pushName: 'Dana', lastMsgTimestamp: SECS },
        { remoteJid: '789-012@g.us', name: 'Record Name', pushName: 'Dana', lastMsgTimestamp: SECS },
      ],
      [],
      subjects,
    );
    const byId = new Map(convs.map((c) => [c.id, c.name]));
    expect(byId.get('123-456@g.us')).toBe('Real Subject');
    expect(byId.get('789-012@g.us')).toBe('Record Name');
  });
});

describe('resolveName', () => {
  it('never renders lid digits as a phone number', () => {
    expect(resolveName('123456789@lid', new Map(), new Map())).toBe('123456789');
    expect(resolveName('972521111111@s.whatsapp.net', new Map(), new Map())).toBe('+972521111111');
  });

  it('follows aliases to the primary name', () => {
    const aliases = new Map([['123@lid', '972521111111@s.whatsapp.net']]);
    const names = new Map([['972521111111@s.whatsapp.net', 'Dana']]);
    expect(resolveName('123@lid', names, aliases)).toBe('Dana');
  });
});

describe('collapseReactions (WhatsApp one-per-sender semantics)', () => {
  let n = 0;
  // a reaction record: who reacted (senderJid / fromMe), the emoji, on target
  const reaction = (
    opts: {
      emoji: string;
      target: string;
      at: number;
      senderJid?: string;
      fromMe?: boolean;
      remoteJid?: string;
    },
  ): ChatMsg => ({
    id: `r${n++}`,
    remoteJid: opts.remoteJid ?? opts.senderJid ?? '972520000000@s.whatsapp.net',
    fromMe: !!opts.fromMe,
    timestamp: opts.at,
    type: 'reaction',
    text: opts.emoji,
    caption: '',
    mimetype: '',
    fileName: '',
    hasMedia: false,
    quoted: null,
    status: '',
    edited: false,
    pushName: '',
    senderJid: opts.senderJid ?? '',
    reactionTargetId: opts.target,
    editTargetId: '',
    editHistory: [],
    deletedBySender: false,
  });

  it('keeps only the latest reaction per sender, not one chip per event', () => {
    const out = collapseReactions([
      reaction({ emoji: '👍', target: 'M1', at: 100, senderJid: 'a@s.whatsapp.net' }),
      reaction({ emoji: '❤️', target: 'M1', at: 200, senderJid: 'a@s.whatsapp.net' }), // changed mind
    ]);
    expect(out.get('M1')).toEqual([
      { emoji: '❤️', fromMe: false, senderJid: 'a@s.whatsapp.net', pushName: '', at: 200 },
    ]);
  });

  it('an empty emoji removes the sender’s reaction entirely', () => {
    const out = collapseReactions([
      reaction({ emoji: '👍', target: 'M1', at: 100, senderJid: 'a@s.whatsapp.net' }),
      reaction({ emoji: '', target: 'M1', at: 200, senderJid: 'a@s.whatsapp.net' }), // removal
    ]);
    expect(out.has('M1')).toBe(false);
  });

  it('keeps distinct senders (and mine) on the same message', () => {
    const out = collapseReactions([
      reaction({ emoji: '👍', target: 'M1', at: 100, senderJid: 'a@s.whatsapp.net' }),
      reaction({ emoji: '👍', target: 'M1', at: 110, fromMe: true }),
    ]);
    expect(out.get('M1')).toHaveLength(2);
    expect(out.get('M1')!.some((r) => r.fromMe)).toBe(true);
  });

  it('latest wins regardless of arrival order', () => {
    const out = collapseReactions([
      reaction({ emoji: '❤️', target: 'M1', at: 200, senderJid: 'a@s.whatsapp.net' }),
      reaction({ emoji: '👍', target: 'M1', at: 100, senderJid: 'a@s.whatsapp.net' }), // older, arrives later
    ]);
    expect(out.get('M1')![0]!.emoji).toBe('❤️');
  });

  it('keeps distinct group participants apart (no collapse to the group jid)', () => {
    const group = '123-456@g.us';
    const out = collapseReactions([
      reaction({ emoji: '👍', target: 'M1', at: 100, remoteJid: group, senderJid: 'alice@s.whatsapp.net' }),
      reaction({ emoji: '❤️', target: 'M1', at: 110, remoteJid: group, senderJid: 'bob@s.whatsapp.net' }),
      reaction({ emoji: '😂', target: 'M1', at: 120, remoteJid: group, senderJid: 'alice@s.whatsapp.net' }), // alice changes
    ]);
    const live = out.get('M1')!;
    expect(live).toHaveLength(2); // alice + bob, not collapsed onto the group jid
    expect(live.map((r) => r.emoji).sort()).toEqual(['❤️', '😂']); // alice's latest + bob
  });
});

describe('parseMessage edits (Evolution delivers edits as protocolMessage rows)', () => {
  const editRecord = (origId: string, newText: string, id = 'e1') => ({
    key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: false, id },
    messageTimestamp: SECS,
    message: {
      protocolMessage: {
        key: { remoteJid: '972520000000@s.whatsapp.net', id: origId },
        type: 'MESSAGE_EDIT',
        editedMessage: { conversation: newText },
      },
    },
  });

  it('parses an edit into an "edit" record carrying the original id + new text', () => {
    const m = parseMessage(editRecord('M1', 'fixed text'))!;
    expect(m.type).toBe('edit');
    expect(m.editTargetId).toBe('M1');
    expect(m.text).toBe('fixed text');
  });

  it('parses a revoke into a "delete" record targeting the original', () => {
    const revoke = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: false, id: 'x' },
      messageTimestamp: SECS,
      message: { protocolMessage: { type: 'REVOKE', key: { id: 'M1' } } },
    };
    const m = parseMessage(revoke)!;
    expect(m.type).toBe('delete');
    expect(m.editTargetId).toBe('M1');
  });

  it('accepts the numeric REVOKE enum (type 0) too', () => {
    const revoke = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: false, id: 'x' },
      messageTimestamp: SECS,
      message: { protocolMessage: { type: 0, key: { id: 'M1' } } },
    };
    expect(parseMessage(revoke)!.type).toBe('delete');
  });

  it('still hides an unrelated protocolMessage (not an edit, not a revoke)', () => {
    const other = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: false, id: 'x' },
      messageTimestamp: SECS,
      message: { protocolMessage: { type: 'APP_STATE_SYNC_KEY_SHARE' } },
    };
    expect(parseMessage(other)).toBeNull();
  });

  it('maps the backend editHistory sidecar into ChatMsg.editHistory + flags edited', () => {
    // the REAL prod shape: Evolution overwrote the message in place (current
    // text + EDITED marker); the backend cache restores the prior versions.
    const rec = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: true, id: 'EH1' },
      messageTimestamp: SECS,
      message: { conversation: 'final text' },
      MessageUpdate: [{ status: 'EDITED' }],
      editHistory: [
        { type: 'text', text: 'first draft', caption: '' },
        { type: 'text', text: 'second draft', caption: '' },
      ],
    };
    const m = parseMessage(rec)!;
    expect(m.text).toBe('final text');
    expect(m.edited).toBe(true);
    expect(m.editHistory).toEqual(['first draft', 'second draft']);
  });
});

describe('parseMessage deletions (Evolution nulls the content; no DELETED status in this build)', () => {
  it('flags a delete from nulled content — the REAL prod shape (EDITED marker, no DELETED)', () => {
    // Captured verbatim from production: a delete-for-everyone nulls `message`
    // and the only status marker is the generic EDITED — there is NO 'DELETED'.
    const rec = {
      key: { remoteJid: '900000000000090@lid', fromMe: false, id: 'D0' },
      pushName: 'Eran',
      messageType: 'conversation',
      message: null,
      messageTimestamp: SECS,
      MessageUpdate: [{ status: 'EDITED' }, { status: 'SERVER_ACK' }],
    };
    const m = parseMessage(rec);
    expect(m).not.toBeNull();
    expect(m!.deletedBySender).toBe(true);
    expect(m!.edited).toBe(false); // the EDITED marker on a delete must NOT show "Edited"
    expect(m!.type).toBe('text'); // renders as a (content-less) bubble, not dropped
  });

  it('flags a deleted message and keeps the bubble even when content was nulled', () => {
    const rec = {
      key: { remoteJid: '120363386350987792@g.us', fromMe: false, id: 'D1' },
      messageTimestamp: SECS,
      messageType: 'documentMessage',
      message: null, // Evolution nulls the content on delete-for-everyone
      MessageUpdate: [{ status: 'DELETED' }],
    };
    const m = parseMessage(rec);
    expect(m).not.toBeNull();
    expect(m!.deletedBySender).toBe(true);
  });

  it('exposes the cached original (deletedOriginal sidecar from the backend) on a deleted bubble', () => {
    const rec = {
      key: { remoteJid: '900000000000090@lid', fromMe: false, id: 'D9' },
      pushName: 'Eran',
      message: null,
      messageTimestamp: SECS,
      MessageUpdate: [{ status: 'EDITED' }],
      deletedOriginal: { type: 'text', text: 'recovered original', caption: '' },
    };
    const m = parseMessage(rec)!;
    expect(m.deletedBySender).toBe(true);
    expect(m.deletedOriginalText).toBe('recovered original');
    expect(m.deletedOriginalType).toBe('text');
  });

  it('leaves the deletedOriginal fields empty when no sidecar is present', () => {
    const m = parseMessage({
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: false, id: 'D10' },
      messageTimestamp: SECS,
      message: { conversation: 'hi' },
    })!;
    expect(m.deletedOriginalText).toBe('');
    expect(m.deletedOriginalType).toBe('');
  });

  it('an in-place edit (content present + EDITED) is edited, NOT deleted', () => {
    const rec = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: false, id: 'E0' },
      messageTimestamp: SECS,
      message: { conversation: 'fixed text' },
      MessageUpdate: [{ status: 'READ' }, { status: 'EDITED' }],
    };
    const m = parseMessage(rec)!;
    expect(m.deletedBySender).toBe(false);
    expect(m.edited).toBe(true);
    expect(m.text).toBe('fixed text');
  });

  it('does NOT mistake an undecryptable E2E sub-payload (object content) for a delete', () => {
    // poll votes / edit control records arrive as secretEncryptedMessage — they
    // keep an OBJECT under `message`, so they stay dropped, never flagged deleted.
    const rec = {
      key: { remoteJid: '900000000000090@lid', fromMe: false, id: 'S0' },
      messageType: 'secretEncryptedMessage',
      message: { messageContextInfo: {}, secretEncryptedMessage: { encIv: 'x', encPayload: 'y' } },
      messageTimestamp: SECS,
      MessageUpdate: [],
    };
    expect(parseMessage(rec)).toBeNull();
  });

  it('drops a poll VOTE record (pollUpdateMessage) — it folds into the poll tally, no bubble', () => {
    const rec = {
      key: { remoteJid: 'g@g.us', fromMe: false, id: 'PV0', participant: '111@lid' },
      messageType: 'pollUpdateMessage',
      messageTimestamp: SECS,
      message: {
        pollUpdateMessage: { pollCreationMessageKey: { id: 'POLL1' }, vote: { selectedOptions: ['Yes'] } },
      },
    };
    expect(parseMessage(rec)).toBeNull();
  });

  it('carries the backend pollVotes tally onto a poll message', () => {
    const rec = {
      key: { remoteJid: 'g@g.us', fromMe: true, id: 'POLL1' },
      messageTimestamp: SECS,
      message: { pollCreationMessageV3: { name: 'Coming?', options: [{ optionName: 'Yes' }, { optionName: 'No' }] } },
      pollVotes: {
        total: 2,
        options: [
          { name: 'Yes', count: 2, voters: [{ name: 'A', number: '111' }, { name: 'B', number: '222' }] },
          { name: 'No', count: 0, voters: [] },
        ],
      },
    };
    const m = parseMessage(rec)!;
    expect(m.type).toBe('poll');
    expect(m.pollVotes).toEqual({
      total: 2,
      options: [
        { name: 'Yes', count: 2, voters: [{ name: 'A', number: '111' }, { name: 'B', number: '222' }] },
        { name: 'No', count: 0, voters: [] },
      ],
    });
  });

  it('leaves pollVotes undefined on a poll with no tally attached', () => {
    const rec = {
      key: { remoteJid: 'g@g.us', fromMe: true, id: 'POLL2' },
      messageTimestamp: SECS,
      message: { pollCreationMessageV3: { name: 'Q?', options: [{ optionName: 'a' }, { optionName: 'b' }] } },
    };
    expect(parseMessage(rec)!.pollVotes).toBeUndefined();
  });

  it('exposes poll options + single/multiple mode (so the bubble renders before any vote)', () => {
    const single = parseMessage({
      key: { remoteJid: 'g@g.us', fromMe: true, id: 'P1' },
      messageTimestamp: SECS,
      message: {
        pollCreationMessageV3: {
          name: 'Pick',
          selectableOptionsCount: 1,
          options: [{ optionName: 'A' }, { optionName: 'B' }],
        },
      },
    })!;
    expect(single.pollOptions).toEqual(['A', 'B']);
    expect(single.pollMultiple).toBe(false);

    const multi = parseMessage({
      key: { remoteJid: 'g@g.us', fromMe: true, id: 'P2' },
      messageTimestamp: SECS,
      message: {
        pollCreationMessage: {
          name: 'Pick many',
          selectableOptionsCount: 0,
          options: [{ optionName: 'X' }, { optionName: 'Y' }, { optionName: 'Z' }],
        },
      },
    })!;
    expect(multi.pollOptions).toEqual(['X', 'Y', 'Z']);
    expect(multi.pollMultiple).toBe(true);
  });

  it('keeps the original text when Evolution left the content in place', () => {
    const rec = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: false, id: 'D2' },
      messageTimestamp: SECS,
      message: { conversation: 'oops secret' },
      MessageUpdate: [{ status: 'READ' }, { status: 'DELETED' }],
    };
    const m = parseMessage(rec)!;
    expect(m.text).toBe('oops secret');
    expect(m.deletedBySender).toBe(true);
  });

  it('does not flag a normal (undeleted) message', () => {
    const rec = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: false, id: 'N1' },
      messageTimestamp: SECS,
      message: { conversation: 'hi' },
      MessageUpdate: [{ status: 'READ' }],
    };
    expect(parseMessage(rec)!.deletedBySender).toBe(false);
  });
});

describe('parseMessage read receipts (when the recipient saw an own message)', () => {
  it('captures the READ timestamp from the matching update entry', () => {
    const rec = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: true, id: 'RR1' },
      messageTimestamp: SECS,
      message: { conversation: 'hi there' },
      MessageUpdate: [
        { status: 'SERVER_ACK', dateTime: (SECS + 1) * 1000 },
        { status: 'DELIVERY_ACK', dateTime: (SECS + 2) * 1000 },
        { status: 'READ', dateTime: (SECS + 5) * 1000 },
      ],
    };
    const m = parseMessage(rec)!;
    expect(m.status).toBe('READ');
    expect(m.readAt).toBe(SECS + 5);
  });

  it('marks read-but-untimed as 0 (read receipt with no usable timestamp)', () => {
    const rec = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: true, id: 'RR2' },
      messageTimestamp: SECS,
      message: { conversation: 'hi' },
      MessageUpdate: [{ status: 'READ' }],
    };
    expect(parseMessage(rec)!.readAt).toBe(0);
  });

  it('leaves readAt undefined when the message is only delivered, not read', () => {
    const rec = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: true, id: 'RR3' },
      messageTimestamp: SECS,
      message: { conversation: 'hi' },
      MessageUpdate: [{ status: 'DELIVERY_ACK', dateTime: (SECS + 2) * 1000 }],
    };
    expect(parseMessage(rec)!.readAt).toBeUndefined();
  });

  it('falls back to the backend-attached readAt (ISO) when the update entry has no timestamp', () => {
    // the real prod shape: status history is bare {status} with no time, and the
    // findMessages proxy attaches readAt from its live-ack cache.
    const rec = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: true, id: 'RR5' },
      messageTimestamp: SECS,
      message: { conversation: 'hi' },
      MessageUpdate: [{ status: 'READ' }],
      readAt: new Date((SECS + 7) * 1000).toISOString(),
    };
    const m = parseMessage(rec)!;
    expect(m.status).toBe('READ');
    expect(m.readAt).toBe(SECS + 7);
  });

  it('prefers the update-entry timestamp over the backend readAt when both exist', () => {
    const rec = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: true, id: 'RR6' },
      messageTimestamp: SECS,
      message: { conversation: 'hi' },
      MessageUpdate: [{ status: 'READ', dateTime: (SECS + 5) * 1000 }],
      readAt: new Date((SECS + 99) * 1000).toISOString(),
    };
    expect(parseMessage(rec)!.readAt).toBe(SECS + 5);
  });

  it('uses the PLAYED timestamp for a voice note that was listened to', () => {
    const rec = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: true, id: 'RR4' },
      messageTimestamp: SECS,
      message: { audioMessage: { mimetype: 'audio/ogg' } },
      MessageUpdate: [{ status: 'PLAYED', dateTime: (SECS + 9) * 1000 }],
    };
    const m = parseMessage(rec)!;
    expect(m.status).toBe('PLAYED');
    expect(m.readAt).toBe(SECS + 9);
  });
});

describe('parseMessage quoted replies', () => {
  it('reads the quote from a record-level contextInfo (this Evolution build stores a text reply as plain conversation + sibling contextInfo)', () => {
    // Captured verbatim from the live StudioShimshi instance (Evolution v2.3.7):
    // a text reply comes back as messageType 'conversation' with the quote in a
    // RECORD-level contextInfo, NOT under message.extendedTextMessage.contextInfo.
    const rec = {
      key: { remoteJid: '972500000080@s.whatsapp.net', fromMe: true, id: 'Q1' },
      messageType: 'conversation',
      message: { conversation: 'my reply' },
      messageTimestamp: SECS,
      contextInfo: {
        stanzaId: 'TESTQUOTE000000000Q1',
        participant: '972500000080@s.whatsapp.net',
        quotedMessage: { conversation: 'the original' },
      },
    };
    const m = parseMessage(rec)!;
    expect(m.text).toBe('my reply');
    expect(m.quoted).not.toBeNull();
    expect(m.quoted!.id).toBe('TESTQUOTE000000000Q1');
    expect(m.quoted!.text).toBe('the original');
  });

  it('still reads the quote when contextInfo is nested under the content type', () => {
    const rec = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: false, id: 'Q2' },
      messageType: 'extendedTextMessage',
      message: {
        extendedTextMessage: {
          text: 'nested reply',
          contextInfo: { stanzaId: 'ORIG', quotedMessage: { conversation: 'orig text' } },
        },
      },
      messageTimestamp: SECS,
    };
    const m = parseMessage(rec)!;
    expect(m.text).toBe('nested reply');
    expect(m.quoted!.id).toBe('ORIG');
    expect(m.quoted!.text).toBe('orig text');
  });

  it('does not invent a quote from a record-level contextInfo that has no quotedMessage', () => {
    const rec = {
      key: { remoteJid: '972520000000@s.whatsapp.net', fromMe: true, id: 'Q3' },
      messageType: 'conversation',
      message: { conversation: 'plain, not a reply' },
      messageTimestamp: SECS,
      contextInfo: { ephemeralSettingTimestamp: { low: 1, high: 0 } },
    };
    expect(parseMessage(rec)!.quoted).toBeNull();
  });
});

describe('applyEdits (fold edits onto their targets)', () => {
  const msg = (id: string, text: string, over: Partial<ChatMsg> = {}): ChatMsg => ({
    id,
    remoteJid: '972520000000@s.whatsapp.net',
    fromMe: false,
    timestamp: SECS,
    type: 'text',
    text,
    caption: '',
    mimetype: '',
    fileName: '',
    hasMedia: false,
    quoted: null,
    status: '',
    edited: false,
    pushName: '',
    senderJid: '',
    reactionTargetId: '',
    editTargetId: '',
    editHistory: [],
    deletedBySender: false,
    ...over,
  });

  it('replaces the target text, marks it edited, and drops the edit record', () => {
    const out = applyEdits([
      msg('M1', 'old text'),
      msg('e1', 'new text', { type: 'edit', editTargetId: 'M1', timestamp: SECS + 10 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('M1');
    expect(out[0]!.text).toBe('new text');
    expect(out[0]!.edited).toBe(true);
    expect(out[0]!.editHistory).toEqual(['old text']); // the pre-edit original
  });

  it('applies the latest of multiple edits regardless of order, keeping prior versions', () => {
    const out = applyEdits([
      msg('e2', 'second', { type: 'edit', editTargetId: 'M1', timestamp: SECS + 20 }),
      msg('M1', 'first'),
      msg('e1', 'middle', { type: 'edit', editTargetId: 'M1', timestamp: SECS + 10 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('second');
    expect(out[0]!.editHistory).toEqual(['first', 'middle']); // original + superseded, current excluded
  });

  it('renders an orphan edit (target never stored) as its own read-only bubble', () => {
    const out = applyEdits([
      msg('e1', 'orphan edit', { type: 'edit', editTargetId: 'GONE', timestamp: SECS }),
    ]);
    expect(out).toHaveLength(1);
    const o = out[0]!;
    expect(o.id).toBe('e1');
    expect(o.type).toBe('text'); // rendered as a normal bubble, not a control record
    expect(o.text).toBe('orphan edit');
    expect(o.timestamp).toBe(SECS);
    expect(o.edited).toBe(true);
    expect(o.editHistory).toEqual([]);
    expect(o.editTargetId).toBe('GONE'); // kept so the renderer treats it read-only
    expect(o.fromMe).toBe(false); // forced incoming → no Edit action against a non-resendable id
  });

  it('orphan media-caption edit renders standalone with the new caption', () => {
    const out = applyEdits([
      msg('e1', '', { type: 'edit', editTargetId: 'GONE', caption: 'new caption', timestamp: SECS }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.caption).toBe('new caption');
    expect(out[0]!.edited).toBe(true);
  });

  it('drops a contentless orphan edit (nothing to show)', () => {
    const out = applyEdits([
      msg('e1', '', { type: 'edit', editTargetId: 'GONE', caption: '', timestamp: SECS }),
    ]);
    expect(out).toEqual([]);
  });

  it('orphan multi-edit keeps the latest text + prior versions as history', () => {
    const out = applyEdits([
      msg('e2', 'second', { type: 'edit', editTargetId: 'GONE', timestamp: SECS + 20 }),
      msg('e1', 'first', { type: 'edit', editTargetId: 'GONE', timestamp: SECS + 10 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('second');
    expect(out[0]!.editHistory).toEqual(['first']);
  });

  it('ignores an orphan delete (no target to flag)', () => {
    const out = applyEdits([
      msg('d1', '', { type: 'delete', editTargetId: 'GONE', timestamp: SECS }),
    ]);
    expect(out).toEqual([]);
  });

  it('flags a deleted message but keeps its content and drops the delete record', () => {
    const out = applyEdits([
      msg('M1', 'oops secret'),
      msg('d1', '', { type: 'delete', editTargetId: 'M1', timestamp: SECS + 10 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('M1');
    expect(out[0]!.text).toBe('oops secret'); // content preserved
    expect(out[0]!.deletedBySender).toBe(true);
  });

  it('handles an edited-then-deleted message (shows latest text, flagged deleted)', () => {
    const out = applyEdits([
      msg('M1', 'first'),
      msg('e1', 'second', { type: 'edit', editTargetId: 'M1', timestamp: SECS + 10 }),
      msg('d1', '', { type: 'delete', editTargetId: 'M1', timestamp: SECS + 20 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('second');
    expect(out[0]!.edited).toBe(true);
    expect(out[0]!.deletedBySender).toBe(true);
    expect(out[0]!.editHistory).toEqual(['first']);
  });
});
