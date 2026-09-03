import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import {
  AiAgentListener,
  AiAgentRunner,
  AiAgentStore,
  AiAuditLog,
  AiPendingSendStore,
  SESSION_CAP_REASON,
  type ThreadPage,
  type ThreadReader,
} from '../src/services/aiagent.js';
import { DAILY_CAP_RETRY_DELAY_SEC, MAX_HISTORY_MESSAGES } from '../src/services/aiLimits.js';
import type { AiProvider, AiTurn, CompleteArgs } from '../src/services/aiProviders.js';
import { AgentsStore } from '../src/services/agents.js';
import { ChatMetaStore } from '../src/services/chatmeta.js';
import { KnowledgeStore } from '../src/services/knowledge.js';
import { AiReplyQuota } from '../src/services/quota.js';
import type { Sender } from '../src/services/sender.js';
import { StudioDataStore } from '../src/services/studioData.js';
import { testConfig } from './helpers.js';

const JID = '972500000000@s.whatsapp.net';
const HOUR = 3_600_000;

const record = (id: string, ts: number, text: string | null, fromMe = false) => ({
  key: { id, remoteJid: JID, fromMe },
  messageTimestamp: ts,
  message: text == null ? { audioMessage: { seconds: 4 } } : { conversation: text },
});

interface Harness {
  db: Db;
  cfg: Config;
  store: AiAgentStore;
  pending: AiPendingSendStore;
  audit: AiAuditLog;
  chatMeta: ChatMetaStore;
  agents: AgentsStore;
  quota: AiReplyQuota;
  runner: AiAgentRunner;
  listener: AiAgentListener;
  events: Array<{ event: string; data: any }>;
  sends: Array<{ to: string; text: string }>;
  reader: ThreadReader & { calls: number; records: Array<Record<string, any>>; fail: boolean };
  provider: { calls: { complete: number; summarize: number }; seen: CompleteArgs[] };
  script: {
    reply: string;
    handoff: boolean;
    handoffReason?: string;
    memory: Record<string, unknown>;
    summary: string;
    onComplete?: () => void;
  };
  senderThrows: { value: boolean };
  senderSkips: { value: boolean };
}

function harness(over: Partial<Config> = {}): Harness {
  const db = openDb(':memory:');
  const cfg = testConfig({
    aiAgentEnabled: true,
    aiAgentInstances: ['Test'],
    aiAgentApiKey: 'test-ai-key',
    aiAgentReplyDelaySec: 0,
    aiAgentHandoffMessage: 'A team member will help.',
    ...over,
  });
  const chatMeta = new ChatMetaStore(db);
  const agents = new AgentsStore(db);
  const store = new AiAgentStore(db, (j) => chatMeta.canon(j));
  const pending = new AiPendingSendStore(db);
  const audit = new AiAuditLog(db);
  const quota = new AiReplyQuota(db, cfg);
  const knowledge = new KnowledgeStore(db);
  const studio = new StudioDataStore(db);
  const events: Array<{ event: string; data: any }> = [];
  const sends: Array<{ to: string; text: string }> = [];
  const senderThrows = { value: false };
  const senderSkips = { value: false };

  const reader = {
    calls: 0,
    records: [record('in-1', 1000, 'hi there')] as Array<Record<string, any>>,
    fail: false,
    async page(_i: string, _j: string, page: number): Promise<ThreadPage> {
      reader.calls++;
      if (reader.fail) throw new Error('findMessages 502: upstream down');
      const desc = [...reader.records].sort((a, b) => b.messageTimestamp - a.messageTimestamp);
      return { records: desc.slice((page - 1) * 50, page * 50), pages: Math.max(1, Math.ceil(desc.length / 50)) };
    },
  };

  const script: Harness['script'] = {
    reply: 'Classes start at 120 ILS.',
    handoff: false,
    memory: {},
    summary: 'Lead asked about prices.',
  };
  const providerCalls = { complete: 0, summarize: 0 };
  const seen: CompleteArgs[] = [];
  const provider: AiProvider = {
    name: 'anthropic',
    async complete(args) {
      providerCalls.complete++;
      seen.push(args);
      script.onComplete?.();
      return {
        toolCalls: [],
        final: {
          reply: script.reply,
          memoryUpdates: script.memory,
          handoff: script.handoff,
          handoffReason: script.handoffReason,
        },
        usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 100 },
        state: {},
      };
    },
    async summarize() {
      providerCalls.summarize++;
      return { summary: script.summary, usage: { inputTokens: 40, outputTokens: 20 } };
    },
  };

  const sender = {
    async sendOne(to: string, item: any) {
      if (senderThrows.value) throw new Error('evolution timed out');
      if (senderSkips.value) return { status: 'skipped', reason: 'blacklisted' };
      sends.push({ to, text: item.data.text });
      return { status: 'sent', messageId: `out-${sends.length}` };
    },
  } as unknown as Sender;

  const runner = new AiAgentRunner({
    cfg,
    store,
    pending,
    audit,
    chatMeta,
    agents,
    sender,
    quota,
    knowledge,
    studio,
    thread: reader,
    emit: (event, data) => events.push({ event, data }),
    providerFor: () => provider,
    log: () => {},
  });
  const listener = new AiAgentListener({
    cfg,
    store,
    chatMeta,
    pending,
    onImmediateHandoff: (jid, inst, reason) => runner.handoffNow(jid, inst, reason),
    emit: (event, data) => events.push({ event, data }),
    log: () => {},
  });

  return {
    db, cfg, store, pending, audit, chatMeta, agents, quota, runner, listener,
    events, sends, reader, provider: { calls: providerCalls, seen }, script,
    senderThrows, senderSkips,
  };
}

