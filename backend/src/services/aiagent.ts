import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import {
  DAILY_CAP_RETRY_DELAY_SEC,
  EMPTY_LEAD_CONTEXT,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_KNOWLEDGE_CHARS_PER_RESULT,
  MAX_KNOWLEDGE_RESULTS,
  MAX_QUERY_CHARS,
  MAX_SEND_ATTEMPTS,
  MAX_SUMMARY_CHARS,
  PENDING_LEASE_MS,
  SUMMARY_LOOKBACK_CAP,
  SUMMARY_REFRESH_EVERY,
  parseLeadContext,
  sanitizeLeadContext,
  type LeadContext,
} from './aiLimits.js';
import {
  AiAgentEngine,
  buildSystemPrompt,
  providerFor,
  resolveModel,
  resolveSummaryModel,
  type AiProvider,
  type AiTurn,
  type AiUsage,
  type DispatchOutcome,
  type EngineResult,
  type ToolDispatcher,
} from './aiProviders.js';
import type { AgentsStore } from './agents.js';
import type { ChatMetaStore } from './chatmeta.js';
import { unwrapEvent } from './envelope.js';
import type { EventRelay } from './events.js';
import type { EvolutionApi } from './evolution.js';
import type { KnowledgeStore } from './knowledge.js';
import { isGroupJid } from './phone.js';
import type { AiReplyQuota } from './quota.js';
import type { Sender } from './sender.js';
import type { OfferingFilters, StudioDataStore } from './studioData.js';

type Logger = (msg: string) => void;

/** The synthetic sender the AI's own messages are attributed to. */
export const AI_AGENT_EMAIL = 'ai-agent@webchat.local';
export const AI_AGENT_NAME = 'AI Assistant';
export const AI_AGENT_COLOR = '#7c3aed';

/** The only reason string the session cap ever writes. */
export const SESSION_CAP_REASON = 'session_cap';

// ---------------------------------------------------------------------------
// Contact context
// ---------------------------------------------------------------------------

export type ContactType = 'lead' | 'active_customer' | 'past_customer' | 'unknown';

export interface ContactContext {
  type: ContactType;
  source: 'local' | 'crm';
  externalId?: string;
}

export interface ContactContextProvider {
  getByPhone(phone: string): Promise<ContactContext>;
}

/**
 * V1 knows nothing about a caller beyond their messages, and says so.
 *
 * ContactFamiliarityStore answers "have we exchanged messages with this number
 * before", which is a different question from "is this a prospect, an active
 * student, or a past student" — so eligibility deliberately does not gate on
 * it. The value is recorded on each audit row for later analysis, and telling
 * an existing student with a billing problem apart from a sales inquiry is left
 * to the model, via the fixed safety rule that covers exactly that.
 */
export const localContactContextProvider: ContactContextProvider = {
  getByPhone: async () => ({ type: 'unknown', source: 'local' }),
};

// ---------------------------------------------------------------------------
// Per-chat state
// ---------------------------------------------------------------------------

export type AiState = 'ACTIVE' | 'HANDOFF_REQUESTED' | 'PAUSED' | 'LIMIT_REACHED';

export interface AiChatState {
  chatJid: string;
  state: AiState;
  reason: string;
  changedBy: string;
  facts: LeadContext;
  summary: string;
  summaryThroughMessageId: string | null;
  replyCount: number;
  sessionStartedAt: string | null;
  lastActivityAt: string | null;
  updatedAt: string;
}

/** The slice the chat list needs — never the facts or the summary. */
export interface AiStateSummary {
  state: AiState;
  reason: string;
  changedBy: string;
  replyCount: number;
  updatedAt: string;
}

interface StateRow {
  chat_jid: string;
  state: string;
  reason: string | null;
  changed_by: string | null;
  facts: string;
  summary: string;
  summary_through_message_id: string | null;
  reply_count: number;
  session_started_at: string | null;
  last_activity_at: string | null;
  updated_at: string;
}

const rowToState = (r: StateRow): AiChatState => ({
  chatJid: r.chat_jid,
  state: r.state as AiState,
  reason: r.reason ?? '',
  changedBy: r.changed_by ?? '',
  facts: parseLeadContext(r.facts),
  summary: r.summary,
  summaryThroughMessageId: r.summary_through_message_id,
  replyCount: r.reply_count,
  sessionStartedAt: r.session_started_at,
  lastActivityAt: r.last_activity_at,
  updatedAt: r.updated_at,
});

/**
 * Per-chat AI control plus the only per-lead memory the AI keeps.
 *
 * Human ownership is NOT represented here: `chat_assignments` is the sole
 * record of that, and `PAUSED` is a resume latch — "may the AI start answering
 * again on its own" — rather than a mirror of who currently owns the chat.
 */
export class AiAgentStore {
  private readonly q;

  constructor(
    db: Db,
    /** Chat rows are jid-keyed app-wide; every read and write canonicalizes. */
    private readonly canon: (jid: string) => string = (j) => j,
  ) {
    this.q = {
      get: db.prepare(`SELECT * FROM ai_agent_chat_state WHERE chat_jid = ?`),
      all: db.prepare(`SELECT * FROM ai_agent_chat_state`),
      ensure: db.prepare(`INSERT OR IGNORE INTO ai_agent_chat_state (chat_jid, updated_at) VALUES (?, ?)`),
      setState: db.prepare(`UPDATE ai_agent_chat_state
        SET state = ?, reason = ?, changed_by = ?, updated_at = ? WHERE chat_jid = ?`),
      setFacts: db.prepare(`UPDATE ai_agent_chat_state SET facts = ?, updated_at = ? WHERE chat_jid = ?`),
      setSummary: db.prepare(`UPDATE ai_agent_chat_state
        SET summary = ?, summary_through_message_id = ?, updated_at = ? WHERE chat_jid = ?`),
      bump: db.prepare(`UPDATE ai_agent_chat_state
        SET reply_count = reply_count + 1,
            session_started_at = COALESCE(session_started_at, ?),
            updated_at = ? WHERE chat_jid = ?`),
      touch: db.prepare(`UPDATE ai_agent_chat_state
        SET last_activity_at = ?,
            session_started_at = COALESCE(session_started_at, ?),
            updated_at = ? WHERE chat_jid = ?`),
      rollover: db.prepare(`UPDATE ai_agent_chat_state
        SET reply_count = 0, session_started_at = ?, state = ?, reason = ?, updated_at = ?
        WHERE chat_jid = ?`),
    };
  }

