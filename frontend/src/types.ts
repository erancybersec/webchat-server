// Mirrors backend/src/types.ts — the /api wire contract.

export type JobStatus =
  | 'pending'
  | 'pending_approval'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'missed';

export interface JobItem {
  type: string;
  data: Record<string, unknown>;
}

export interface Recipient {
  id: string;
  isGroup?: boolean;
  /** Display name — feeds {{name}} personalization at send time. */
  name?: string;
}

export type RepeatFreq = 'daily' | 'weekly' | 'monthly';

export interface RepeatRule {
  freq: RepeatFreq;
  until?: string;
}

/**
 * Campaign pacing (Compose → Pacing). Two independent halves; whichever comes
 * first stops the run, and the ledger holds the rest either way:
 * - **A sending window**: `pauseAt` ('HH:MM') stops the campaign when the clock
 *   reaches that hour, `resumeAt` picks it up again — absent, it waits for a
 *   human Continue.
 * - **Batches**: `size` messages per batch, then `pauseMin > 0` continues by
 *   itself that many minutes later, `0` waits for Continue.
 */
export interface BatchRule {
  /** Absent = no batch boundary (the window, or nothing, paces it). */
  size?: number;
  pauseMin: number;
  /** Upper end of a randomized batch wait — a fresh value in [pauseMin, pauseMinMax]
   *  is picked at each boundary. Requires pauseMin > 0 (a manual wait can't be randomized). */
  pauseMinMax?: number;
  pauseAt?: string;
  resumeAt?: string;
  /** Per-compose override of the line's cold-contact ceiling for this run only — a
   *  flat daily cap, replacing the warm-up ramp outright. Presence = override is on. */
  coldCap?: { dailyCap: number };
}

export interface Job {
  id: string;
  scheduledAt: string;
  status: JobStatus;
  type: string | null;
  recipients: Recipient[];
  items: JobItem[];
  result: string | null;
  createdAt: string;
  /** Set when the scheduler first claimed it — the campaign's start, kept
   * across batch pauses and crash recovery. */
  startedAt: string | null;
  ranAt: string | null;
  repeat: RepeatRule | null;
  /** Agent email (Cloudflare Access identity); null = tracking was off. */
  sentBy: string | null;
  /** Evolution instance to send through; null = the default at run time. */
  instance: string | null;
  /** Batch pacing; null = one unbroken run. */
  batch: BatchRule | null;
}

export type AgentRole = 'admin' | 'agent';

export type PermissionKey =
  | 'settings.manage'
  | 'insights.view'
  | 'insights.viewOwn'
  | 'agents.manage'
  | 'jobs.sendWithoutApproval'
  | 'jobs.approve'
  | 'jobs.clearHistory';

export type Perms = Record<PermissionKey, boolean>;

/** A sales agent, auto-provisioned from the Cloudflare Access Google login. */
export interface Agent {
  email: string;
  name: string;
  color: string;
  active: boolean;
  role: AgentRole;
  /** Explicit grants/denies stored on the agent (a diff over role defaults). */
  perms: Partial<Perms>;
  /** The resolved permission map the server enforces. */
  effectivePerms: Perms;
  /** Evolution instance grants; null/empty = the Settings default only. */
  instances: string[] | null;
  createdAt: string;
  lastSeenAt: string;
}

/** The signed-in agent (GET /api/me). email is null while the toggle is off. */
export interface Me {
  enabled: boolean;
  email: string | null;
  name: string;
  color: string;
  /** null = no Access identity (toggle off / LAN) → unrestricted. */
  role: AgentRole | null;
  /** Effective permissions; null = unrestricted (mirrors the server). */
  perms: Perms | null;
  /** Instances this agent may use; null = all of them. */
  instances: string[] | null;
  /** The Settings default instance. */
  defaultInstance: string;
}

/** One Evolution instance as served by GET /api/instances. */
export interface InstanceInfo {
  name: string;
  connectionStatus: string;
  profileName: string;
  number: string;
  /** insights.view holders only — the storage telemetry. */
  counts?: { messages: number; contacts: number; chats: number } | null;
  disconnectedAt?: string | null;
}

export interface MaintenanceReport {
  disk: { totalBytes: number; freeBytes: number } | null;
  db: { sizeBytes: number; walBytes: number };
  tables: Record<string, number>;
  statsSince: string | null;
  evolution: Array<{
    name: string;
    connectionStatus: string;
    counts: { messages: number; contacts: number; chats: number } | null;
    disconnectedAt: string | null;
  }> | null;
  evolutionError: string | null;
  retentionDays: number;
  defaultInstance: string;
}

