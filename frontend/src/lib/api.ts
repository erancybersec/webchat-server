import type {
  Agent,
  AgentInsightsRow,
  AgentRole,
  AnalyticsSummary,
  BlacklistEntry,
  CampaignProgress,
  ChatMeta,
  ChatNote,
  ChatWorkStatus,
  CleanupResult,
  EvoChat,
  InstanceInfo,
  Job,
  JobItem,
  JobPage,
  JobScope,
  JobSend,
  JobStatus,
  JobVolumeDay,
  ListMember,
  ListRecipe,
  MaintenanceReport,
  Me,
  MessageAgents,
  Perms,
  QuickReplyMediaInput,
  Recipient,
  RecipientList,
  Reminder,
  ResolvedQuickReplyMedia,
  SendResult,
  SendStatus,
  ServerQuickReply,
  VerificationPage,
  VerificationSweep,
  VerifyStatus,
} from '../types';
import { getActiveInstance, withInstance } from './instance';

/** Insights window: a day preset, or an explicit YYYY-MM-DD from/to range. */
export type AnalyticsRange = { days: number } | { from: string; to: string };

function rangeQuery(range: AnalyticsRange): string {
  return 'days' in range
    ? `days=${range.days}`
    : `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

const DEFAULT_TIMEOUT_MS = 25_000;

/** Thrown when a request is aborted by the client-side timeout (never by a server error). */
export class TimeoutError extends Error {
  readonly timedOut = true as const;
  constructor(msg = 'The request timed out') {
    super(msg);
    this.name = 'TimeoutError';
  }
}

type HttpInit = RequestInit & { timeoutMs?: number };

async function http<T>(path: string, init?: HttpInit): Promise<T> {
  // Content-Type only when a body is actually sent — Fastify 400s on
  // "application/json" with an empty body (bodyless DELETEs broke on this).
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init?.body != null) headers['Content-Type'] = 'application/json';
  // AbortController timeout: a hung request must always settle, so a send can
  // never stay outstanding forever (which used to lock the composer). The
  // `timedOut` flag distinguishes a timeout-driven abort from a coincidental
  // post-abort reject, and we capture `res` before parsing so a slow body
  // parse of a 200 is never relabeled a timeout.
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init ?? {};
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, { ...rest, headers, signal: ac.signal });
  } catch (e) {
    if (timedOut) throw new TimeoutError('The request timed out — check your connection');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

const get = <T,>(path: string) => http<T>(path);
const post = <T,>(path: string, body?: unknown) =>
  http<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const put = <T,>(path: string, body: unknown) =>
  http<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T,>(path: string) => http<T>(path, { method: 'DELETE' });

// Endpoints scoped to the ACTIVE instance (header switcher) append `?instance=`:
// Evolution-backed calls plus the per-instance-separated surfaces — jobs
// (schedule/history), quick replies and analytics/insights. The rest (lists,
// blacklist, chat-meta, reminders, agents) stays instance-free.
const iget = <T,>(path: string) => http<T>(withInstance(path));
const ipost = <T,>(path: string, body?: unknown, opts?: { timeoutMs?: number }) =>
  http<T>(withInstance(path), { method: 'POST', body: JSON.stringify(body ?? {}), ...opts });
const iput = <T,>(path: string, body: unknown) =>
  http<T>(withInstance(path), { method: 'PUT', body: JSON.stringify(body) });
const idel = <T,>(path: string) => http<T>(withInstance(path), { method: 'DELETE' });

export interface ServerSettings {
  base: string;
  instance: string;
  apikeySet: boolean;
  apikeyHint: string;
  delayMin: number;
  delayMax: number;
  /** Zone the server reads every 'HH:MM' in (quiet hours, sending windows). */
  timezone: string;
  serverTime: string;
  recurringEnabled: boolean;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  optoutEnabled: boolean;
  optoutKeywords: string;
  optoutReply: string;
  agentsEnabled: boolean;
  approvalThreshold: number;
  retentionDays: number;
  verifyEnabled: boolean;
  verifyValidDays: number;
  verifyInvalidDays: number;
  /** Background number check — how hard it may lean on Evolution. */
  verifyDailyCap: number;
  verifyBatchSize: number;
  verifyBatchPauseMs: number;
  verifyBreakerRun: number;
  /** Cold-contact ration: first contact per rolling 24h, with a warm-up ramp. */
  coldCapEnabled: boolean;
  coldDailyCap: number;
  coldWarmupStart: number;
  /** Rolling window the ramp counts active days over; also the cold-send retention. */
  coldRampWindowDays: number;
  /** Evolution lines that fire push notifications; [] = default line only. */
  notifyInstances: string[];
}

/** Today's first-contact ration for one line, and how much of it is left. */
export interface SendingLimits {
  instance: string;
  coldContacts: {
    spent: number;
    cap: number;
    /** null = capping is off (JSON has no Infinity). */
    remaining: number | null;
    activeDays: number;
    enabled: boolean;
    warmupStart: number;
    dailyCap: number;
  };
  knownContacts: number;
  verification: {
    enabled: boolean;
    batchSize: number;
    batchPauseMs: number;
    dailyCap: number;
  };
}

/** How a candidate recipient list splits by familiarity, before send. */
export interface RecipientClassification {
  instance: string;
  known: number;
  cold: number;
  groups: number;
}

export type SettingsPatch = Partial<
  Omit<ServerSettings, 'apikeySet' | 'apikeyHint' | 'timezone' | 'serverTime'> & { apikey: string }
>;

/** Per-person notification preferences (each agent sets their own). */
export interface NotifyPrefs {
  groups: boolean;
  dms: boolean;
  jobsEnded: boolean;
  jobsFailuresOnly: boolean;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  keywords: string;
}

/** Per-person nav tab order (main bar vs. "More"), each agent sets their own. */
export interface ToolbarPrefs {
  order: string[];
}

export const api = {
  health: () => get<{ ok: boolean; mode: string; version: string }>('/api/health'),

  // Per-line, so the header switcher's channel is the one being reported on.
  sendingLimits: () => iget<SendingLimits>('/api/sending-limits'),
  classifyRecipients: (recipients: Recipient[]) =>
    ipost<RecipientClassification>('/api/sending-limits/classify', {
      recipients: recipients.map((r) => r.id),
    }),

  settings: {
    get: () => get<ServerSettings>('/api/settings'),
    save: (patch: SettingsPatch) => put<ServerSettings>('/api/settings', patch),
    test: (candidate: { base?: string; instance?: string; apikey?: string }) =>
      post<{ ok: boolean; instances?: number; instanceFound?: boolean; error?: string }>(
        '/api/settings/test',
        candidate,
      ),
  },

  notifyPrefs: {
    get: () => get<NotifyPrefs>('/api/notify-prefs'),
    save: (patch: Partial<NotifyPrefs>) => put<NotifyPrefs>('/api/notify-prefs', patch),
  },

  toolbarPrefs: {
    get: () => get<ToolbarPrefs>('/api/toolbar-prefs'),
    save: (order: string[]) => put<ToolbarPrefs>('/api/toolbar-prefs', { order }),
  },

  push: {
    // endpoint targets this device exactly; the server falls back to the
    // caller's identity when it's absent.
    test: (endpoint?: string) =>
      post<{ sent: number }>('/api/push/test', endpoint ? { endpoint } : {}),
  },

  jobs: {
    list: () => iget<Job[]>('/api/jobs'),
    page: (
      scope: JobScope,
      opts: { status?: JobStatus; limit?: number; offset?: number; q?: string; sort?: 'asc' | 'desc' } = {},
    ) => {
      const q = new URLSearchParams({ scope, limit: String(opts.limit ?? 50), offset: String(opts.offset ?? 0) });
      if (opts.status) q.set('status', opts.status);
      if (opts.q?.trim()) q.set('q', opts.q.trim());
      if (opts.sort) q.set('sort', opts.sort);
      return iget<JobPage>(`/api/jobs?${q}`);
    },
    // Job counts per day (History) for the volume-strip navigation aid.
    // tz: minutes to add to UTC to reach the browser's local time, so "day"
    // matches the same local day the list itself groups by.
    volume: (days = 30) => {
      const tz = -new Date().getTimezoneOffset();
      return iget<JobVolumeDay[]>(`/api/jobs/volume?scope=history&days=${days}&tz=${tz}`);
    },
    get: (id: string) => get<Job>(`/api/jobs/${encodeURIComponent(id)}`),
    // New jobs are pinned to the active instance; edits keep the job's own
    // (the server preserves a stored instance when the field is absent).
    save: (job: Partial<Job> & Pick<Job, 'scheduledAt' | 'recipients' | 'items'>) =>
      post<Job>('/api/jobs', job.id || !getActiveInstance() ? job : { ...job, instance: getActiveInstance() }),
    sends: (id: string) => get<JobSend[]>(`/api/jobs/${encodeURIComponent(id)}/sends`),
    // One page of the ledger, filtered server-side — the campaign panel's view
    // of a job whose ledger is thousands of rows long.
    sendsPage: (
      id: string,
      opts: { status?: SendStatus; q?: string; limit?: number; offset?: number } = {},
    ) => {
      const q = new URLSearchParams({
        limit: String(opts.limit ?? 100),
        offset: String(opts.offset ?? 0),
      });
      if (opts.status) q.set('status', opts.status);
      if (opts.q?.trim()) q.set('q', opts.q.trim());
      return get<{ sends: JobSend[]; total: number }>(
        `/api/jobs/${encodeURIComponent(id)}/sends/page?${q}`,
      );
    },
    progress: (id: string) =>
      get<CampaignProgress>(`/api/jobs/${encodeURIComponent(id)}/progress`),
    pause: (id: string) => post<Job>(`/api/jobs/${encodeURIComponent(id)}/pause`),
    retryFailed: (id: string) =>
      post<{ retried: number; job: Job }>(`/api/jobs/${encodeURIComponent(id)}/retry-failed`),
    resume: (id: string) => post<Job>(`/api/jobs/${encodeURIComponent(id)}/resume`),
    cancel: (id: string) => post<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`),
    restore: (id: string) => post<Job>(`/api/jobs/${encodeURIComponent(id)}/restore`),
    rerun: (id: string) => post<Job>(`/api/jobs/${encodeURIComponent(id)}/rerun`),
    approve: (id: string) => post<Job>(`/api/jobs/${encodeURIComponent(id)}/approve`),
    reject: (id: string, reason?: string) =>
      post<Job>(`/api/jobs/${encodeURIComponent(id)}/reject`, { reason }),
    // carries the ledger table's filter, so the download is what is on screen
    ledgerCsvUrl: (id: string, opts: { status?: SendStatus; q?: string } = {}) => {
      const q = new URLSearchParams();
      if (opts.status) q.set('status', opts.status);
      if (opts.q?.trim()) q.set('q', opts.q.trim());
      const qs = q.toString();
      return `/api/jobs/${encodeURIComponent(id)}/ledger.csv${qs ? `?${qs}` : ''}`;
    },
    /** Save the failed + not-yet-sent recipients as a list, to send to later. */
    unsentList: (id: string, name?: string) =>
      post<{ list: RecipientList; members: number; invalid: string[] }>(
        `/api/jobs/${encodeURIComponent(id)}/unsent-list`,
        name ? { name } : {},
      ),
    // The recipients behind one ledger status chip, names filled in — feeds
    // "open Compose to just these" straight from the ledger.
    recipientsByStatus: (id: string, status: SendStatus) =>
      get<{ recipients: Recipient[] }>(
        `/api/jobs/${encodeURIComponent(id)}/recipients?status=${status}`,
      ),
    /** The "create as a list" counterpart — same status chip, saved instead of composed. */
    statusList: (id: string, status: SendStatus, name?: string) =>
      post<{ list: RecipientList; members: number; invalid: string[] }>(
        `/api/jobs/${encodeURIComponent(id)}/status-list`,
        name ? { status, name } : { status },
      ),
    remove: (id: string) => del<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}`),
    clearDone: (scope?: JobScope) =>
      post<{ ok: boolean; removed: number }>('/api/jobs/clear-done', scope ? { scope } : {}),
    bulkDelete: (ids: string[]) =>
      post<{ ok: boolean; removed: number }>('/api/jobs/bulk-delete', { ids }),
  },

  lists: {
    list: () => get<RecipientList[]>('/api/lists'),
    get: (id: string) =>
      get<RecipientList & { members: ListMember[] }>(`/api/lists/${encodeURIComponent(id)}`),
    // `recipe` rides along with the members it produced (null = a plain list).
    create: (
      name: string,
      members: Array<Partial<ListMember>> = [],
      recipe: ListRecipe | null = null,
    ) =>
      post<RecipientList & { members: number; invalid: string[] }>('/api/lists', {
        name,
        members,
        recipe,
      }),
    update: (
      id: string,
      patch: { name?: string; members?: Array<Partial<ListMember>>; recipe?: ListRecipe | null },
    ) =>
      put<RecipientList & { members: number; invalid: string[] }>(
        `/api/lists/${encodeURIComponent(id)}`,
        patch,
      ),
    remove: (id: string) => del<{ ok: boolean }>(`/api/lists/${encodeURIComponent(id)}`),
  },

  // Quick replies are per-instance: list filters by the active line, and a new
  // reply (single or bulk import) is pinned to it. Update/delete are id-scoped.
  quickReplies: {
    list: () => iget<ServerQuickReply[]>('/api/quick-replies'),
    // Admin manage view: every instance + every owner, no instance filter.
    // The server falls back to the scoped roster without agents.manage.
    listAll: () => get<ServerQuickReply[]>('/api/quick-replies?scope=all'),
    create: (shortcut: string, text: string, personal = false, media?: QuickReplyMediaInput | null) =>
      ipost<ServerQuickReply>('/api/quick-replies', { shortcut, text, personal, media }),
    importMany: (rows: Array<{ shortcut: string; text: string }>) =>
      ipost<{ ok: boolean; added: number }>('/api/quick-replies', { rows }),
    // media: omit to leave unchanged, null to clear, a value to replace.
    update: (
      id: number,
      patch: { shortcut?: string; text?: string; media?: QuickReplyMediaInput | null },
    ) => put<ServerQuickReply>(`/api/quick-replies/${id}`, patch),
    // The sendable bytes/URL — fetched only when staging a media reply to send.
    media: (id: number) => get<ResolvedQuickReplyMedia>(`/api/quick-replies/${id}/media`),
    remove: (id: number) => del<{ ok: boolean }>(`/api/quick-replies/${id}`),
  },

  // Insights are per-instance (header switcher); withInstance() appends ?instance=.
  analytics: (range: AnalyticsRange = { days: 30 }) =>
    iget<AnalyticsSummary>(`/api/analytics/summary?${rangeQuery(range)}`),
  agentInsights: (range: AnalyticsRange = { days: 30 }) =>
    iget<{ days: number; agents: AgentInsightsRow[] }>(`/api/analytics/agents?${rangeQuery(range)}`),
  analyticsCsvUrl: (range: AnalyticsRange = { days: 30 }) =>
    withInstance(`/api/analytics/export.csv?${rangeQuery(range)}`),

  me: () => get<Me>('/api/me'),

  agents: {
    list: () => get<Agent[]>('/api/agents'),
    update: (
      email: string,
      patch: {
        name?: string;
        color?: string;
        active?: boolean;
        role?: AgentRole;
        perms?: Partial<Perms>;
        instances?: string[] | null;
      },
    ) => put<Agent>(`/api/agents/${encodeURIComponent(email)}`, patch),
  },

  instances: {
    list: () => get<{ default: string; instances: InstanceInfo[] }>('/api/instances'),
  },

  maintenance: {
    get: () => get<MaintenanceReport>('/api/maintenance'),
    cleanup: (olderThanDays: number, opts: { dryRun?: boolean; vacuum?: boolean } = {}) =>
      post<CleanupResult>('/api/maintenance/cleanup', { olderThanDays, ...opts }),
  },

  chatMeta: {
    get: () => get<ChatMeta>('/api/chat-meta'),
    syncAliases: (pairs: Array<[string, string]>) =>
      post<{ ok: boolean; learned: number; aliases: Record<string, string> }>('/api/chat-aliases', { pairs }),
    assign: (jid: string, agentEmail: string | null) =>
      post<{ ok: boolean; jid: string }>('/api/chats/assign', { jid, agentEmail }),
    setStatus: (jid: string, status: ChatWorkStatus) =>
      post<{ ok: boolean; jid: string }>('/api/chats/status', { jid, status }),
    setTags: (jid: string, tags: string[]) =>
      post<{ ok: boolean; jid: string; tags: string[] }>('/api/chats/tags', { jid, tags }),
    byTag: (tag: string) => get<{ tag: string; jids: string[] }>(`/api/chats/by-tag?tag=${encodeURIComponent(tag)}`),
    notes: (jid: string) => get<ChatNote[]>(`/api/chats/notes?jid=${encodeURIComponent(jid)}`),
    addNote: (jid: string, body: string) => post<ChatNote>('/api/chats/notes', { jid, body }),
    removeNote: (id: number) => del<{ ok: boolean }>(`/api/chats/notes/${id}`),
  },

  agentPresence: (tabId: string, chatJid: string, typing: boolean) =>
    post<{ ok: boolean }>('/api/agent-presence', { tabId, chatJid, typing }),

  reminders: {
    list: () => get<Reminder[]>('/api/reminders'),
    create: (chatJid: string, dueAt: string, note: string) =>
      post<Reminder>('/api/reminders', { chatJid, dueAt, note }),
    dismiss: (id: number) => post<Reminder>(`/api/reminders/${id}/dismiss`),
    remove: (id: number) => del<{ ok: boolean }>(`/api/reminders/${id}`),
  },

  messageAgents: (ids: string[]) => post<MessageAgents>('/api/message-agents', { ids }),

  blacklist: {
    list: () => get<BlacklistEntry[]>('/api/blacklist'),
    add: (entry: { phone_number: string; name?: string; why_blacklisted?: string }) =>
      post<{ ok: boolean; added: number; invalid: string[] }>('/api/blacklist', entry),
    addMany: (rows: Array<{ phone_number: string; name?: string; why_blacklisted?: string }>) =>
      post<{ ok: boolean; added: number; invalid: string[] }>('/api/blacklist', { rows }),
    update: (phone: string, patch: Partial<Pick<BlacklistEntry, 'phone_number' | 'name' | 'why_blacklisted'>>) =>
      put<BlacklistEntry>(`/api/blacklist/${encodeURIComponent(phone)}`, patch),
    remove: (phone: string) => del<{ ok: boolean }>(`/api/blacklist/${encodeURIComponent(phone)}`),
    removeMany: (phones: string[]) =>
      post<{ ok: boolean; removed: number }>('/api/blacklist/delete', { phones }),
  },

  // The dead-number cache (see types.ts#VerificationEntry). Instance-free like
  // the blacklist: a number is on WhatsApp or it isn't, whichever line asked.
  verification: {
    list: (opts: { status?: VerifyStatus; q?: string; limit?: number; offset?: number } = {}) => {
      const qs = new URLSearchParams();
      if (opts.status) qs.set('status', opts.status);
      if (opts.q) qs.set('q', opts.q);
      qs.set('limit', String(opts.limit ?? 100));
      qs.set('offset', String(opts.offset ?? 0));
      return get<VerificationPage>(`/api/verification?${qs}`);
    },
    check: (numbers: string[]) => post<VerificationSweep>('/api/verification/check', { numbers }),
    remove: (phone: string) =>
      del<{ ok: boolean; removed: number }>(`/api/verification/${encodeURIComponent(phone)}`),
    clear: (status?: VerifyStatus) =>
      post<{ ok: boolean; cleared: number }>('/api/verification/clear', status ? { status } : {}),
  },

  send: (recipient: string, item: JobItem, isGroup = false) =>
    ipost<SendResult>(
      '/api/send',
      { recipient, item, isGroup },
      // media/voice carry large base64 uploads that legitimately exceed 25s
      { timeoutMs: item.type === 'media' || item.type === 'voice' ? 60_000 : 25_000 },
    ),

  chats: {
    list: () => iget<EvoChat[]>('/api/chats'),
    contacts: () => iget<EvoChat[]>('/api/contacts'),
    groups: () => iget<EvoChat[]>('/api/groups'),
    messages: (remoteJid: string, page = 1) =>
      ipost<unknown>('/api/messages/find', { remoteJid, page }),
    markRead: (readMessages: Array<{ remoteJid: string; fromMe: boolean; id: string }>) =>
      ipost<unknown>('/api/chats/read', { readMessages }),
    // List-level mark-as-read: no message ids in hand, just clear the shared badge.
    markChatRead: (chat: string) => ipost<unknown>('/api/chats/read', { chat }),
    markUnread: (chat: string, lastMessage?: unknown) =>
      ipost<unknown>('/api/chats/unread', { chat, lastMessage }),
    archive: (chat: string, archive = true) => ipost<unknown>('/api/chats/archive', { chat, archive }),
    block: (number: string, status: 'block' | 'unblock') =>
      ipost<unknown>('/api/contacts/block', { number, status }),
  },

  messages: {
    edit: (remoteJid: string, messageId: string, text: string) =>
      ipost<unknown>('/api/messages/edit', { remoteJid, messageId, text }),
    delete: (remoteJid: string, messageId: string, fromMe = true, participant?: string) =>
      ipost<unknown>('/api/messages/delete', {
        remoteJid,
        messageId,
        fromMe,
        ...(participant ? { participant } : {}),
      }),
  },

  groups: {
    create: (subject: string, participants: string[], description?: string) =>
      ipost<Record<string, any>>('/api/groups/create', { subject, participants, description }),
    info: (jid: string) => iget<Record<string, any>>(`/api/groups/info?jid=${encodeURIComponent(jid)}`),
    participants: (jid: string, action: 'add' | 'remove' | 'promote' | 'demote', participants: string[]) =>
      ipost<unknown>('/api/groups/participants', { jid, action, participants }),
    subject: (jid: string, subject: string) => ipost<unknown>('/api/groups/subject', { jid, subject }),
    description: (jid: string, description: string) =>
      ipost<unknown>('/api/groups/description', { jid, description }),
    picture: (jid: string, image: string) => ipost<unknown>('/api/groups/picture', { jid, image }),
    setting: (jid: string, action: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') =>
      ipost<unknown>('/api/groups/setting', { jid, action }),
    ephemeral: (jid: string, expiration: number) =>
      ipost<unknown>('/api/groups/ephemeral', { jid, expiration }),
    invite: (jid: string) => iget<Record<string, any>>(`/api/groups/invite?jid=${encodeURIComponent(jid)}`),
    revokeInvite: (jid: string) => ipost<Record<string, any>>('/api/groups/invite/revoke', { jid }),
    leave: (jid: string) => ipost<unknown>('/api/groups/leave', { jid }),
  },

  profile: {
    fetch: () => iget<Record<string, any>>('/api/profile'),
    setName: (name: string) => iput<unknown>('/api/profile/name', { name }),
    setStatus: (status: string) => iput<unknown>('/api/profile/status', { status }),
    setPicture: (picture: string) => iput<unknown>('/api/profile/picture', { picture }),
    removePicture: () => idel<unknown>('/api/profile/picture'),
    privacy: () => iget<Record<string, any>>('/api/profile/privacy'),
    setPrivacy: (privacy: Record<string, string>) => iput<unknown>('/api/profile/privacy', privacy),
  },

  media: (message: { key: { id: string; remoteJid: string; fromMe: boolean } }) =>
    ipost<Record<string, any>>('/api/media', { message }),

  presence: (number: string, presence: string, delay?: number) =>
    ipost<unknown>('/api/presence', { number, presence, delay }),
};