describe('AiAgentListener gating', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.db.close());

  it('ignores groups, own messages and status broadcasts', async () => {
    await h.listener.handle({ key: { remoteJid: '123@g.us', id: 'g1' }, message: { conversation: 'hi' } }, 'Test');
    await h.listener.handle({ key: { remoteJid: JID, id: 'o1', fromMe: true }, message: { conversation: 'hi' } }, 'Test');
    await h.listener.handle({ key: { remoteJid: 'status@broadcast', id: 's1' }, message: { conversation: 'hi' } }, 'Test');
    expect(h.pending.pendingForChat(JID)).toBeNull();
  });

  it('does nothing while the master switch is off (the default)', async () => {
    h.cfg.aiAgentEnabled = false;
    await h.listener.handle(record('in-1', 1000, 'hello'), 'Test');
    expect(h.pending.pendingForChat(JID)).toBeNull();
  });

  it('does nothing on a line that is not allow-listed', async () => {
    await h.listener.handle(record('in-1', 1000, 'hello'), 'SomeOtherLine');
    expect(h.pending.pendingForChat(JID)).toBeNull();
  });

  it('skips a chat a human owns, and a paused one', async () => {
    h.chatMeta.assign(JID, 'dana@example.com', 'dana@example.com');
    await h.listener.handle(record('in-1', 1000, 'hello'), 'Test');
    expect(h.pending.pendingForChat(JID)).toBeNull();

    h.chatMeta.assign(JID, null, '');
    h.store.setState(JID, 'PAUSED', 'human_takeover', 'dana@example.com');
    await h.listener.handle(record('in-2', 1001, 'hello again'), 'Test');
    expect(h.pending.pendingForChat(JID)).toBeNull();
  });

  it('marks a chat LIMIT_REACHED once the session cap is spent', async () => {
    h.cfg.aiAgentMaxRepliesPerSession = 2;
    h.store.bumpReplyCount(JID);
    h.store.bumpReplyCount(JID);
    await h.listener.handle(record('in-1', 1000, 'hello'), 'Test');
    expect(h.store.stateOf(JID).state).toBe('LIMIT_REACHED');
    expect(h.store.stateOf(JID).reason).toBe(SESSION_CAP_REASON);
    expect(h.pending.pendingForChat(JID)).toBeNull();
    expect(h.events.some((e) => e.event === 'AI_AGENT_STATE')).toBe(true);
  });

  it('bumps last_activity_at on gate acceptance, before any reply exists', async () => {
    expect(h.store.stateOf(JID).lastActivityAt).toBeNull();
    await h.listener.handle(record('in-1', 1000, 'hello'), 'Test');
    const st = h.store.stateOf(JID);
    expect(st.lastActivityAt).toBeTruthy();
    expect(st.replyCount).toBe(0); // nothing has been sent yet
    expect(h.sends).toHaveLength(0);
  });

  it('debounces: one pending row per chat, pushed forward each message', async () => {
    h.cfg.aiAgentReplyDelaySec = 30;
    await h.listener.handle(record('in-1', 1000, 'hi'), 'Test');
    const first = h.pending.pendingForChat(JID)!;
    await new Promise((r) => setTimeout(r, 5));
    await h.listener.handle(record('in-2', 1001, 'me again'), 'Test');
    const second = h.pending.pendingForChat(JID)!;
    expect(second.id).toBe(first.id); // still ONE row
    expect(second.dueAt > first.dueAt).toBe(true); // pushed forward
    expect(h.pending.recentForChat(JID)).toHaveLength(1);
  });

  it('unsupported media hands off immediately, skipping the debounce', async () => {
    await h.listener.handle(record('in-1', 1000, null), 'Test');
    expect(h.pending.pendingForChat(JID)).toBeNull();
    expect(h.store.stateOf(JID).state).toBe('HANDOFF_REQUESTED');
    expect(h.store.stateOf(JID).reason).toBe('unsupported_media');
    expect(h.sends).toEqual([{ to: '972500000000', text: 'A team member will help.' }]);
    // it is a real AI send: audited, attributed and charged to the daily cap
    expect(h.quota.spent()).toBe(1);
    const row = h.audit.recent(JID)[0]!;
    expect(row).toMatchObject({ handoff: true, handoffReason: 'unsupported_media', deliveryOutcome: 'sent' });
    expect(h.chatMeta.statuses()[JID]!.status).toBe('pending');
  });

  it('a blank handoff message sends nothing but still hands off', async () => {
    h.cfg.aiAgentHandoffMessage = '';
    await h.listener.handle(record('in-1', 1000, null), 'Test');
    expect(h.sends).toHaveLength(0);
    expect(h.store.stateOf(JID).state).toBe('HANDOFF_REQUESTED');
  });
});

