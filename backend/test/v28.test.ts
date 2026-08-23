import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentPresence } from '../src/services/presence.js';
import { makeApp, type TestApp } from './helpers.js';

const ADMIN = { 'cf-access-authenticated-user-email': 'boss@gmail.com' };
const AGENT = { 'cf-access-authenticated-user-email': 'dana@gmail.com' };
const textItem = { type: 'text', data: { text: 'hi' } };

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((res) => setTimeout(res, 20));
  }
}

describe('v2.8 agent workbench', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  /** Enable agent identification and provision boss (admin) + dana (agent). */
  const enableWithTwoAgents = async () => {
    await t.app.inject({ method: 'PUT', url: '/api/settings', payload: { agentsEnabled: true } });
    await t.app.inject({ method: 'GET', url: '/api/me', headers: ADMIN }); // first = admin
    await t.app.inject({ method: 'GET', url: '/api/me', headers: AGENT });
  };

  const createJob = (headers: Record<string, string>, recipients: Array<{ id: string }>, extra: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers,
      payload: {
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        recipients,
        items: [textItem],
        ...extra,
      },
    });

  describe('per-agent permission overrides', () => {
    it('role defaults: admin has approval powers, agent does not', async () => {
      await enableWithTwoAgents();
      const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: AGENT })).json();
      expect(me.role).toBe('agent');
      expect(me.perms['jobs.sendWithoutApproval']).toBe(false);
      expect(me.perms['jobs.approve']).toBe(false);
      expect(me.perms['insights.viewOwn']).toBe(true);
    });

    it('PUT perms grants an agent a permission; only the diff is stored', async () => {
      await enableWithTwoAgents();
      const updated = (
        await t.app.inject({
          method: 'PUT',
          url: '/api/agents/dana%40gmail.com',
          headers: ADMIN,
          payload: { perms: { 'jobs.sendWithoutApproval': true, 'insights.viewOwn': true } },
        })
      ).json();
      // viewOwn matches the role default → not stored as an override
      expect(updated.perms).toEqual({ 'jobs.sendWithoutApproval': true });
      expect(updated.effectivePerms['jobs.sendWithoutApproval']).toBe(true);
    });

    it('a deny override can revoke an admin default', async () => {
      await enableWithTwoAgents();
      await t.app.inject({
        method: 'PUT',
        url: '/api/agents/dana%40gmail.com',
        headers: ADMIN,
        payload: { role: 'admin', perms: { 'jobs.approve': false } },
      });
      const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: AGENT })).json();
      expect(me.role).toBe('admin');
      expect(me.perms['jobs.approve']).toBe(false);
    });

    it('rejects unknown permission keys and non-boolean values', async () => {
      await enableWithTwoAgents();
      const bad = await t.app.inject({
        method: 'PUT',
        url: '/api/agents/dana%40gmail.com',
        headers: ADMIN,
        payload: { perms: { 'jobs.hack': true } },
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('job approval flow', () => {
    it('agent bulk job is held; single recipient passes; admin passes', async () => {
      await enableWithTwoAgents();
      const held = (await createJob(AGENT, [{ id: '972521111111' }, { id: '972522222222' }])).json();
      expect(held.status).toBe('pending_approval');
      const single = (await createJob(AGENT, [{ id: '972521111111' }])).json();
      expect(single.status).toBe('pending');
      const admin = (await createJob(ADMIN, [{ id: '972521111111' }, { id: '972522222222' }])).json();
      expect(admin.status).toBe('pending');
    });

    it('the bulk threshold is configurable', async () => {
      await enableWithTwoAgents();
      await t.app.inject({
        method: 'PUT', url: '/api/settings', headers: ADMIN, payload: { approvalThreshold: 2 },
      });
      const two = (await createJob(AGENT, [{ id: '972521111111' }, { id: '972522222222' }])).json();
      expect(two.status).toBe('pending');
      const three = (
        await createJob(AGENT, [{ id: '972521111111' }, { id: '972522222222' }, { id: '972523333333' }])
      ).json();
      expect(three.status).toBe('pending_approval');
    });

    it('the submitter cannot self-approve by re-saving with status pending', async () => {
      await enableWithTwoAgents();
      const held = (await createJob(AGENT, [{ id: '972521111111' }, { id: '972522222222' }])).json();
      const edited = (
        await createJob(AGENT, [{ id: '972521111111' }, { id: '972522222222' }], {
          id: held.id,
          status: 'pending',
        })
      ).json();
      expect(edited.status).toBe('pending_approval');
    });

    it('approve releases (bumping an overdue fire time); reject cancels with reason', async () => {
      await enableWithTwoAgents();
      const before = Date.now();
      const held = (
        await createJob(AGENT, [{ id: '972521111111' }, { id: '972522222222' }], {
          scheduledAt: new Date(before - 3_600_000).toISOString(),
        })
      ).json();
      expect(held.status).toBe('pending_approval');

      // a plain agent may not approve
      const forbidden = await t.app.inject({
        method: 'POST', url: `/api/jobs/${held.id}/approve`, headers: AGENT,
      });
      expect(forbidden.statusCode).toBe(403);

      const approved = (
        await t.app.inject({ method: 'POST', url: `/api/jobs/${held.id}/approve`, headers: ADMIN })
      ).json();
      // overdue scheduled_at was bumped so the overdue guard can't mark it missed
      expect(new Date(approved.scheduledAt).getTime()).toBeGreaterThanOrEqual(before);
      await waitFor(() => ['running', 'done'].includes(t.jobs.byId(held.id)?.status ?? ''));

      const held2 = (await createJob(AGENT, [{ id: '972521111111' }, { id: '972522222222' }])).json();
      const rejected = (
        await t.app.inject({
          method: 'POST',
          url: `/api/jobs/${held2.id}/reject`,
          headers: ADMIN,
          payload: { reason: 'wrong audience' },
        })
      ).json();
      expect(rejected.status).toBe('cancelled');
      expect(rejected.result).toContain('rejected by boss@gmail.com: wrong audience');
    });

    it('restore and rerun re-run the approval rule', async () => {
      await enableWithTwoAgents();
      const held = (await createJob(AGENT, [{ id: '972521111111' }, { id: '972522222222' }])).json();
      await t.app.inject({ method: 'POST', url: `/api/jobs/${held.id}/cancel`, headers: AGENT });
      const restored = (
        await t.app.inject({ method: 'POST', url: `/api/jobs/${held.id}/restore`, headers: AGENT })
      ).json();
      expect(restored.status).toBe('pending_approval');

      t.jobs.finish(held.id, 'done', 'test');
      const rerun = (
        await t.app.inject({ method: 'POST', url: `/api/jobs/${held.id}/rerun`, headers: AGENT })
      ).json();
      expect(rerun.status).toBe('pending_approval');
      const rerunByAdmin = (
        await t.app.inject({ method: 'POST', url: `/api/jobs/${held.id}/rerun`, headers: ADMIN })
      ).json();
      expect(rerunByAdmin.status).toBe('pending');
    });

    it('held jobs sit in the Scheduled scope and survive clears', async () => {
      await enableWithTwoAgents();
      const held = (
        await createJob(AGENT, [{ id: '972521111111' }, { id: '972522222222' }], { type: 'immediate' })
      ).json();
      const scheduled = (
        await t.app.inject({ method: 'GET', url: '/api/jobs?scope=scheduled' })
      ).json();
      expect(scheduled.jobs.map((j: { id: string }) => j.id)).toContain(held.id);
      const history = (await t.app.inject({ method: 'GET', url: '/api/jobs?scope=history' })).json();
      expect(history.jobs.map((j: { id: string }) => j.id)).not.toContain(held.id);

      await t.app.inject({ method: 'POST', url: '/api/jobs/clear-done', payload: {} });
      await t.app.inject({ method: 'POST', url: '/api/jobs/clear-done', payload: { scope: 'history' } });
      expect(t.jobs.byId(held.id)?.status).toBe('pending_approval');
    });

    it('while the agents toggle is OFF held jobs fire without a status rewrite', async () => {
      await enableWithTwoAgents();
      const held = (
        await createJob(AGENT, [{ id: '972521111111' }, { id: '972522222222' }], {
          scheduledAt: new Date(Date.now() - 1000).toISOString(),
        })
      ).json();
      await t.scheduler.tick();
      expect(t.jobs.byId(held.id)?.status).toBe('pending_approval'); // toggle on → stays held

      await t.app.inject({ method: 'PUT', url: '/api/settings', headers: ADMIN, payload: { agentsEnabled: false } });
      await t.scheduler.tick();
      expect(t.jobs.byId(held.id)?.status).toBe('done');
    });
  });

  describe('chat meta', () => {
    it('assignment round-trips, validates the agent, and broadcasts', async () => {
      await enableWithTwoAgents();
      const events: Array<{ event: string; data: any }> = [];
      t.relay.subscribe((e) => events.push(e as never));

      const bad = await t.app.inject({
        method: 'POST', url: '/api/chats/assign',
        payload: { jid: '972521111111@s.whatsapp.net', agentEmail: 'ghost@x.com' },
      });
      expect(bad.statusCode).toBe(400);

      await t.app.inject({
        method: 'POST', url: '/api/chats/assign', headers: AGENT,
        payload: { jid: '972521111111@s.whatsapp.net', agentEmail: 'dana@gmail.com' },
      });
      const meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
      expect(meta.assignments['972521111111@s.whatsapp.net'].agentEmail).toBe('dana@gmail.com');
      expect(events.some((e) => e.event === 'CHAT_ASSIGNED')).toBe(true);
    });

    it('deactivating an agent releases their chats', async () => {
      await enableWithTwoAgents();
      await t.app.inject({
        method: 'POST', url: '/api/chats/assign', headers: AGENT,
        payload: { jid: '972521111111@s.whatsapp.net', agentEmail: 'dana@gmail.com' },
      });
      await t.app.inject({
        method: 'PUT', url: '/api/agents/dana%40gmail.com', headers: ADMIN, payload: { active: false },
      });
      const meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
      expect(meta.assignments).toEqual({});
    });

    it('status overlay auto-reopens on inbound, skipping own sends and aliases', async () => {
      const phone = '972521111111@s.whatsapp.net';
      const lid = '12345@lid';
      await t.app.inject({ method: 'POST', url: '/api/chat-aliases', payload: { pairs: [[lid, phone]] } });
      await t.app.inject({ method: 'POST', url: '/api/chats/status', payload: { jid: phone, status: 'resolved' } });

      // own outbound message must NOT reopen
      t.relay.broadcast({ event: 'MESSAGES_UPSERT', data: { key: { remoteJid: phone, fromMe: true } } });
      let meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
      expect(meta.statuses[phone].status).toBe('resolved');

      // inbound under the ALIAS jid reopens the row stored under the phone jid
      t.relay.broadcast({ event: 'MESSAGES_UPSERT', data: { key: { remoteJid: lid, fromMe: false } } });
      meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
      expect(meta.statuses[phone].status).toBe('open');
    });

    it('tags round-trip and resolve audiences by tag', async () => {
      await t.app.inject({
        method: 'POST', url: '/api/chats/tags',
        payload: { jid: '972521111111@s.whatsapp.net', tags: ['VIP', 'lead', 'VIP', ''] },
      });
      const meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
      expect(meta.tags['972521111111@s.whatsapp.net']).toEqual(['lead', 'VIP']);
      expect(meta.allTags).toEqual(['lead', 'VIP']);
      const byTag = (await t.app.inject({ method: 'GET', url: '/api/chats/by-tag?tag=VIP' })).json();
      expect(byTag.jids).toEqual(['972521111111@s.whatsapp.net']);
    });

    it('notes: own-delete only, admins may delete any', async () => {
      await enableWithTwoAgents();
      const jid = '972521111111@s.whatsapp.net';
      const note = (
        await t.app.inject({ method: 'POST', url: '/api/chats/notes', headers: AGENT, payload: { jid, body: 'waiting on refund' } })
      ).json();
      expect(note.agentEmail).toBe('dana@gmail.com');

      const otherAgent = { 'cf-access-authenticated-user-email': 'yossi@gmail.com' };
      await t.app.inject({ method: 'GET', url: '/api/me', headers: otherAgent });
      const denied = await t.app.inject({ method: 'DELETE', url: `/api/chats/notes/${note.id}`, headers: otherAgent });
      expect(denied.statusCode).toBe(403);
      const ok = await t.app.inject({ method: 'DELETE', url: `/api/chats/notes/${note.id}`, headers: ADMIN });
      expect(ok.statusCode).toBe(200);
      expect((await t.app.inject({ method: 'GET', url: `/api/chats/notes?jid=${encodeURIComponent(jid)}` })).json()).toEqual([]);
    });
  });

  describe('agent presence', () => {
    it('aggregates per agent+chat and expires stale tabs', () => {
      const p = new AgentPresence();
      p.beat('dana@gmail.com', 'tab1', 'chat-a', false);
      p.beat('dana@gmail.com', 'tab2', 'chat-a', true);
      const snap = p.snapshot();
      expect(snap).toEqual([{ email: 'dana@gmail.com', chatJid: 'chat-a', typing: true }]);
      expect(p.snapshot(Date.now() + 60_000)).toEqual([]);
    });

    it('heartbeat broadcasts AGENT_PRESENCE while agents are enabled', async () => {
      await enableWithTwoAgents();
      const events: Array<{ event: string; data: any }> = [];
      t.relay.subscribe((e) => events.push(e as never));
      await t.app.inject({
        method: 'POST', url: '/api/agent-presence', headers: AGENT,
        payload: { tabId: 'tab1', chatJid: '972521111111@s.whatsapp.net', typing: false },
      });
      const e = events.find((x) => x.event === 'AGENT_PRESENCE');
      expect(e?.data.agents).toEqual([
        { email: 'dana@gmail.com', chatJid: '972521111111@s.whatsapp.net', typing: false },
      ]);
    });
  });

  describe('personal quick replies', () => {
    it('personal replies are visible to their owner only; shared to everyone', async () => {
      await enableWithTwoAgents();
      await t.app.inject({ method: 'POST', url: '/api/quick-replies', headers: AGENT, payload: { shortcut: 'mine', text: 'personal', personal: true } });
      await t.app.inject({ method: 'POST', url: '/api/quick-replies', headers: AGENT, payload: { shortcut: 'team', text: 'shared' } });

      const mine = (await t.app.inject({ method: 'GET', url: '/api/quick-replies', headers: AGENT })).json();
      expect(mine.map((r: { shortcut: string }) => r.shortcut).sort()).toEqual(['mine', 'team']);
      const boss = (await t.app.inject({ method: 'GET', url: '/api/quick-replies', headers: ADMIN })).json();
      expect(boss.map((r: { shortcut: string }) => r.shortcut)).toEqual(['team']);
    });

    it('scope=all lets an admin see every instance and every owner; agents stay scoped', async () => {
      await enableWithTwoAgents();
      // dana's personal reply on the default line, a shared reply on another line
      await t.app.inject({ method: 'POST', url: '/api/quick-replies', headers: AGENT, payload: { shortcut: 'mine', text: 'personal', personal: true } });
      await t.app.inject({ method: 'POST', url: '/api/quick-replies?instance=Second', headers: ADMIN, payload: { shortcut: 'sec', text: 'second line' } });

      const all = (await t.app.inject({ method: 'GET', url: '/api/quick-replies?scope=all', headers: ADMIN })).json();
      expect(all.map((r: { shortcut: string }) => r.shortcut).sort()).toEqual(['mine', 'sec']);

      // a plain agent asking for scope=all is silently scoped to their own roster
      const agentAll = (await t.app.inject({ method: 'GET', url: '/api/quick-replies?scope=all', headers: AGENT })).json();
      expect(agentAll.map((r: { shortcut: string }) => r.shortcut)).toEqual(['mine']);
    });

    it('only the owner (or an admin) edits a personal reply', async () => {
      await enableWithTwoAgents();
      const r = (
        await t.app.inject({ method: 'POST', url: '/api/quick-replies', headers: AGENT, payload: { text: 'personal', personal: true } })
      ).json();
      const otherAgent = { 'cf-access-authenticated-user-email': 'yossi@gmail.com' };
      await t.app.inject({ method: 'GET', url: '/api/me', headers: otherAgent });
      expect((await t.app.inject({ method: 'PUT', url: `/api/quick-replies/${r.id}`, headers: otherAgent, payload: { text: 'hijack' } })).statusCode).toBe(403);
      expect((await t.app.inject({ method: 'PUT', url: `/api/quick-replies/${r.id}`, headers: AGENT, payload: { text: 'mine' } })).statusCode).toBe(200);
      expect((await t.app.inject({ method: 'DELETE', url: `/api/quick-replies/${r.id}`, headers: ADMIN })).statusCode).toBe(200);
    });
  });

  describe('{{agent_name}} personalization', () => {
    it('substitutes the composing agent display name in job sends', async () => {
      await enableWithTwoAgents();
      await t.app.inject({ method: 'PUT', url: '/api/agents/dana%40gmail.com', headers: ADMIN, payload: { name: 'Dana' } });
      const job = (
        await createJob(AGENT, [{ id: '972521111111' }], {
          scheduledAt: new Date(Date.now() - 1000).toISOString(),
          items: [{ type: 'text', data: { text: 'Hi, {{agent_name|the team}} here' } }],
        })
      ).json();
      await waitFor(() => t.jobs.byId(job.id)?.status === 'done');
      const sentText = t.evo.calls.find((c) => c.body?.text)?.body.text;
      expect(sentText).toBe('Hi, Dana here');
    });
  });

  describe('reminders', () => {
    it('creates, fires over SSE on the scheduler poll, and dismisses', async () => {
      await enableWithTwoAgents();
      const events: Array<{ event: string; data: any }> = [];
      t.relay.subscribe((e) => events.push(e as never));

      const r = (
        await t.app.inject({
          method: 'POST', url: '/api/reminders', headers: AGENT,
          payload: { chatJid: '972521111111@s.whatsapp.net', dueAt: new Date(Date.now() - 1000).toISOString(), note: 'call back' },
        })
      ).json();
      expect(r.agentEmail).toBe('dana@gmail.com');

      await t.scheduler.tick();
      const fired = events.find((e) => e.event === 'REMINDER_DUE');
      expect(fired?.data).toMatchObject({ id: r.id, agentEmail: 'dana@gmail.com', note: 'call back' });
      await t.scheduler.tick();
      expect(events.filter((e) => e.event === 'REMINDER_DUE')).toHaveLength(1); // no double fire

      // owners see their own; another agent does not
      const list = (await t.app.inject({ method: 'GET', url: '/api/reminders', headers: AGENT })).json();
      expect(list).toHaveLength(1);
      const otherAgent = { 'cf-access-authenticated-user-email': 'yossi@gmail.com' };
      await t.app.inject({ method: 'GET', url: '/api/me', headers: otherAgent });
      expect((await t.app.inject({ method: 'GET', url: '/api/reminders', headers: otherAgent })).json()).toEqual([]);

      await t.app.inject({ method: 'POST', url: `/api/reminders/${r.id}/dismiss`, headers: AGENT });
      expect((await t.app.inject({ method: 'GET', url: '/api/reminders', headers: AGENT })).json()).toEqual([]);
    });
  });

  describe('per-agent insights + exports', () => {
    it('aggregates job and chat sends per agent; viewOwn agents see only themselves', async () => {
      await enableWithTwoAgents();
      // one chat-screen send by dana + one 1:1 job by boss
      await t.app.inject({ method: 'POST', url: '/api/send', headers: AGENT, payload: { recipient: '972521111111', item: textItem } });
      const job = (
        await createJob(ADMIN, [{ id: '972522222222' }], { scheduledAt: new Date(Date.now() - 1000).toISOString() })
      ).json();
      await waitFor(() => t.jobs.byId(job.id)?.status === 'done');

      const all = (await t.app.inject({ method: 'GET', url: '/api/analytics/agents', headers: ADMIN })).json();
      const byEmail = Object.fromEntries(all.agents.map((a: { email: string }) => [a.email, a]));
      expect(byEmail['dana@gmail.com']).toMatchObject({ chatSends: 1, chatsTouched: 1 });
      expect(byEmail['boss@gmail.com']).toMatchObject({ jobSent: 1 });

      const own = (await t.app.inject({ method: 'GET', url: '/api/analytics/agents', headers: AGENT })).json();
      expect(own.agents.map((a: { email: string }) => a.email)).toEqual(['dana@gmail.com']);

      // a denied agent gets 403
      await t.app.inject({
        method: 'PUT', url: '/api/agents/dana%40gmail.com', headers: ADMIN,
        payload: { perms: { 'insights.viewOwn': false } },
      });
      expect((await t.app.inject({ method: 'GET', url: '/api/analytics/agents', headers: AGENT })).statusCode).toBe(403);
    });

    it('serves the job ledger and the insights summary as CSV', async () => {
      await enableWithTwoAgents();
      const job = (
        await createJob(ADMIN, [{ id: '972521111111' }], { scheduledAt: new Date(Date.now() - 1000).toISOString() })
      ).json();
      await waitFor(() => t.jobs.byId(job.id)?.status === 'done');

      const ledger = await t.app.inject({ method: 'GET', url: `/api/jobs/${job.id}/ledger.csv` });
      expect(ledger.headers['content-type']).toContain('text/csv');
      expect(ledger.body).toContain('recipient,is_group,item_index,status');
      expect(ledger.body).toContain('972521111111');

      const summary = await t.app.inject({ method: 'GET', url: '/api/analytics/export.csv', headers: ADMIN });
      expect(summary.headers['content-type']).toContain('text/csv');
      expect(summary.body).toContain('day,sent,failed,skipped');
      // insights.view is admin-only
      expect((await t.app.inject({ method: 'GET', url: '/api/analytics/export.csv', headers: AGENT })).statusCode).toBe(403);
    });
  });
});
