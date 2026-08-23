import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

describe('/api/send', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('sends one item and reports routing', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/send',
      payload: { recipient: '972521111111', item: { type: 'text', data: { text: 'hi' } } },
    });
    expect(res.json()).toMatchObject({ ok: true, routed: 'evo', skipped: false });
    expect(t.evo.calls[0]?.endpoint).toBe('/message/sendText/Test');
  });

  it('skips blacklisted recipients', async () => {
    t.blacklist.addMany([{ phone_number: '972521111111' }]);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/send',
      payload: { recipient: '972521111111', item: { type: 'text', data: { text: 'hi' } } },
    });
    expect(res.json()).toMatchObject({ ok: true, routed: 'skipped', skipped: true });
    expect(t.evo.calls).toHaveLength(0);
  });

  it('cannot bypass the blacklist by claiming the recipient is a group', async () => {
    t.blacklist.addMany([{ phone_number: '972521111111' }]);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/send',
      payload: {
        recipient: '972521111111',
        item: { type: 'text', data: { text: 'hi' } },
        isGroup: true, // client-controlled — must not disable enforcement
      },
    });
    expect(res.json()).toMatchObject({ ok: true, routed: 'skipped', skipped: true });
    expect(t.evo.calls).toHaveLength(0);
  });

  it('still sends to real group JIDs regardless of the blacklist', async () => {
    t.blacklist.addMany([{ phone_number: '972521111111' }]);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/send',
      payload: { recipient: '123-456@g.us', item: { type: 'text', data: { text: 'hi' } } },
    });
    expect(res.json()).toMatchObject({ ok: true, routed: 'evo' });
    expect(t.evo.calls).toHaveLength(1);
  });

  it('returns 502 when Evolution fails', async () => {
    t.evo.failuresLeft.set('972521111111', 99);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/send',
      payload: { recipient: '972521111111', item: { type: 'text', data: { text: 'hi' } } },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().ok).toBe(false);
  });
});