export interface CleanupResult {
  dryRun: boolean;
  olderThanDays: number;
  jobs: number;
  sends: number;
  messageAgents: number;
  messageCache: number;
  messageEdits: number;
  reminders: number;
  bytesBefore: number;
  bytesAfter: number;
  vacuumed: boolean;
  note?: string;
}

/** Evolution message id → agent, for chat-bubble badges. */
export interface AgentTag {
  email: string;
  name: string;
  color: string;
}
/** message id → who sent it (badge) and, when touched via the app, who deleted/edited it. */
export type MessageAgents = Record<
  string,
  AgentTag & { deletedBy?: AgentTag; deletedAt?: string; editedBy?: AgentTag }
>;

/** 'scheduled' = upcoming queue; 'history' = finished jobs + immediate sends. */
export type JobScope = 'scheduled' | 'history';

/** One page of a scope: rows + counts over the whole scope for filter chips. */
export interface JobPage {
  jobs: Job[];
  total: number;
  counts: Partial<Record<JobStatus, number>>;
}

/** One day's job count — feeds the History volume strip. */
export interface JobVolumeDay {
  day: string;
  count: number;
}

export type SendStatus = 'pending' | 'sent' | 'skipped' | 'failed';

/**
 * A cached answer from WhatsApp about whether a number is registered. NOT the
 * blacklist — that is a policy a person authored; this is an observation that
 * expires and can be wrong (WhatsApp answers exists:false while throttling).
 */
export type VerifyStatus = 'valid' | 'invalid';

export interface VerificationEntry {
  phone_number: string;
  status: VerifyStatus;
  checked_at: string;
  expires_at: string;
  instance: string;
  jid: string | null;
  wa_name: string | null;
}

export interface VerificationPage {
  rows: VerificationEntry[];
  total: number;
  counts: { valid: number; invalid: number };
}

export interface VerificationSweep {
  ok: boolean;
  requested: number;
  cached: number;
  checked: number;
  valid: number;
  invalid: number;
  discarded: number;
  tripped: boolean;
  aborted?: string;
}

