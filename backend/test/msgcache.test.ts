import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { EventRelay } from '../src/services/events.js';
import { attachMessageCache, extractCacheContent, MessageCacheStore } from '../src/services/msgcache.js';

describe('extractCacheContent', () => {
  it('pulls plain and extended text', () => {
    expect(extractCacheContent({ message: { conversation: 'hi' } })).toEqual({ type: 'text', text: 'hi', caption: '' });
    expect(extractCacheContent({ message: { extendedTextMessage: { text: 'yo' } } })).toEqual({
      type: 'text',
      text: 'yo',
      caption: '',
    });
  });

  it('pulls media type plus caption (and a captionless photo still yields its type)', () => {
    expect(extractCacheContent({ message: { imageMessage: { caption: 'pic' } } })).toEqual({
      type: 'image',
      text: '',
      caption: 'pic',
    });
    expect(extractCacheContent({ message: { imageMessage: {} } })).toEqual({ type: 'image', text: '', caption: '' });
    expect(extractCacheContent({ message: { audioMessage: {} } })).toEqual({ type: 'audio', text: '', caption: '' });
  });

  it('returns null for deleted / control / contentless records (so a delete never gets cached)', () => {
    expect(extractCacheContent({ message: null })).toBeNull(); // delete-for-everyone nulls the content
    expect(extractCacheContent({ message: { reactionMessage: { text: '❤️' } } })).toBeNull();
    expect(extractCacheContent({ message: { protocolMessage: { type: 0 } } })).toBeNull(); // revoke (no editedMessage)
    expect(extractCacheContent({ message: {} })).toBeNull();
    expect(extractCacheContent({})).toBeNull();
    expect(extractCacheContent(null)).toBeNull();
  });

  it('unwraps an edit delivered as protocolMessage.editedMessage (the real live shape)', () => {
    expect(
      extractCacheContent({
        message: { protocolMessage: { key: { id: 'M1' }, editedMessage: { conversation: 'new text' } } },
      }),
    ).toEqual({ type: 'text', text: 'new text', caption: '' });
    // edited media: caption lives under the unwrapped sub-message
    expect(
      extractCacheContent({
        message: { protocolMessage: { key: { id: 'M1' }, editedMessage: { imageMessage: { caption: 'new cap' } } } },
      }),
    ).toEqual({ type: 'image', text: '', caption: 'new cap' });
  });
});

describe('MessageCacheStore', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('stores and reads back the original content', () => {
    const s = new MessageCacheStore(db);
    s.record({ id: 'M1', chatJid: 'c@x', content: { type: 'text', text: 'hello', caption: '' } });
    expect(s.originalFor('M1')).toEqual({ type: 'text', text: 'hello', caption: '' });
    expect(s.originalFor('missing')).toBeNull();
    expect(s.originalFor('')).toBeNull();
  });

  it('keeps the latest content and pushes the superseded copy into history', () => {
    const s = new MessageCacheStore(db);
    s.record({ id: 'M1', content: { type: 'text', text: 'first', caption: '' } });
    s.record({ id: 'M1', content: { type: 'text', text: 'edited', caption: '' } });
    s.record({ id: 'M1', content: { type: 'text', text: 'edited again', caption: '' } });
    expect(s.originalFor('M1')?.text).toBe('edited again');
    // versionsFor is oldest → newest: every superseded copy plus the current one
    expect(s.versionsFor('M1').map((v) => v.text)).toEqual(['first', 'edited', 'edited again']);
  });

  it('appends no history when the same content is re-delivered (socket replay)', () => {
    const s = new MessageCacheStore(db);
    s.record({ id: 'M1', content: { type: 'text', text: 'hi', caption: '' } });
    s.record({ id: 'M1', content: { type: 'text', text: 'hi', caption: '' } });
    expect(s.versionsFor('M1').map((v) => v.text)).toEqual(['hi']);
  });

  it('versionsFor is empty for a message never seen', () => {
    expect(new MessageCacheStore(db).versionsFor('nope')).toEqual([]);
  });
});

describe('attachMessageCache', () => {
  let db: Db;
  let relay: EventRelay;
  let store: MessageCacheStore;
  beforeEach(() => {
    db = openDb(':memory:');
    relay = new EventRelay({ base: '', instance: '', apikey: '', enabled: false });
    store = new MessageCacheStore(db);
    attachMessageCache(relay, store);
  });
  afterEach(() => {
    db.close();
  });

  const upsert = (id: string, message: unknown) => ({
    event: 'messages.upsert',
    data: { event: 'messages.upsert', instance: 'Test', data: { key: { remoteJid: 'c@x', fromMe: false, id }, message } },
  });

  it('captures content from a live upsert', () => {
    relay.broadcast(upsert('M1', { conversation: 'live text' }));
    expect(store.originalFor('M1')).toEqual({ type: 'text', text: 'live text', caption: '' });
  });

  it('a later delete (nulled content) never clobbers the captured original', () => {
    relay.broadcast(upsert('M1', { conversation: 'before delete' }));
    relay.broadcast(upsert('M1', null)); // delete-for-everyone nulls `message`
    expect(store.originalFor('M1')?.text).toBe('before delete');
  });

  it('captures an in-place edit arriving as messages.update and keeps the prior version', () => {
    relay.broadcast(upsert('M3', { conversation: 'before edit' }));
    relay.broadcast({
      event: 'messages.update',
      data: { instance: 'Test', data: { key: { remoteJid: 'c@x', id: 'M3' }, message: { conversation: 'after edit' } } },
    });
    expect(store.originalFor('M3')?.text).toBe('after edit');
    expect(store.versionsFor('M3').map((v) => v.text)).toEqual(['before edit', 'after edit']);
  });

  it('captures an edit arriving as a protocolMessage targeting the original id (real prod shape)', () => {
    // the edit record's own key.id differs from the edited message's id; the new
    // content + target id live under protocolMessage — record against the target
    relay.broadcast(upsert('M5', { conversation: 'first' }));
    relay.broadcast(
      upsert('EDIT-WRAPPER-1', {
        protocolMessage: { key: { id: 'M5' }, editedMessage: { conversation: 'second' } },
      }),
    );
    relay.broadcast(
      upsert('EDIT-WRAPPER-2', {
        protocolMessage: { key: { id: 'M5' }, editedMessage: { conversation: 'third' } },
      }),
    );
    expect(store.originalFor('M5')?.text).toBe('third');
    // multiple edits accumulate oldest → newest under the ORIGINAL id
    expect(store.versionsFor('M5').map((v) => v.text)).toEqual(['first', 'second', 'third']);
    // the wrapper ids must NOT become their own cache rows
    expect(store.originalFor('EDIT-WRAPPER-1')).toBeNull();
  });

  it('ignores id-less records and content-less status updates', () => {
    // a delivery/read ack carries no `message` — must not spawn a phantom version
    relay.broadcast(upsert('M4', { conversation: 'real' }));
    relay.broadcast({ event: 'messages.update', data: { instance: 'Test', data: { key: { id: 'M4' }, update: { status: 'READ' } } } });
    relay.broadcast(upsert('', { conversation: 'no id' }));
    expect(store.versionsFor('M4').map((v) => v.text)).toEqual(['real']);
  });
});