describe('reply limits and recovery', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.db.close());

  it('the session gap clears LIMIT_REACHED before the eligibility check runs', async () => {
    h.cfg.aiAgentMaxRepliesPerSession = 1;
    h.cfg.aiAgentSessionGapHours = 48;
    h.store.touch(JID, new Date(Date.now() - 72 * HOUR));
    h.store.bumpReplyCount(JID);
    h.store.setState(JID, 'LIMIT_REACHED', SESSION_CAP_REASON, '');

    await h.listener.handle(record('in-9', 2000, 'still interested!'), 'Test');

    const st = h.store.stateOf(JID);
    expect(st.state).toBe('ACTIVE');
    expect(st.replyCount).toBe(0);
    // and the message was accepted in the SAME pass, not just unblocked for next time
    expect(h.pending.pendingForChat(JID)).not.toBeNull();
  });

  it('the session gap never auto-clears PAUSED or HANDOFF_REQUESTED', async () => {
    for (const state of ['PAUSED', 'HANDOFF_REQUESTED'] as const) {
      const g = harness();
      g.store.touch(JID, new Date(Date.now() - 500 * HOUR));
      g.store.bumpReplyCount(JID);
      g.store.setState(JID, state, 'deliberate', 'dana@example.com');
      await g.listener.handle(record('in-9', 2000, 'hello?'), 'Test');
      expect(g.store.stateOf(JID).state).toBe(state);
      expect(g.store.stateOf(JID).reason).toBe('deliberate');
      // counters do roll over — only the deliberate state is preserved
      expect(g.store.stateOf(JID).replyCount).toBe(0);
      expect(g.pending.pendingForChat(JID)).toBeNull();
      g.db.close();
    }
  });

  it('the daily cap re-queues the row and touches no chat state, then succeeds on its own', async () => {
    h.cfg.aiAgentDailyCap = 0;
    const row = h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    const now = new Date();
    await h.runner.tick(now);

    const blocked = h.pending.byId(row.id)!;
    expect(blocked.status).toBe('pending'); // NOT failed, NOT canceled
    expect(blocked.failureKind).toBe('daily_cap');
    expect(blocked.attemptCount).toBe(0); // never even claimed
    expect(Date.parse(blocked.dueAt) - now.getTime()).toBeGreaterThanOrEqual(
      DAILY_CAP_RETRY_DELAY_SEC * 1000 - 50,
    );
    // a GLOBAL cap is not a fact about this chat, so nothing here changed
    expect(h.store.stateOf(JID).state).toBe('ACTIVE');
    expect(h.store.stateOf(JID).updatedAt).toBe('');
    expect(h.sends).toHaveLength(0);

    // quota frees up (midnight, or the cap being raised) — the same row goes out
    h.cfg.aiAgentDailyCap = 200;
    await h.runner.tick(new Date(now.getTime() + (DAILY_CAP_RETRY_DELAY_SEC + 5) * 1000));
    expect(h.sends).toHaveLength(1);
    expect(h.pending.byId(row.id)!.status).toBe('sent');
  });

  it('a successful reply that spends the session cap marks the chat LIMIT_REACHED', async () => {
    h.cfg.aiAgentMaxRepliesPerSession = 1;
    h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    await h.runner.tick();
    expect(h.sends).toHaveLength(1);
    expect(h.store.stateOf(JID).state).toBe('LIMIT_REACHED');
    expect(h.store.stateOf(JID).reason).toBe(SESSION_CAP_REASON);
  });
});