  /** A chat with no row is simply ACTIVE with an empty session — reads never write. */
  stateOf(jid: string): AiChatState {
    const key = this.canon(jid);
    const r = this.q.get.get(key) as StateRow | undefined;
    if (r) return rowToState(r);
    return {
      chatJid: key,
      state: 'ACTIVE',
      reason: '',
      changedBy: '',
      facts: { ...EMPTY_LEAD_CONTEXT },
      summary: '',
      summaryThroughMessageId: null,
      replyCount: 0,
      sessionStartedAt: null,
      lastActivityAt: null,
      updatedAt: '',
    };
  }

  states(): Record<string, AiStateSummary> {
    const out: Record<string, AiStateSummary> = {};
    for (const r of this.q.all.all() as StateRow[]) {
      out[r.chat_jid] = {
        state: r.state as AiState,
        reason: r.reason ?? '',
        changedBy: r.changed_by ?? '',
        replyCount: r.reply_count,
        updatedAt: r.updated_at,
      };
    }
    return out;
  }

  setState(jid: string, state: AiState, reason = '', by = '', now = new Date()): AiChatState {
    const key = this.canon(jid);
    const iso = now.toISOString();
    this.q.ensure.run(key, iso);
    this.q.setState.run(state, reason, by, iso, key);
    return this.stateOf(key);
  }

  /**
   * Bumps `last_activity_at` — the session clock.
   *
   * Called whenever the inbound gate ACCEPTS a message, not only after a
   * successful AI send: a reply that is debounced, rate-limited or blocked must
   * not make the session look idle while the customer is still writing, or a
   * busy conversation could roll over into a "fresh session" mid-thread.
   */
  touch(jid: string, now = new Date()): void {
    const key = this.canon(jid);
    const iso = now.toISOString();
    this.q.ensure.run(key, iso);
    this.q.touch.run(iso, iso, iso, key);
  }

  /**
   * Session-gap rollover, run BEFORE the eligibility decision on every inbound
   * message — not after.
   *
   * Order matters: a lead returning after the configured gap would otherwise be
   * rejected by a stale LIMIT_REACHED before the code that clears it ever ran,
   * and would need a human to resume a chat whose cap has nothing to do with
   * anything they did. LIMIT_REACHED is the only state this clears: PAUSED and
   * HANDOFF_REQUESTED record a deliberate human/handoff decision and must never
   * auto-clear just because time passed.
   */
  ensureCurrentSession(jid: string, gapHours: number, now = new Date()): AiChatState {
    const key = this.canon(jid);
    const r = this.q.get.get(key) as StateRow | undefined;
    if (!r || !r.last_activity_at) return this.stateOf(key);
    const idleMs = now.getTime() - Date.parse(r.last_activity_at);
    if (!Number.isFinite(idleMs) || idleMs <= gapHours * 3_600_000) return rowToState(r);
    const clearsCap = r.state === 'LIMIT_REACHED';
    this.q.rollover.run(
      now.toISOString(),
      clearsCap ? 'ACTIVE' : r.state,
      clearsCap ? '' : r.reason,
      now.toISOString(),
      key,
    );
    return this.stateOf(key);
  }

  /** Merges an already-sanitized partial through the closed LeadContext shape. */
  mergeFacts(jid: string, partial: Partial<LeadContext>, now = new Date()): LeadContext {
    if (!Object.keys(partial).length) return this.stateOf(jid).facts;
    const key = this.canon(jid);
    const iso = now.toISOString();
    this.q.ensure.run(key, iso);
    const merged = { ...this.stateOf(key).facts, ...sanitizeLeadContext(partial) };
    this.q.setFacts.run(JSON.stringify(merged), iso, key);
    return merged;
  }

  setSummary(jid: string, summary: string, throughMessageId: string | null, now = new Date()): void {
    const key = this.canon(jid);
    const iso = now.toISOString();
    this.q.ensure.run(key, iso);
    this.q.setSummary.run(summary.slice(0, MAX_SUMMARY_CHARS), throughMessageId, iso, key);
  }

  /** Returns the new count, so the caller can compare it against the session cap. */
  bumpReplyCount(jid: string, now = new Date()): number {
    const key = this.canon(jid);
    const iso = now.toISOString();
    this.q.ensure.run(key, iso);
    this.q.bump.run(iso, iso, key);
    return this.stateOf(key).replyCount;
  }
}

// ---------------------------------------------------------------------------
// Pending sends
// ---------------------------------------------------------------------------

export type PendingStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'canceled';

export type FailureKind =
  | 'pre_send_error'
  | 'ambiguous_delivery'
  | 'stale_context'
  | 'human_takeover'
  | 'orphaned_restart'
  | 'send_skipped'
  | 'daily_cap';

export interface PendingSend {
  id: number;
  kind: string;
  chatJid: string;
  instance: string;
  dueAt: string;
  status: PendingStatus;
  attemptCount: number;
  failureKind: string | null;
  auditLogId: number | null;
  historyThroughMessageId: string | null;
  createdAt: string;
}

interface PendingRow {
  id: number;
  kind: string;
  chat_jid: string | null;
  instance: string;
  due_at: string;
  status: string;
  claimed_at: string | null;
  lease_until: string | null;
  attempt_count: number;
  failure_kind: string | null;
  outgoing_message_id: string | null;
  last_error: string | null;
  audit_log_id: number | null;
  history_through_message_id: string | null;
  created_at: string;
}

const rowToPending = (r: PendingRow): PendingSend => ({
  id: r.id,
  kind: r.kind,
  chatJid: r.chat_jid ?? '',
  instance: r.instance,
  dueAt: r.due_at,
  status: r.status as PendingStatus,
  attemptCount: r.attempt_count,
  failureKind: r.failure_kind,
  auditLogId: r.audit_log_id,
  historyThroughMessageId: r.history_through_message_id,
  createdAt: r.created_at,
});