export interface JobSend {
  jobId: string;
  recipient: string;
  isGroup: boolean;
  itemIndex: number;
  status: SendStatus;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  messageId: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

/** Live job progress pushed over the SSE relay while a job runs. */
export interface JobProgress {
  jobId: string;
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  done: boolean;
  status?: JobStatus;
  /** Set when a campaign stepped out of a run without finishing. */
  pending?: number;
  /** When an unattended batch pause ends; null = waiting for a human. */
  nextRunAt?: string | null;
  /** Why it stopped short, in words the operator can act on. */
  holdReason?: string;
}

/**
 * A campaign's state read off the send ledger — exact after a refresh, a server
 * restart, or a pause of days, unlike the in-flight SSE counters.
 */
export interface CampaignProgress {
  jobId: string;
  status: JobStatus;
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  pending: number;
  /** Distinct recipients per status — a sequence's message count double-counts a recipient with several items in that status. */
  contacts: Record<SendStatus, number>;
  /** Distinct recipients across failed+pending — what unsent-list actually saves; not contacts.failed + contacts.pending, which double-counts anyone in both. */
  notSentContacts: number;
  startedAt: string | null;
  firstSentAt: string | null;
  lastSentAt: string | null;
  ratePerMin: number | null;
  etaMinutes: number | null;
  batch: BatchRule | null;
  nextRunAt: string | null;
  /** Why it stopped short — the cold-contact cap, a dead line, a batch boundary. */
  holdReason: string | null;
}

/** One source list in a recipe. `name` is only a label for a deleted source. */
export interface ListRecipeSource {
  id: string;
  name: string;
}

/**
 * How a combined list was built: union every `include`, then subtract every
 * `exclude`. The members it produced are stored as ordinary rows; this is kept
 * so the editor can show the recipe and Rebuild can re-run it.
 */
export interface ListRecipe {
  v: 1;
  include: ListRecipeSource[];
  exclude: ListRecipeSource[];
}

export interface RecipientList {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
  /** null for a hand-made list; set when the members came from other lists. */
  recipe: ListRecipe | null;
}

export interface ListMember {
  recipient: string;
  isGroup: boolean;
  name: string;
}

/** Lightweight media descriptor returned with a quick reply (never the bytes). */
export interface QuickReplyMedia {
  kind: 'file' | 'url';
  mediatype: 'image' | 'video' | 'audio' | 'document';
  mimetype: string;
  filename?: string;
  /** url-kind only. */
  url?: string;
}

/** Media as sent on create/update — file-kind carries the base64 bytes. */
export interface QuickReplyMediaInput {
  kind: 'file' | 'url';
  mediatype: QuickReplyMedia['mediatype'];
  mimetype: string;
  filename?: string;
  url?: string;
  base64?: string;
}

export interface ServerQuickReply {
  id: number;
  shortcut: string;
  text: string;
  /** Owner of a personal reply; null = shared with the whole team. */
  agentEmail: string | null;
  /** Evolution line this reply belongs to; null = the default instance. */
  instance: string | null;
  /** Attached media sent with `text` as caption; null = text-only. */
  media: QuickReplyMedia | null;
}

/** The sendable media for a reply (GET /api/quick-replies/:id/media). */
export interface ResolvedQuickReplyMedia {
  mediatype: QuickReplyMedia['mediatype'];
  mimetype: string;
  filename?: string;
  base64: string | null;
  url: string | null;
}

// ---- v2.8 agent workbench ------------------------------------------------

export type ChatWorkStatus = 'open' | 'pending' | 'resolved';

export interface ChatMeta {
  assignments: Record<string, { agentEmail: string; assignedBy: string; assignedAt: string }>;
  statuses: Record<string, { status: ChatWorkStatus; changedBy: string; changedAt: string }>;
  tags: Record<string, string[]>;
  allTags: string[];
  /** alt jid → canonical jid (the key chat meta rows are stored under). */
  aliases: Record<string, string>;
}

export interface ChatNote {
  id: number;
  chatJid: string;
  agentEmail: string;
  body: string;
  createdAt: string;
}

export interface Reminder {
  id: number;
  chatJid: string;
  agentEmail: string;
  dueAt: string;
  note: string;
  status: 'pending' | 'fired' | 'dismissed';
  createdAt: string;
}

/** One agent viewing/typing in a chat right now (AGENT_PRESENCE event). */
export interface AgentPresenceEntry {
  email: string;
  chatJid: string;
  typing: boolean;
}

export interface AgentInsightsRow {
  email: string;
  name: string;
  color: string;
  jobSent: number;
  jobFailed: number;
  jobSkipped: number;
  jobDelivered: number;
  jobRead: number;
  chatSends: number;
  chatsTouched: number;
  perDay: Array<{ day: string; sent: number }>;
  /** Sends bucketed by hour-of-day (UTC), 24 slots — chat + completed job sends. */
  perHour: number[];
}

/** Relay-fed chat traffic counters (tracked from v2.9 onward). */
export interface ActivitySummary {
  perDay: Array<{ day: string; inbound: number; outbound: number; chats: number }>;
  totals: { inbound: number; outbound: number; chats: number };
  /** First day data exists for — "tracked since". */
  since: string | null;
}

export interface AnalyticsSummary {
  days: number;
  /** the resolved window (YYYY-MM-DD, inclusive) the server actually used */
  from?: string;
  to?: string;
  perDay: Array<{ day: string; sent: number; failed: number; skipped: number }>;
  /** Windowed job-send outcomes (sent/failed/skipped/delivered/read) for the range. */
  totals: { sent: number; failed: number; skipped: number; delivered: number; read: number };
  /** All-time outcomes for the footer line. */
  allTime: { sent: number; failed: number };
  /** Mean delivery/read latency of the window's job sends, in seconds (null = no acks). */
  latency: { deliverSec: number | null; readSec: number | null };
  /** Same metrics over the immediately-preceding equal-length window — for trend deltas. */
  prev: {
    sent: number;
    failed: number;
    skipped: number;
    delivered: number;
    read: number;
    inbound: number | null;
    outbound: number | null;
    chats: number | null;
    blacklistAdded: number;
  };
  activity: ActivitySummary | null;
  jobs: Partial<Record<JobStatus, number>>;
  topErrors: Array<{ error: string; count: number }>;
  blacklist: { total: number; added: number };
}

export interface BlacklistEntry {
  id: number;
  phone_number: string;
  name: string;
  added_date: string;
  why_blacklisted: string;
}

export interface SendResult {
  ok: boolean;
  routed: 'evo' | 'skipped';
  skipped: boolean;
  /** Evolution message id of the sent message; null when skipped/unavailable. Lets the client reconcile an optimistic bubble by id. */
  messageId?: string | null;
}

/** Evolution chat/message records pass through the gateway loosely typed. */
export type EvoChat = Record<string, any>;
export type EvoMessage = Record<string, any>;