describe('summary refresh', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.db.close());

  it('refreshes over its OWN window, separate from the 6-message reply context', async () => {
    h.reader.records = Array.from({ length: 15 }, (_, i) => record(`m${i}`, 1000 + i, `msg ${i}`));
    h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    await h.runner.tick();

    expect(h.provider.calls.summarize).toBe(1);
    const st = h.store.stateOf(JID);
    expect(st.summary).toBe('Lead asked about prices.');
    expect(st.summaryThroughMessageId).toBe('m14'); // the cursor advanced
    // the reply context stayed bounded, and got the fresh summary
    const args = h.provider.seen[0]!;
    expect(args.history).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(args.summary).toBe('Lead asked about prices.');
    // the summary window and the reply window were SEPARATE reads
    expect(h.reader.calls).toBeGreaterThanOrEqual(2);
  });

  it('does not refresh below the threshold, and leaves the cursor alone', async () => {
    h.reader.records = Array.from({ length: 4 }, (_, i) => record(`m${i}`, 1000 + i, `msg ${i}`));
    h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    await h.runner.tick();
    expect(h.provider.calls.summarize).toBe(0);
    expect(h.store.stateOf(JID).summaryThroughMessageId).toBeNull();
    expect(h.sends).toHaveLength(1);
  });

  it('answers anyway when the summary refresh itself fails', async () => {
    h.reader.records = Array.from({ length: 15 }, (_, i) => record(`m${i}`, 1000 + i, `msg ${i}`));
    h.script.summary = '';
    h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    await h.runner.tick();
    expect(h.sends).toHaveLength(1);
    expect(h.store.stateOf(JID).summaryThroughMessageId).toBeNull();
  });
});