/**
 * The debounced-send queue, and the crash-safe lifecycle around it:
 * `pending → processing → sent | failed | canceled`, plus a daily-cap re-queue
 * that never leaves `pending`.
 *
 * A DB row rather than an in-process timer because a restart between "customer
 * wrote" and "we answered" must not silently drop the answer — and because the
 * outcome of every AI turn needs to be inspectable afterwards, which a
 * setTimeout is not.
 */
export class AiPendingSendStore {
  private readonly q;

  constructor(private readonly db: Db) {
    this.q = {
      byId: db.prepare(`SELECT * FROM ai_agent_pending_sends WHERE id = ?`),
      pendingForChat: db.prepare(`SELECT * FROM ai_agent_pending_sends
        WHERE kind = 'reply' AND status = 'pending' AND chat_jid = ?`),
      pushDue: db.prepare(`UPDATE ai_agent_pending_sends SET due_at = ?, instance = ?
        WHERE kind = 'reply' AND status = 'pending' AND chat_jid = ?`),
      insert: db.prepare(`INSERT INTO ai_agent_pending_sends
        (kind, chat_jid, instance, due_at, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`),
      due: db.prepare(`SELECT * FROM ai_agent_pending_sends
        WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?`),
      claim: db.prepare(`UPDATE ai_agent_pending_sends
        SET status = 'processing', claimed_at = ?, lease_until = ?, attempt_count = attempt_count + 1,
            failure_kind = NULL
        WHERE id = ? AND status = 'pending'`),
      requeue: db.prepare(`UPDATE ai_agent_pending_sends
        SET status = 'pending', due_at = ?, claimed_at = NULL, lease_until = NULL, failure_kind = ?
        WHERE id = ?`),
      settle: db.prepare(`UPDATE ai_agent_pending_sends
        SET status = ?, failure_kind = ?, last_error = ?, outgoing_message_id = ?,
            claimed_at = claimed_at, lease_until = NULL
        WHERE id = ?`),
      setAudit: db.prepare(`UPDATE ai_agent_pending_sends
        SET audit_log_id = ?, history_through_message_id = ? WHERE id = ?`),
      orphans: db.prepare(`UPDATE ai_agent_pending_sends
        SET status = 'failed', failure_kind = 'orphaned_restart', lease_until = NULL
        WHERE status = 'processing' AND (lease_until IS NULL OR lease_until <= ?)`),
    };
  }

  /**
   * The debounce: one pending row per chat (enforced by a partial unique index),
   * with `due_at` pushed forward by every new message so a lead typing four
   * lines gets one considered answer instead of four.
   */
  upsertReply(chatJid: string, instance: string, dueAt: Date): PendingSend {
    const iso = dueAt.toISOString();
    return this.db.transaction(() => {
      const changed = this.q.pushDue.run(iso, instance, chatJid).changes;
      if (!changed) this.q.insert.run('reply', chatJid, instance, iso, new Date().toISOString());
      return rowToPending(this.q.pendingForChat.get(chatJid) as PendingRow);
    })();
  }

  byId(id: number): PendingSend | null {
    const r = this.q.byId.get(id) as PendingRow | undefined;
    return r ? rowToPending(r) : null;
  }

  pendingForChat(chatJid: string): PendingSend | null {
    const r = this.q.pendingForChat.get(chatJid) as PendingRow | undefined;
    return r ? rowToPending(r) : null;
  }

  due(now = new Date(), limit = 5): PendingSend[] {
    return (this.q.due.all(now.toISOString(), limit) as PendingRow[]).map(rowToPending);
  }

  /**
   * One atomic statement, so two overlapping ticks can never both run the same
   * row: the `status = 'pending'` predicate is the whole lock. True
   * multi-process claiming is out of scope here for the same reason it is
   * everywhere else in this codebase — one Node process, synchronous SQLite.
   */
  claim(id: number, now = new Date(), leaseMs = PENDING_LEASE_MS): boolean {
    return (
      this.q.claim.run(
        now.toISOString(),
        new Date(now.getTime() + leaseMs).toISOString(),
        id,
      ).changes > 0
    );
  }

  /** Daily-cap re-queue and the single pre-send retry. Never a terminal state. */
  requeue(id: number, dueAt: Date, why: FailureKind): void {
    this.q.requeue.run(dueAt.toISOString(), why, id);
  }

  markSent(id: number, outgoingMessageId?: string): void {
    this.q.settle.run('sent', null, null, outgoingMessageId ?? null, id);
  }

  markFailed(id: number, kind: FailureKind, error?: string): void {
    this.q.settle.run('failed', kind, error?.slice(0, 500) ?? null, null, id);
  }

  markCanceled(id: number, kind: FailureKind, error?: string): void {
    this.q.settle.run('canceled', kind, error?.slice(0, 500) ?? null, null, id);
  }

  setAudit(id: number, auditLogId: number, historyThroughMessageId: string | null): void {
    this.q.setAudit.run(auditLogId, historyThroughMessageId, id);
  }

  /**
   * A row still `processing` past its lease was interrupted by a crash or a
   * restart. It is marked failed and NEVER resent: we cannot know whether the
   * send call had already reached Evolution, and a possibly-missed reply is a
   * far better failure than a possibly-duplicated one.
   */
  recoverOrphans(now = new Date()): number {
    return this.q.orphans.run(now.toISOString()).changes;
  }