describe('chat gateway', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('GET /api/chats proxies findChats with the server-side instance', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/chats' });
    expect(res.statusCode).toBe(201); // FakeEvo's status, mirrored
    expect(t.evo.calls[0]).toMatchObject({ endpoint: '/chat/findChats/Test' });
  });

  it('GET /api/contacts proxies findContacts', async () => {
    await t.app.inject({ method: 'GET', url: '/api/contacts' });
    expect(t.evo.calls[0]).toMatchObject({ endpoint: '/chat/findContacts/Test' });
  });

  it('POST /api/messages/find requires remoteJid and shapes the query', async () => {
    const bad = await t.app.inject({ method: 'POST', url: '/api/messages/find', payload: {} });
    expect(bad.statusCode).toBe(400);

    await t.app.inject({
      method: 'POST',
      url: '/api/messages/find',
      payload: { remoteJid: '972521111111@s.whatsapp.net', page: 2 },
    });
    expect(t.evo.calls[0]).toMatchObject({
      endpoint: '/chat/findMessages/Test',
      body: { where: { key: { remoteJid: '972521111111@s.whatsapp.net' } }, page: 2 },
    });
  });

  it('POST /api/messages/find restores the original text of a deleted message from the cache', async () => {
    // the relay saw the content when it first arrived…
    t.relay.broadcast({
      event: 'messages.upsert',
      data: {
        instance: 'Test',
        data: { key: { remoteJid: '972500@s.whatsapp.net', fromMe: false, id: 'DEL1' }, message: { conversation: 'the secret' } },
      },
    });
    // …and Evolution now returns it content-nulled (delete-for-everyone)
    t.evo.thread = {
      records: [{ key: { id: 'DEL1', remoteJid: '972500@s.whatsapp.net' }, message: null, messageTimestamp: 1700000000 }],
      pages: 1,
    };
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/messages/find',
      payload: { remoteJid: '972500@s.whatsapp.net' },
    });
    const rec = res.json().messages.records[0];
    expect(rec.message).toBeNull(); // still flagged deleted (detection untouched)
    expect(rec.deletedOriginal).toEqual({ type: 'text', text: 'the secret', caption: '' });
  });

  it('POST /api/messages/find attaches prior versions of an edited message from the cache', async () => {
    // the relay saw the original, then the edit (in-place, new content)
    const upsert = (id: string, text: string) => ({
      event: 'messages.upsert',
      data: { instance: 'Test', data: { key: { remoteJid: '972500@s.whatsapp.net', fromMe: true, id }, message: { conversation: text } } },
    });
    t.relay.broadcast(upsert('ED1', 'first draft'));
    t.relay.broadcast(upsert('ED1', 'final text'));
    // Evolution now returns the edited record (current text + EDITED marker)
    t.evo.thread = {
      records: [
        {
          key: { id: 'ED1', remoteJid: '972500@s.whatsapp.net', fromMe: true },
          message: { conversation: 'final text' },
          messageTimestamp: 1700000000,
          MessageUpdate: [{ status: 'EDITED' }],
        },
      ],
      pages: 1,
    };
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/messages/find',
      payload: { remoteJid: '972500@s.whatsapp.net' },
    });
    const rec = res.json().messages.records[0];
    // only the genuinely prior version is attached (current text is excluded)
    expect(rec.editHistory).toEqual([{ type: 'text', text: 'first draft', caption: '' }]);
  });

  it('POST /api/messages/find learns the lid↔phone alias from the thread history', async () => {
    const lid = '900000000000040@lid';
    const phone = '972500000070@s.whatsapp.net';
    // a LID-keyed thread whose older message still carries the phone alt link
    t.evo.thread = {
      records: [
        {
          key: { id: 'M1', remoteJid: lid, remoteJidAlt: phone, fromMe: false },
          message: { conversation: 'hi' },
          messageTimestamp: 1700000000,
        },
      ],
      pages: 1,
    };
    await t.app.inject({ method: 'POST', url: '/api/messages/find', payload: { remoteJid: lid } });
    // the alias is now served to the chat list via /api/chat-meta
    const meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
    expect(meta.aliases[lid]).toBe(phone);
  });

  it('decrypts an end-to-end-encrypted caption edit and shows it with history', async () => {
    // Synthetic vector (see secretedit.test.ts): an incoming image whose caption
    // was edited via the encrypted MESSAGE_EDIT path Evolution can't decrypt. The
    // original keeps its pre-edit caption + carries messageSecret; the edit is a
    // secretEncryptedMessage targeting it. We must recover the new caption.
    const jid = '900000000000030@lid';
    t.evo.thread = {
      records: [
        {
          key: { id: 'TESTMSG00000000000D4', remoteJid: jid, fromMe: false, remoteJidAlt: '972500000060@s.whatsapp.net' },
          messageTimestamp: 1781418442,
          message: {
            imageMessage: { caption: 'original caption text', mimetype: 'image/jpeg' },
            messageContextInfo: { messageSecret: '2bW23zUD4M0C7InsHTQe+QJbE62K4+f7QwLv5d4gdiQ=' },
          },
        },
        {
          key: { id: 'TESTMSG00000000000D5', remoteJid: jid, fromMe: false },
          messageTimestamp: 1781418453,
          message: {
            secretEncryptedMessage: {
              encIv: 'C8wfvNfTtDBEzzik',
              encPayload: '4KwNPmGtJnJ6nahU7TfnRVE//iEMnImefafwjpLLnQwzpS4DRcrGZnTZATlhtv8=',
              secretEncType: 2,
              targetMessageKey: { id: 'TESTMSG00000000000D4', fromMe: true, remoteJid: '900000000000032@lid' },
            },
          },
        },
      ],
      pages: 1,
    };
    const res = await t.app.inject({ method: 'POST', url: '/api/messages/find', payload: { remoteJid: jid } });
    const img = res.json().messages.records.find((r: any) => r.key.id === 'TESTMSG00000000000D4');
    // current caption is the decrypted edit, and the pre-edit caption is kept as history
    expect(img.message.imageMessage.caption).toBe('updated caption text :)');
    expect(img.editHistory).toEqual([
      { type: 'image', text: '', caption: 'original caption text' },
    ]);
  });

  it('leaves a normal (undeleted) thread response untouched', async () => {
    t.evo.thread = { records: [{ key: { id: 'N1' }, message: { conversation: 'hi' } }], pages: 1 };
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/messages/find',
      payload: { remoteJid: 'x@s.whatsapp.net' },
    });
    expect(res.json().messages.records[0].deletedOriginal).toBeUndefined();
  });

  it('POST /api/media requires a message and forwards it for decryption', async () => {
    const bad = await t.app.inject({ method: 'POST', url: '/api/media', payload: {} });
    expect(bad.statusCode).toBe(400);

    await t.app.inject({
      method: 'POST',
      url: '/api/media',
      payload: { message: { key: { id: 'abc' } } },
    });
    expect(t.evo.calls[0]).toMatchObject({
      endpoint: '/chat/getBase64FromMediaMessage/Test',
      body: { message: { key: { id: 'abc' } }, convertToMp4: false },
    });
  });

  it('GET /api/groups proxies fetchAllGroups without participants', async () => {
    await t.app.inject({ method: 'GET', url: '/api/groups' });
    expect(t.evo.calls[0]).toMatchObject({
      endpoint: '/group/fetchAllGroups/Test?getParticipants=false',
      method: 'GET',
    });
  });

  it('POST /api/messages/edit shapes the updateMessage call', async () => {
    const bad = await t.app.inject({ method: 'POST', url: '/api/messages/edit', payload: {} });
    expect(bad.statusCode).toBe(400);

    await t.app.inject({
      method: 'POST',
      url: '/api/messages/edit',
      payload: { remoteJid: '972521111111@s.whatsapp.net', messageId: 'MSG1', text: 'fixed' },
    });
    expect(t.evo.calls[0]).toMatchObject({
      endpoint: '/chat/updateMessage/Test',
      body: {
        number: '972521111111',
        key: { id: 'MSG1', remoteJid: '972521111111@s.whatsapp.net', fromMe: true },
        text: 'fixed',
      },
    });
  });

  it('POST /api/messages/delete revokes via DELETE /chat/deleteMessageForEveryone (flat key body)', async () => {
    const bad = await t.app.inject({ method: 'POST', url: '/api/messages/delete', payload: {} });
    expect(bad.statusCode).toBe(400);

    await t.app.inject({
      method: 'POST',
      url: '/api/messages/delete',
      payload: { remoteJid: '972521111111@s.whatsapp.net', messageId: 'MSG1', fromMe: true },
    });
    expect(t.evo.calls[0]).toMatchObject({
      endpoint: '/chat/deleteMessageForEveryone/Test',
      method: 'DELETE',
      body: { id: 'MSG1', remoteJid: '972521111111@s.whatsapp.net', fromMe: true },
    });
  });

  it('forwards participant on a group delete', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/messages/delete',
      payload: { remoteJid: '123-456@g.us', messageId: 'MSG2', fromMe: true, participant: '972500@s.whatsapp.net' },
    });
    expect(t.evo.calls[0]?.body).toMatchObject({ participant: '972500@s.whatsapp.net' });
  });

  it('POST /api/chats/read forwards readMessages', async () => {
    const bad = await t.app.inject({ method: 'POST', url: '/api/chats/read', payload: {} });
    expect(bad.statusCode).toBe(400);

    const rm = [{ remoteJid: '972521111111@s.whatsapp.net', fromMe: false, id: 'M1' }];
    await t.app.inject({ method: 'POST', url: '/api/chats/read', payload: { readMessages: rm } });
    expect(t.evo.calls[0]).toMatchObject({
      endpoint: '/chat/markMessageAsRead/Test',
      body: { readMessages: rm },
    });
  });

  it('POST /api/chats/read with only a chat clears unread without an Evolution call', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/chats/read',
      payload: { chat: '972521111111@s.whatsapp.net' },
    });
    expect(res.statusCode).toBe(200);
    // list-level read carries no message ids, so it must NOT hit Evolution
    expect(t.evo.calls).toHaveLength(0);
  });

  it('POST /api/chats/unread forwards the markChatUnread shape', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/chats/unread',
      payload: { chat: '972521111111@s.whatsapp.net' },
    });
    expect(t.evo.calls[0]).toMatchObject({ endpoint: '/chat/markChatUnread/Test' });
  });

  it('POST /api/contacts/block validates status', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/contacts/block',
      payload: { number: '972521111111', status: 'nope' },
    });
    expect(bad.statusCode).toBe(400);

    await t.app.inject({
      method: 'POST',
      url: '/api/contacts/block',
      payload: { number: '972521111111', status: 'block' },
    });
    expect(t.evo.calls[0]).toMatchObject({
      endpoint: '/message/updateBlockStatus/Test',
      body: { number: '972521111111', status: 'block' },
    });
  });

  it('POST /api/presence forwards updatePresence (v1-proven endpoint) with a default delay', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/presence',
      payload: { number: '972521111111', presence: 'composing' },
    });
    expect(t.evo.calls[0]).toMatchObject({
      endpoint: '/chat/updatePresence/Test',
      body: { number: '972521111111', presence: 'composing', delay: 1200 },
    });
  });

  it('never exposes a generic tunnel', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/evo',
      payload: { endpoint: '/instance/delete/Test' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('API token auth', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp({ apiToken: 'secret' });
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('rejects API calls without the token', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(401);
  });

  it('accepts x-api-token and bearer forms', async () => {
    for (const headers of [{ 'x-api-token': 'secret' }, { authorization: 'Bearer secret' }]) {
      const res = await t.app.inject({ method: 'GET', url: '/api/jobs', headers });
      expect(res.statusCode).toBe(200);
    }
  });

  it('accepts ?token= only on /api/events (EventSource cannot set headers)', async () => {
    // query tokens leak into access logs, so every other route rejects them
    const viaQuery = await t.app.inject({ method: 'GET', url: '/api/jobs?token=secret' });
    expect(viaQuery.statusCode).toBe(401);

    // the SSE stream never ends, so probe it over a real socket
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = t.app.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=secret`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
  });

  it('leaves /api/health open for probing', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});