describe('pending-send lifecycle', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.db.close());

  it('claims atomically — the second claim of a row loses', () => {
    const row = h.pending.upsertReply(JID, 'Test', new Date());
    expect(h.pending.claim(row.id)).toBe(true);
    expect(h.pending.claim(row.id)).toBe(false);
    expect(h.pending.byId(row.id)!.status).toBe('processing');
    expect(h.pending.byId(row.id)!.attemptCount).toBe(1);
  });

  it('sends exactly once even with overlapping ticks', async () => {
    h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    await Promise.all([h.runner.tick(), h.runner.tick()]);
    expect(h.sends).toHaveLength(1);
    expect(h.provider.calls.complete).toBe(1);
  });

  it('cancels with human_takeover when a human claims the chat mid-generation', async () => {
    const row = h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    h.script.onComplete = () => h.chatMeta.assign(JID, 'dana@example.com', 'dana@example.com');
    await h.runner.tick();
    const settled = h.pending.byId(row.id)!;
    expect(settled.status).toBe('canceled');
    expect(settled.failureKind).toBe('human_takeover');
    expect(h.sends).toHaveLength(0);
    // the turn still has a full audit row — generation happened, delivery did not
    expect(h.audit.recent(JID)[0]).toMatchObject({ deliveryOutcome: 'canceled_takeover' });
  });

  it('cancels with stale_context when a newer message arrives mid-generation', async () => {
    const row = h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    h.script.onComplete = () => {
      h.reader.records.push(record('in-later', 5000, 'actually, one more thing'));
    };
    await h.runner.tick();
    const settled = h.pending.byId(row.id)!;
    expect(settled.status).toBe('canceled');
    expect(settled.failureKind).toBe('stale_context');
    expect(h.sends).toHaveLength(0);
    expect(h.audit.recent(JID)[0]).toMatchObject({ deliveryOutcome: 'canceled_stale' });
  });

  it('retries a pre_send_error exactly once, then fails for visibility', async () => {
    const row = h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    h.reader.fail = true;
    await h.runner.tick();
    let r = h.pending.byId(row.id)!;
    expect(r.status).toBe('pending'); // one retry is provably safe — nothing was sent
    expect(r.failureKind).toBe('pre_send_error');
    expect(r.attemptCount).toBe(1);

    await h.runner.tick(new Date(Date.now() + 1000));
    r = h.pending.byId(row.id)!;
    expect(r.status).toBe('failed');
    expect(r.failureKind).toBe('pre_send_error');
    expect(r.attemptCount).toBe(2);
    expect(h.sends).toHaveLength(0);
  });

  it('never retries an ambiguous delivery', async () => {
    const row = h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    h.senderThrows.value = true;
    await h.runner.tick();
    const r = h.pending.byId(row.id)!;
    expect(r.status).toBe('failed');
    expect(r.failureKind).toBe('ambiguous_delivery');
    expect(h.audit.recent(JID)[0]).toMatchObject({ deliveryOutcome: 'failed' });

    // a later tick must not pick it up again
    h.senderThrows.value = false;
    await h.runner.tick(new Date(Date.now() + 600_000));
    expect(h.sends).toHaveLength(0);
  });

  it('settles a blacklisted/unreachable recipient without retrying', async () => {
    const row = h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    h.senderSkips.value = true;
    await h.runner.tick();
    expect(h.pending.byId(row.id)!.status).toBe('canceled');
    expect(h.pending.byId(row.id)!.failureKind).toBe('send_skipped');
  });

  it('fails a row orphaned by a restart, and never resends it', async () => {
    h.db
      .prepare(
        `INSERT INTO ai_agent_pending_sends (kind, chat_jid, instance, due_at, status, claimed_at, lease_until, created_at)
         VALUES ('reply', ?, 'Test', ?, 'processing', ?, ?, ?)`,
      )
      .run(
        JID,
        new Date(Date.now() - 600_000).toISOString(),
        new Date(Date.now() - 600_000).toISOString(),
        new Date(Date.now() - 300_000).toISOString(),
        new Date(Date.now() - 600_000).toISOString(),
      );
    await h.runner.tick();
    const r = h.pending.recentForChat(JID)[0]!;
    expect(r.status).toBe('failed');
    expect(r.failureKind).toBe('orphaned_restart');
    expect(h.sends).toHaveLength(0);
  });

  it('cleans up orphans even while the master switch is off', async () => {
    h.db
      .prepare(
        `INSERT INTO ai_agent_pending_sends (kind, chat_jid, instance, due_at, status, lease_until, created_at)
         VALUES ('reply', ?, 'Test', ?, 'processing', ?, ?)`,
      )
      .run(JID, new Date().toISOString(), new Date(Date.now() - 1000).toISOString(), new Date().toISOString());
    h.cfg.aiAgentEnabled = false;
    await h.runner.tick();
    expect(h.pending.recentForChat(JID)[0]!.failureKind).toBe('orphaned_restart');
  });

  it('leaves a reserved lead_opener row alone in V1', async () => {
    h.db
      .prepare(
        `INSERT INTO ai_agent_pending_sends (kind, chat_jid, instance, due_at, status, created_at)
         VALUES ('lead_opener', ?, 'Test', ?, 'pending', ?)`,
      )
      .run(JID, new Date(Date.now() - 1000).toISOString(), new Date().toISOString());
    await h.runner.tick();
    expect(h.pending.recentForChat(JID)[0]!.status).toBe('pending');
    expect(h.sends).toHaveLength(0);
  });
});

