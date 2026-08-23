import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

const JID = '123-456@g.us';
const ENC = encodeURIComponent(JID);

describe('group management routes', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('create validates and forwards', async () => {
    const bad = await t.app.inject({ method: 'POST', url: '/api/groups/create', payload: { subject: 'X' } });
    expect(bad.statusCode).toBe(400);

    await t.app.inject({
      method: 'POST',
      url: '/api/groups/create',
      payload: { subject: 'New Group', description: 'd', participants: ['972521111111'] },
    });
    expect(t.evo.calls[0]).toMatchObject({
      endpoint: '/group/create/Test',
      body: { subject: 'New Group', description: 'd', participants: ['972521111111'] },
    });
  });

  it('info and invite use query-param groupJid', async () => {
    await t.app.inject({ method: 'GET', url: `/api/groups/info?jid=${ENC}` });
    expect(t.evo.calls[0]).toMatchObject({
      endpoint: `/group/findGroupInfos/Test?groupJid=${ENC}`,
      method: 'GET',
    });

    await t.app.inject({ method: 'GET', url: `/api/groups/invite?jid=${ENC}` });
    expect(t.evo.calls[1]).toMatchObject({ endpoint: `/group/inviteCode/Test?groupJid=${ENC}`, method: 'GET' });

    await t.app.inject({ method: 'POST', url: '/api/groups/invite/revoke', payload: { jid: JID } });
    expect(t.evo.calls[2]).toMatchObject({ endpoint: `/group/revokeInviteCode/Test?groupJid=${ENC}` });
  });

  it('participants validates the action', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/groups/participants',
      payload: { jid: JID, action: 'explode', participants: ['972521111111'] },
    });
    expect(bad.statusCode).toBe(400);

    await t.app.inject({
      method: 'POST',
      url: '/api/groups/participants',
      payload: { jid: JID, action: 'promote', participants: ['972521111111'] },
    });
    expect(t.evo.calls[0]).toMatchObject({
      endpoint: `/group/updateParticipant/Test?groupJid=${ENC}`,
      body: { action: 'promote', participants: ['972521111111'] },
    });
  });

  it('subject/description/picture send groupJid in the body', async () => {
    await t.app.inject({ method: 'POST', url: '/api/groups/subject', payload: { jid: JID, subject: 'S' } });
    await t.app.inject({ method: 'POST', url: '/api/groups/description', payload: { jid: JID, description: 'D' } });
    await t.app.inject({ method: 'POST', url: '/api/groups/picture', payload: { jid: JID, image: 'https://x/i.jpg' } });
    expect(t.evo.calls.map((c) => [c.endpoint, c.body])).toEqual([
      ['/group/updateGroupSubject/Test', { groupJid: JID, subject: 'S' }],
      ['/group/updateGroupDescription/Test', { groupJid: JID, description: 'D' }],
      ['/group/updateGroupPicture/Test', { groupJid: JID, image: 'https://x/i.jpg' }],
    ]);
  });

  it('setting and ephemeral use query-param groupJid', async () => {
    await t.app.inject({ method: 'POST', url: '/api/groups/setting', payload: { jid: JID, action: 'announcement' } });
    await t.app.inject({ method: 'POST', url: '/api/groups/ephemeral', payload: { jid: JID, expiration: 86400 } });
    expect(t.evo.calls.map((c) => [c.endpoint, c.body])).toEqual([
      [`/group/setting/Test?groupJid=${ENC}`, { action: 'announcement' }],
      [`/group/toggleEphemeral/Test?groupJid=${ENC}`, { expiration: 86400 }],
    ]);
  });

  it('leave is a DELETE upstream', async () => {
    await t.app.inject({ method: 'POST', url: '/api/groups/leave', payload: { jid: JID } });
    expect(t.evo.calls[0]).toMatchObject({ endpoint: `/group/leaveGroup/Test?groupJid=${ENC}`, method: 'DELETE' });
  });
});

describe('profile routes', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('updates map to the /chat endpoints verified on Evolution v2.3.x', async () => {
    await t.app.inject({ method: 'PUT', url: '/api/profile/name', payload: { name: 'Studio' } });
    await t.app.inject({ method: 'PUT', url: '/api/profile/status', payload: { status: 'Hi' } });
    await t.app.inject({ method: 'PUT', url: '/api/profile/picture', payload: { picture: 'https://x/p.jpg' } });
    await t.app.inject({ method: 'DELETE', url: '/api/profile/picture' });
    expect(t.evo.calls.map((c) => [c.method, c.endpoint])).toEqual([
      ['POST', '/chat/updateProfileName/Test'],
      ['POST', '/chat/updateProfileStatus/Test'],
      ['POST', '/chat/updateProfilePicture/Test'],
      ['DELETE', '/chat/removeProfilePicture/Test'],
    ]);
  });

  it('privacy reads fetchPrivacySettings and writes require all six keys', async () => {
    await t.app.inject({ method: 'GET', url: '/api/profile/privacy' });
    expect(t.evo.calls[0]).toMatchObject({ endpoint: '/chat/fetchPrivacySettings/Test', method: 'GET' });

    const partial = await t.app.inject({
      method: 'PUT',
      url: '/api/profile/privacy',
      payload: { last: 'contacts' },
    });
    expect(partial.statusCode).toBe(400);
    expect(partial.json().error).toContain('missing privacy keys');

    const full = {
      readreceipts: 'all',
      profile: 'all',
      status: 'all',
      online: 'all',
      last: 'contacts',
      groupadd: 'contacts',
    };
    await t.app.inject({ method: 'PUT', url: '/api/profile/privacy', payload: { ...full, hacker: 'x' } });
    expect(t.evo.calls[1]).toMatchObject({
      endpoint: '/chat/updatePrivacySettings/Test',
      body: full,
    });
  });
});