  /** Everything about one chat's queue, newest first — the AI activity panel. */
  recentForChat(chatJid: string, limit = 20): PendingSend[] {
    return (
      this.db
        .prepare(`SELECT * FROM ai_agent_pending_sends WHERE chat_jid = ? ORDER BY id DESC LIMIT ?`)
        .all(chatJid, limit) as PendingRow[]
    ).map(rowToPending);
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditCreate {
  chatJid: string;
  instance: string;
  contactType: ContactType;
  aiStateBefore: AiState;
  provider: string;
  model: string;
  promptSnapshot: string;
  historyThroughMessageId: string | null;
  knowledgeUsed: number[];
  toolsCalled: unknown;
  memoryUpdates: unknown;
  responseText: string;
  handoff: boolean;
  handoffReason: string;
  usage: AiUsage;
  latencyMs: number;
}

export type DeliveryOutcome = 'sent' | 'canceled_stale' | 'canceled_takeover' | 'failed';

export interface AuditRow {
  id: number;
  createdAt: string;
  chatJid: string;
  instance: string;
  contactType: string;
  aiStateBefore: string;
  provider: string;
  model: string;
  promptHash: string;
  historyThroughMessageId: string | null;
  knowledgeUsed: number[];
  toolsCalled: unknown;
  memoryUpdates: unknown;
  responseText: string;
  handoff: boolean;
  handoffReason: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  latencyMs: number | null;
  deliveryOutcome: string | null;
  outgoingMessageId: string | null;
  error: string | null;
}

export const promptHash = (prompt: string): string =>
  createHash('sha256').update(prompt).digest('hex').slice(0, 16);

/**
 * One row per AI turn, written in TWO phases because generation and delivery
 * are separated by the take-over/staleness re-check: the engine has no idea
 * whether the message it produced will actually go out. `create` records
 * everything generation knows; `finalize` writes the outcome back onto the same
 * row once it is known. A completed send always has both.
 */
export class AiAuditLog {
  private readonly q;

  constructor(private readonly db: Db) {
    this.q = {
      insert: db.prepare(`INSERT INTO ai_agent_audit_log
        (created_at, chat_jid, instance, contact_type, ai_state_before, provider, model,
         prompt_hash, prompt_snapshot, history_through_message_id, knowledge_used, tools_called,
         memory_updates, response_text, handoff, handoff_reason, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, latency_ms)
        VALUES (@created_at, @chat_jid, @instance, @contact_type, @ai_state_before, @provider, @model,
         @prompt_hash, @prompt_snapshot, @history_through_message_id, @knowledge_used, @tools_called,
         @memory_updates, @response_text, @handoff, @handoff_reason, @input_tokens, @output_tokens,
         @cache_read_tokens, @cache_write_tokens, @latency_ms)`),
      finalize: db.prepare(`UPDATE ai_agent_audit_log
        SET delivery_outcome = ?, outgoing_message_id = ?, error = ? WHERE id = ?`),
      byId: db.prepare(`SELECT * FROM ai_agent_audit_log WHERE id = ?`),
    };
  }

  create(a: AuditCreate, now = new Date()): number {
    const r = this.q.insert.run({
      created_at: now.toISOString(),
      chat_jid: a.chatJid,
      instance: a.instance,
      contact_type: a.contactType,
      ai_state_before: a.aiStateBefore,
      provider: a.provider,
      model: a.model,
      prompt_hash: promptHash(a.promptSnapshot),
      prompt_snapshot: a.promptSnapshot,
      history_through_message_id: a.historyThroughMessageId,
      knowledge_used: JSON.stringify(a.knowledgeUsed),
      tools_called: JSON.stringify(a.toolsCalled ?? []),
      memory_updates: JSON.stringify(a.memoryUpdates ?? {}),
      response_text: a.responseText,
      handoff: a.handoff ? 1 : 0,
      handoff_reason: a.handoffReason || null,
      input_tokens: a.usage.inputTokens,
      output_tokens: a.usage.outputTokens,
      cache_read_tokens: a.usage.cacheReadTokens ?? 0,
      cache_write_tokens: a.usage.cacheWriteTokens ?? 0,
      latency_ms: a.latencyMs,
    });
    return Number(r.lastInsertRowid);
  }

  finalize(
    id: number,
    outcome: DeliveryOutcome,
    outgoingMessageId?: string,
    error?: string,
  ): void {
    this.q.finalize.run(outcome, outgoingMessageId ?? null, error?.slice(0, 500) ?? null, id);
  }

  byId(id: number): AuditRow | null {
    const r = this.q.byId.get(id) as Record<string, unknown> | undefined;
    return r ? this.rowTo(r) : null;
  }

  recent(chatJid?: string, limit = 50): AuditRow[] {
    const rows = chatJid
      ? this.db
          .prepare(`SELECT * FROM ai_agent_audit_log WHERE chat_jid = ? ORDER BY id DESC LIMIT ?`)
          .all(chatJid, limit)
      : this.db
          .prepare(`SELECT * FROM ai_agent_audit_log ORDER BY id DESC LIMIT ?`)
          .all(limit);
    return (rows as Array<Record<string, unknown>>).map((r) => this.rowTo(r));
  }

  /** prompt_snapshot is deliberately NOT projected — it is bulky and per-turn identical. */
  private rowTo(r: Record<string, unknown>): AuditRow {
    const json = (v: unknown, fallback: unknown) => {
      try {
        return JSON.parse(String(v ?? ''));
      } catch {
        return fallback;
      }
    };
    return {
      id: Number(r.id),
      createdAt: String(r.created_at),
      chatJid: String(r.chat_jid),
      instance: String(r.instance ?? ''),
      contactType: String(r.contact_type ?? 'unknown'),
      aiStateBefore: String(r.ai_state_before ?? ''),
      provider: String(r.provider ?? ''),
      model: String(r.model ?? ''),
      promptHash: String(r.prompt_hash ?? ''),
      historyThroughMessageId: (r.history_through_message_id as string | null) ?? null,
      knowledgeUsed: json(r.knowledge_used, []) as number[],
      toolsCalled: json(r.tools_called, []),
      memoryUpdates: json(r.memory_updates, {}),
      responseText: String(r.response_text ?? ''),
      handoff: !!r.handoff,
      handoffReason: String(r.handoff_reason ?? ''),
      inputTokens: (r.input_tokens as number | null) ?? null,
      outputTokens: (r.output_tokens as number | null) ?? null,
      cacheReadTokens: (r.cache_read_tokens as number | null) ?? null,
      cacheWriteTokens: (r.cache_write_tokens as number | null) ?? null,
      latencyMs: (r.latency_ms as number | null) ?? null,
      deliveryOutcome: (r.delivery_outcome as string | null) ?? null,
      outgoingMessageId: (r.outgoing_message_id as string | null) ?? null,
      error: (r.error as string | null) ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

export interface ThreadPage {
  records: Array<Record<string, any>>;
  pages: number;
}

/** The one thing the AI needs from Evolution: pages of one conversation. */
export interface ThreadReader {
  page(instance: string, remoteJid: string, page: number): Promise<ThreadPage>;
}

/**
 * `chat/findMessages` as it actually behaves (verified against the existing
 * gateway proxy, not assumed): the body is
 * `{ where: { key: { remoteJid } }, page }`, the response is
 * `{ messages: { records, pages } }`, pages hold 50 records, and page 1 is the
 * newest. There is NO "messages after id X" filter — which is why countSince
 * below is a bounded backward walk rather than a cursor query.
 */
export function evolutionThreadReader(evo: EvolutionApi): ThreadReader {
  return {
    async page(instance, remoteJid, page) {
      const r = await evo.call(`/chat/findMessages/${encodeURIComponent(instance)}`, {
        where: { key: { remoteJid } },
        page,
      });
      if (!r.ok) throw new Error(`findMessages ${r.status}: ${r.text.slice(0, 200)}`);
      const d = JSON.parse(r.text) as { messages?: { records?: unknown; pages?: unknown } };
      return {
        records: Array.isArray(d?.messages?.records)
          ? (d.messages.records as Array<Record<string, any>>)
          : [],
        pages: Number(d?.messages?.pages) || 1,
      };
    },
  };
}

const tsOf = (r: Record<string, any>): number => {
  const t = Number(r?.messageTimestamp ?? 0);
  return Number.isFinite(t) ? t : 0;
};

const idOf = (r: Record<string, any>): string => String(r?.key?.id ?? '');

/** The text of an inbound record, and whether it had any at all. */
export function extractInboundText(r: Record<string, any>): {
  text: string;
  kind: 'text' | 'media';
} {
  const m = r?.message ?? {};
  const text: string =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    '';
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return trimmed ? { text: trimmed, kind: 'text' } : { text: '', kind: 'media' };
}

function recordToTurn(r: Record<string, any>): AiTurn | null {
  const id = idOf(r);
  if (!id) return null;
  const { text, kind } = extractInboundText(r);
  return {
    role: r?.key?.fromMe ? 'agent' : 'customer',
    // a voice note or a bare photo earlier in the thread still happened; the
    // model needs to know something was there, not what it said
    text: kind === 'text' ? text : '[non-text message]',
    messageId: id,
    timestamp: tsOf(r),
  };
}

export interface RecentContext {
  turns: AiTurn[];
  /**
   * The newest message id this read saw, whoever sent it. Captured so the
   * pre-send re-check can tell "nothing changed" from "the customer wrote
   * again, or a human answered, while we were generating".
   */
  throughMessageId: string | null;
}

/**
 * The reply context: the last MAX_HISTORY_MESSAGES messages, oldest first,
 * additionally capped by MAX_HISTORY_CHARS (dropping from the front, so the
 * customer's most recent words always survive).
 */
export async function fetchRecentContext(
  reader: ThreadReader,
  instance: string,
  jid: string,
  limit = MAX_HISTORY_MESSAGES,
): Promise<RecentContext> {
  const { records } = await reader.page(instance, jid, 1);
  const sorted = [...records].sort((a, b) => tsOf(a) - tsOf(b));
  const newest = sorted[sorted.length - 1];
  const turns = sorted
    .map(recordToTurn)
    .filter((t): t is AiTurn => !!t)
    .slice(-Math.max(1, limit));
  let chars = turns.reduce((n, t) => n + t.text.length, 0);
  while (turns.length > 1 && chars > MAX_HISTORY_CHARS) {
    chars -= turns[0]!.text.length;
    turns.shift();
  }
  return { turns, throughMessageId: newest ? idOf(newest) : null };
}

export interface SinceResult {
  count: number;
  /** The unsummarized messages themselves, oldest first — the summarizer's input. */
  messages: AiTurn[];
  newestMessageId: string | null;
  /** True when SUMMARY_LOOKBACK_CAP was reached before the cursor was found. */
  truncated: boolean;
}

/**
 * How many messages have arrived since the summary cursor — a SEPARATE read
 * from the reply-context window above, and deliberately so.
 *
 * The refresh window (up to SUMMARY_LOOKBACK_CAP messages, over several pages)
 * and the reply window (the last 6) answer different questions and must not be
 * conflated: sizing the summary trigger off the 6-message read would mean a
 * thread could never accumulate the 12 unsummarized messages that trigger a
 * refresh, so the summary would never advance and long conversations would
 * silently lose their earlier context.
 *
 * Implemented as a bounded BACKWARD PAGINATION WALK because `chat/findMessages`
 * has no "after this id" filter: pages come newest-first, and the walk stops at
 * the cursor, at the page count, or at the cap — whichever comes first.
 */
export async function countSince(
  reader: ThreadReader,
  instance: string,
  jid: string,
  sinceMessageId: string | null,
  cap = SUMMARY_LOOKBACK_CAP,
): Promise<SinceResult> {
  const collected: Array<Record<string, any>> = [];
  let newestMessageId: string | null = null;
  let found = false;
  let pages = 1;
  for (let page = 1; page <= pages && collected.length < cap; page++) {
    const res = await reader.page(instance, jid, page);
    pages = Math.max(1, res.pages);
    const desc = [...res.records].sort((a, b) => tsOf(b) - tsOf(a));
    if (page === 1 && desc.length) newestMessageId = idOf(desc[0]!);
    for (const r of desc) {
      if (sinceMessageId && idOf(r) === sinceMessageId) {
        found = true;
        break;
      }
      collected.push(r);
      if (collected.length >= cap) break;
    }
    if (found || !res.records.length) break;
  }
  const messages = collected
    .sort((a, b) => tsOf(a) - tsOf(b))
    .map(recordToTurn)
    .filter((t): t is AiTurn => !!t);
  return {
    count: messages.length,
    messages,
    newestMessageId,
    truncated: !found && !!sinceMessageId && collected.length >= cap,
  };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

const filtersFrom = (args: Record<string, unknown>): OfferingFilters => ({
  branch: typeof args.branch === 'string' ? args.branch.trim() : undefined,
  ageGroup: typeof args.age_group === 'string' ? args.age_group.trim() : undefined,
  dayOfWeek: typeof args.day_of_week === 'string' ? args.day_of_week.trim().toLowerCase() : undefined,
  level: typeof args.level === 'string' ? args.level.trim() : undefined,
});

/**
 * The five read-only retrieval tools, wired to their stores. Every one of them
 * either returns data, `{status:'unknown'}` (nothing matched the freshness
 * rules) or `{status:'invalid_request', error}` — which the model reads as an
 * ordinary result and can correct from, rather than a broadened query it would
 * answer confidently and wrongly.
 */
export function createToolDispatcher(
  knowledge: KnowledgeStore,
  studio: StudioDataStore,
  clock: () => Date = () => new Date(),
): ToolDispatcher {
  return {
    dispatch(name, args): DispatchOutcome {
      const now = clock();
      switch (name) {
        case 'search_knowledge': {
          const raw = typeof args.query === 'string' ? args.query.trim() : '';
          if (!raw)
            return {
              result: { status: 'invalid_request', error: 'query must be a non-empty string' },
            };
          const hits = knowledge.search(raw.slice(0, MAX_QUERY_CHARS), MAX_KNOWLEDGE_RESULTS);
          if (!hits.length) return { result: { status: 'unknown' } };
          return {
            result: {
              status: 'ok',
              results: hits.map((a) => ({
                title: a.title,
                category: a.category,
                content: a.content.slice(0, MAX_KNOWLEDGE_CHARS_PER_RESULT),
              })),
            },
            knowledgeIds: hits.map((a) => a.id),
          };
        }
        case 'get_courses':
          return { result: studio.courses(filtersFrom(args), now) };
        case 'get_prices':
          return { result: studio.prices(filtersFrom(args), now) };
        case 'get_available_offers':
          return { result: studio.offers(filtersFrom(args), now) };
        case 'get_availability':
          return { result: studio.availability(filtersFrom(args), now) };
        default:
          return {
            result: { status: 'invalid_request', error: `unknown tool ${JSON.stringify(name)}` },
          };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

export interface ListenerDeps {
  cfg: Config;
  store: AiAgentStore;
  chatMeta: ChatMetaStore;
  pending: AiPendingSendStore;
  /** Unsupported media hands off straight away, skipping the debounce path. */
  onImmediateHandoff: (jid: string, instance: string, reason: string) => Promise<void>;
  emit: (event: string, data: unknown) => void;
  log?: Logger;
}

/**
 * The inbound side, on the same template as OptOutListener: subscribe to the
 * relay, filter to non-group non-fromMe MESSAGES_UPSERT records, and handle each
 * fire-and-forget so a failure here can never break the relay fan-out.
 */
export class AiAgentListener {
  private readonly log: Logger;

  constructor(private readonly deps: ListenerDeps) {
    this.log = deps.log ?? ((m) => console.log(new Date().toISOString(), m));
  }

  attach(relay: EventRelay): void {
    relay.subscribe((e) => {
      if (e.event !== 'MESSAGES_UPSERT' && e.event !== 'messages.upsert') return;
      const { instance, records } = unwrapEvent(e.data);
      for (const record of records as Array<Record<string, any>>) {
        void this.handle(record, instance).catch((err) =>
          this.log(`[aiagent] error: ${String(err)}`),
        );
      }
    });
  }

  async handle(r: Record<string, any>, instance?: string): Promise<void> {
    const { cfg, store, chatMeta, pending } = this.deps;
    const rawJid = String(r?.key?.remoteJid ?? '');
    if (!rawJid || rawJid === 'status@broadcast' || r?.key?.fromMe || isGroupJid(rawJid)) return;
    const jid = chatMeta.canon(rawJid);

    // Session rollover runs FIRST, before anything can reject this message: a
    // lead returning after the gap must not be turned away by a stale
    // LIMIT_REACHED that the rollover was about to clear.
    store.ensureCurrentSession(jid, cfg.aiAgentSessionGapHours);

    if (!cfg.aiAgentEnabled) return;
    const inst = instance ?? cfg.evo.instance;
    // Explicit allow-list, empty by default. The AI never answers on a line
    // nobody ticked, whatever the master switch says.
    if (!cfg.aiAgentInstances.includes(inst)) return;
    if (chatMeta.assigneeOf(jid)) return;
    const st = store.stateOf(jid);
    if (st.state !== 'ACTIVE') return;
    if (st.replyCount >= cfg.aiAgentMaxRepliesPerSession) {
      store.setState(jid, 'LIMIT_REACHED', SESSION_CAP_REASON, '');
      this.deps.emit('AI_AGENT_STATE', {
        jid,
        state: 'LIMIT_REACHED',
        reason: SESSION_CAP_REASON,
      });
      return;
    }

    // Accepted. The session clock moves now, whether or not a reply follows.
    store.touch(jid);

    const { kind } = extractInboundText(r);
    if (kind === 'media') {
      await this.deps.onImmediateHandoff(jid, inst, 'unsupported_media');
      return;
    }

    pending.upsertReply(jid, inst, new Date(Date.now() + cfg.aiAgentReplyDelaySec * 1000));
  }
}

// ---------------------------------------------------------------------------
// Runner (poller + one AI turn)
// ---------------------------------------------------------------------------

export interface RunnerDeps {
  cfg: Config;
  store: AiAgentStore;
  pending: AiPendingSendStore;
  audit: AiAuditLog;
  chatMeta: ChatMetaStore;
  agents: AgentsStore;
  sender: Sender;
  quota: AiReplyQuota;
  knowledge: KnowledgeStore;
  studio: StudioDataStore;
  thread: ThreadReader;
  emit: (event: string, data: unknown) => void;
  contacts?: ContactContextProvider;
  /** Test seams. */
  providerFor?: (name: Config['aiAgentProvider']) => AiProvider;
  fetchFn?: typeof fetch;
  log?: Logger;
}

export interface TestRunResult extends EngineResult {
  provider: string;
  model: string;
  promptHash: string;
}

const phoneOf = (jid: string): string => jid.split('@')[0] ?? '';

/**
 * Everything that happens after a debounce window closes: the poller, one AI
 * turn end to end, and the immediate-handoff path.
 */
export class AiAgentRunner {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly log: Logger;
  private readonly tools: ToolDispatcher;

  constructor(private readonly deps: RunnerDeps) {
    this.log = deps.log ?? ((m) => console.log(new Date().toISOString(), m));
    this.tools = createToolDispatcher(deps.knowledge, deps.studio);
  }

  private provider(): AiProvider {
    return (this.deps.providerFor ?? providerFor)(this.deps.cfg.aiAgentProvider);
  }

  private engine(): AiAgentEngine {
    return new AiAgentEngine(this.provider(), this.tools, this.log);
  }

  startPolling(intervalMs = 7_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stopPolling(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One poll. Orphan recovery runs unconditionally (a queue left dirty by a
   * crash should be cleaned up even after the feature is switched off), then
   * due rows are claimed one at a time.
   */
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.deps.pending.recoverOrphans(now);
      if (!this.deps.cfg.aiAgentEnabled) return;
      for (const row of this.deps.pending.due(now)) {
        if (row.kind !== 'reply') continue; // 'lead_opener' is reserved for V1.1
        // The GLOBAL daily cap is checked here, at send time, and never at gate
        // time: it isn't a fact about this chat, so it must not mark this chat
        // as anything. The row is simply pushed forward and picked up by the
        // first poll after midnight, with no human intervention.
        if (this.deps.quota.remaining(now) <= 0) {
          this.deps.pending.requeue(
            row.id,
            new Date(now.getTime() + DAILY_CAP_RETRY_DELAY_SEC * 1000),
            'daily_cap',
          );
          continue;
        }
        if (!this.deps.pending.claim(row.id, now)) continue;
        try {
          await this.respond(row);
        } catch (e) {
          this.log(`[aiagent] respond(${row.chatJid}) crashed: ${String(e)}`);
          this.deps.pending.markFailed(row.id, 'pre_send_error', String(e));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** One AI turn: generate, audit, re-check, send, finalize, bookkeeping. */
  async respond(row: PendingSend): Promise<void> {
    const { cfg, store, pending, audit, chatMeta, thread } = this.deps;
    const jid = row.chatJid;
    const instance = row.instance;
    const before = store.stateOf(jid);
    const model = resolveModel(cfg);
    const systemPrompt = buildSystemPrompt(cfg);
    const contact = await (this.deps.contacts ?? localContactContextProvider).getByPhone(
      phoneOf(jid),
    );

    let result: EngineResult;
    let ctxThrough: string | null = null;
    let summary = before.summary;
    try {
      if (!cfg.aiAgentApiKey) throw new Error('no AI API key configured');
      if (!model) throw new Error('no model resolved (custom tier with an empty model?)');

      // (a) Summary refresh — its OWN read, over its own window.
      const since = await countSince(thread, instance, jid, before.summaryThroughMessageId);
      if (since.count >= SUMMARY_REFRESH_EVERY && since.newestMessageId) {
        try {
          const s = await this.provider().summarize({
            apiKey: cfg.aiAgentApiKey,
            model: resolveSummaryModel(cfg),
            priorSummary: summary,
            messages: since.messages,
            fetchFn: this.deps.fetchFn,
          });
          if (s.summary.trim()) {
            summary = s.summary;
            store.setSummary(jid, summary, since.newestMessageId);
          }
        } catch (e) {
          // A failed refresh costs context, not correctness — answer anyway.
          this.log(`[aiagent] summary refresh failed for ${jid}: ${String(e)}`);
        }
      }

      // (b) The reply context — a separate, bounded read.
      const ctx = await fetchRecentContext(thread, instance, jid);
      ctxThrough = ctx.throughMessageId;

      result = await this.engine().run({
        apiKey: cfg.aiAgentApiKey,
        model,
        systemPrompt,
        facts: before.facts,
        summary,
        history: ctx.turns,
        fetchFn: this.deps.fetchFn,
      });
    } catch (e) {
      // Nothing has been sent — one retry is provably safe.
      const err = String((e as Error).message ?? e);
      this.log(`[aiagent] generation failed for ${jid}: ${err}`);
      if (row.attemptCount + 1 < MAX_SEND_ATTEMPTS)
        pending.requeue(row.id, new Date(), 'pre_send_error');
      else pending.markFailed(row.id, 'pre_send_error', err);
      return;
    }

    // Phase 1 of the audit log: everything generation knows.
    const auditId = audit.create({
      chatJid: jid,
      instance,
      contactType: contact.type,
      aiStateBefore: before.state,
      provider: cfg.aiAgentProvider,
      model,
      promptSnapshot: systemPrompt,
      historyThroughMessageId: ctxThrough,
      knowledgeUsed: result.knowledgeUsed,
      toolsCalled: result.toolsCalled,
      memoryUpdates: result.memoryUpdates,
      responseText: result.reply,
      handoff: result.handoff,
      handoffReason: result.handoffReason,
      usage: result.usage,
      latencyMs: result.latencyMs,
    });
    pending.setAudit(row.id, auditId, ctxThrough);

    // Re-check immediately before sending. A human take-over is exactly the
    // condition that should suppress this reply, and a newer inbound message
    // has already re-upserted a fresh pending row — so nothing is lost either
    // way, and the row is explicitly settled rather than left in 'processing'.
    if (chatMeta.assigneeOf(jid) || store.stateOf(jid).state !== 'ACTIVE') {
      pending.markCanceled(row.id, 'human_takeover');
      audit.finalize(auditId, 'canceled_takeover');
      return;
    }
    let latest: string | null;
    try {
      latest = (await fetchRecentContext(thread, instance, jid, 1)).throughMessageId;
    } catch (e) {
      const err = String((e as Error).message ?? e);
      if (row.attemptCount + 1 < MAX_SEND_ATTEMPTS)
        pending.requeue(row.id, new Date(), 'pre_send_error');
      else pending.markFailed(row.id, 'pre_send_error', err);
      audit.finalize(auditId, 'failed', undefined, err);
      return;
    }
    if (latest && ctxThrough && latest !== ctxThrough) {
      pending.markCanceled(row.id, 'stale_context');
      audit.finalize(auditId, 'canceled_stale');
      return;
    }

    // The handoff message: the model's own acknowledgement if it wrote one,
    // otherwise the configured fallback (blank = send nothing). The same path
    // covers a model-requested handoff, unsupported media, and "no valid final
    // response" — and it counts toward both quotas like any other AI send.
    const text = (
      result.handoff ? result.reply || cfg.aiAgentHandoffMessage : result.reply
    ).trim();

    let messageId: string | undefined;
    if (text) {
      try {
        const outcome = await this.deps.sender.sendOne(
          phoneOf(jid),
          { type: 'text', data: { text } },
          instance,
        );
        if (outcome.status === 'skipped') {
          pending.markCanceled(row.id, 'send_skipped', outcome.reason);
          audit.finalize(auditId, 'failed', undefined, `skipped: ${outcome.reason}`);
          return;
        }
        messageId = outcome.messageId;
      } catch (e) {
        // The call was made and we do not know whether it landed. Never retried.
        const err = String((e as Error).message ?? e);
        this.log(`[aiagent] send to ${jid} failed: ${err}`);
        pending.markFailed(row.id, 'ambiguous_delivery', err);
        audit.finalize(auditId, 'failed', undefined, err);
        return;
      }
    }

    pending.markSent(row.id, messageId);
    audit.finalize(auditId, 'sent', messageId);
    this.afterSend(jid, instance, result, messageId, !!text);
  }

  /** Bookkeeping after a successful send. Never allowed to fail the send. */
  private afterSend(
    jid: string,
    instance: string,
    result: EngineResult,
    messageId: string | undefined,
    counted: boolean,
  ): void {
    const { cfg, store, agents, quota, chatMeta, emit } = this.deps;
    try {
      store.mergeFacts(jid, result.memoryUpdates);
      if (counted) {
        if (messageId) agents.recordMessage(messageId, AI_AGENT_EMAIL, jid, instance);
        quota.record(instance, jid);
        store.touch(jid);
        const count = store.bumpReplyCount(jid);
        if (!result.handoff && count >= cfg.aiAgentMaxRepliesPerSession) {
          store.setState(jid, 'LIMIT_REACHED', SESSION_CAP_REASON, AI_AGENT_EMAIL);
          emit('AI_AGENT_STATE', { jid, state: 'LIMIT_REACHED', reason: SESSION_CAP_REASON });
        }
      }
      if (result.handoff) {
        const reason = result.handoffReason || 'handoff_requested';
        store.setState(jid, 'HANDOFF_REQUESTED', reason, AI_AGENT_EMAIL);
        chatMeta.setStatus(jid, 'pending', '');
        emit('AI_AGENT_STATE', { jid, state: 'HANDOFF_REQUESTED', reason });
        emit('CHAT_STATUS', { jid, status: 'pending', by: '' });
      }
    } catch (e) {
      this.log(`[aiagent] post-send bookkeeping for ${jid} failed: ${String(e)}`);
    }
  }

  /**
   * Unsupported media (a voice note, a bare photo, a document): hand off at
   * once, without a model call. Nothing extra is needed for the human to see
   * what arrived — the original is fully visible in the normal chat view
   * regardless of anything the AI did, and this path never touches message
   * content, only ai_agent_chat_state and chat_status.
   */
  async handoffNow(jid: string, instance: string, reason: string): Promise<void> {
    const { cfg, store, audit, chatMeta, agents, quota, emit } = this.deps;
    const before = store.stateOf(jid);
    const text = cfg.aiAgentHandoffMessage.trim();
    const contact = await (this.deps.contacts ?? localContactContextProvider).getByPhone(
      phoneOf(jid),
    );
    let messageId: string | undefined;
    let error: string | undefined;
    let sent = false;
    if (text && quota.remaining() > 0) {
      try {
        const outcome = await this.deps.sender.sendOne(
          phoneOf(jid),
          { type: 'text', data: { text } },
          instance,
        );
        if (outcome.status === 'sent') {
          sent = true;
          messageId = outcome.messageId;
        } else {
          error = `skipped: ${outcome.reason}`;
        }
      } catch (e) {
        error = String((e as Error).message ?? e);
        this.log(`[aiagent] handoff message to ${jid} failed: ${error}`);
      }
    }
    const auditId = audit.create({
      chatJid: jid,
      instance,
      contactType: contact.type,
      aiStateBefore: before.state,
      provider: cfg.aiAgentProvider,
      model: resolveModel(cfg),
      promptSnapshot: buildSystemPrompt(cfg),
      historyThroughMessageId: null,
      knowledgeUsed: [],
      toolsCalled: [],
      memoryUpdates: {},
      responseText: sent ? text : '',
      handoff: true,
      handoffReason: reason,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      latencyMs: 0,
    });
    audit.finalize(auditId, error ? 'failed' : 'sent', messageId, error);
    if (sent) {
      if (messageId) agents.recordMessage(messageId, AI_AGENT_EMAIL, jid, instance);
      quota.record(instance, jid);
      store.bumpReplyCount(jid);
    }
    store.setState(jid, 'HANDOFF_REQUESTED', reason, AI_AGENT_EMAIL);
    chatMeta.setStatus(jid, 'pending', '');
    emit('AI_AGENT_STATE', { jid, state: 'HANDOFF_REQUESTED', reason });
    emit('CHAT_STATUS', { jid, status: 'pending', by: '' });
  }

  /**
   * The Settings → Test sandbox. Stateless by design: it runs the real engine
   * against a scratch lead context and NEVER sends anything, records nothing and
   * touches no chat state — the caller supplies the whole conversation, so a
   * multi-turn sandbox is just a longer `history`.
   */
  async runTest(message: string, history: AiTurn[] = []): Promise<TestRunResult> {
    const { cfg } = this.deps;
    const model = resolveModel(cfg);
    const systemPrompt = buildSystemPrompt(cfg);
    const turns: AiTurn[] = [
      ...history,
      { role: 'customer' as const, text: message },
    ].slice(-MAX_HISTORY_MESSAGES);
    const result = await this.engine().run({
      apiKey: cfg.aiAgentApiKey,
      model,
      systemPrompt,
      facts: { ...EMPTY_LEAD_CONTEXT },
      summary: '',
      history: turns,
      fetchFn: this.deps.fetchFn,
    });
    return { ...result, provider: cfg.aiAgentProvider, model, promptHash: promptHash(systemPrompt) };
  }
}