describe('audit log, two-phase', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.db.close());

  it('creates the row after generation and finalizes it after the send — in that order', async () => {
    const create = vi.spyOn(h.audit, 'create');
    const finalize = vi.spyOn(h.audit, 'finalize');
    h.script.memory = { name: 'Dana', age_group: 'child', nonsense: 1 };
    const row = h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    await h.runner.tick();

    expect(create).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(create.mock.invocationCallOrder[0]!).toBeLessThan(finalize.mock.invocationCallOrder[0]!);

    const audited = h.audit.recent(JID)[0]!;
    // phase 1: generation data
    expect(audited).toMatchObject({
      chatJid: JID,
      instance: 'Test',
      contactType: 'unknown',
      aiStateBefore: 'ACTIVE',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      responseText: 'Classes start at 120 ILS.',
      handoff: false,
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 100,
    });
    expect(audited.promptHash).toHaveLength(16);
    expect(audited.historyThroughMessageId).toBe('in-1');
    expect(audited.memoryUpdates).toEqual({ name: 'Dana', age_group: 'child' });
    // phase 2: delivery
    expect(audited.deliveryOutcome).toBe('sent');
    expect(audited.outgoingMessageId).toBe('out-1');
    // and the queue row points at it
    expect(h.pending.byId(row.id)!.auditLogId).toBe(audited.id);
  });

  it('stores the actual prompt text, not just its hash', async () => {
    h.cfg.aiAgentPersona = 'PERSONA-MARKER';
    h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    await h.runner.tick();
    const id = h.audit.recent(JID)[0]!.id;
    const snapshot = h.db
      .prepare(`SELECT prompt_snapshot FROM ai_agent_audit_log WHERE id = ?`)
      .get(id) as { prompt_snapshot: string };
    expect(snapshot.prompt_snapshot).toContain('PERSONA-MARKER');
    expect(snapshot.prompt_snapshot).toContain('Never fabricate studio information');
    // the api key is never anywhere near the prompt
    expect(snapshot.prompt_snapshot).not.toContain('test-ai-key');
  });

  it('never leaves a completed send un-finalized', async () => {
    h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    await h.runner.tick();
    const unfinished = h.db
      .prepare(`SELECT COUNT(*) AS n FROM ai_agent_audit_log WHERE delivery_outcome IS NULL`)
      .get() as { n: number };
    expect(unfinished.n).toBe(0);
  });

  it('a model-requested handoff sends the model reply, pends the chat and audits it', async () => {
    h.script.handoff = true;
    h.script.reply = 'Let me check with the team and come back to you.';
    h.script.handoffReason = 'wants to freeze a membership';
    h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    await h.runner.tick();

    expect(h.sends[0]!.text).toBe('Let me check with the team and come back to you.');
    expect(h.store.stateOf(JID).state).toBe('HANDOFF_REQUESTED');
    expect(h.store.stateOf(JID).reason).toBe('wants to freeze a membership');
    expect(h.chatMeta.statuses()[JID]!.status).toBe('pending');
    expect(h.quota.spent()).toBe(1); // a handoff message costs quota like any send
    expect(h.audit.recent(JID)[0]).toMatchObject({ handoff: true, deliveryOutcome: 'sent' });
  });

  it('falls back to the configured handoff message when the model wrote nothing', async () => {
    h.script.handoff = true;
    h.script.reply = '';
    h.script.handoffReason = 'account issue';
    h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    await h.runner.tick();
    expect(h.sends[0]!.text).toBe('A team member will help.');
  });

  it('attributes the send to the bot sender and merges the learned facts', async () => {
    h.script.memory = { name: 'Dana', trial_interest: true };
    h.pending.upsertReply(JID, 'Test', new Date(Date.now() - 1000));
    await h.runner.tick();
    const attribution = h.agents.forMessages(['out-1']);
    expect(attribution['out-1']!.email).toBe('ai-agent@webchat.local');
    expect(h.store.stateOf(JID).facts).toMatchObject({ name: 'Dana', trial_interest: true });
  });
});
