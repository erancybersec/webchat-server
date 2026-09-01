export type JobStatus =
  | 'pending'
  | 'pending_approval'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'missed';

/** One thing to send: { type: 'text'|'media'|'image'|'voice'|'poll'|'buttons', data: {...} } */
export interface JobItem {
  type: string;
  data: Record<string, unknown>;
}

/** A send target: phone number or JID; groups are flagged explicitly. */
export interface Recipient {
  id: string;
  isGroup?: boolean;
  /** Display name — feeds {{name}} personalization at send time. */
  name?: string;
}

export type RepeatFreq = 'daily' | 'weekly' | 'monthly';

/** Recurrence rule. The scheduler clones the job forward when it finishes. */
export interface RepeatRule {
  freq: RepeatFreq;
  /** ISO date-time; no occurrence is created at or after this moment. */
  until?: string;
}

/**
 * How a campaign is paced. Two INDEPENDENT halves — a rule may use either or
 * both, and whichever comes first stops the run:
 *
 * 1. **A sending window.** `pauseAt` ('HH:MM', server-local) is a cutoff: the
 *    next occurrence of that clock time is fixed when the run starts, and
 *    crossing it stops the campaign. It is re-queued for the next `resumeAt`
 *    when one is set, otherwise it goes 'paused' and waits for a human. A
 *    resumed run recomputes the cutoff, so continuing past it by hand always
 *    works ("run until 21:00, continue at 09:00").
 * 2. **Batches.** `size` wire attempts per batch (a blacklist skip sent nothing,
 *    so it costs nothing). When a batch fills: `pauseMin > 0` re-queues the job
 *    that many minutes later unattended, `pauseMin = 0` goes 'paused'.
 *
 * Either way the job leaves 'running' WITHOUT finalizing, and its ledger holds
 * the rest — so continuing resumes exactly where it stopped.
 */
export interface BatchRule {
  /** Absent = no batch boundary; the window (or the whole job) decides. */
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
  /** Per-compose override of the delay between messages for this run only, in
   *  seconds — replaces the Settings default outright. Presence = override is on. */
  delay?: { minSec: number; maxSec: number };
}

/** Wire shape of a job (what clients read/write). */
export interface Job {
  id: string;
  scheduledAt: string;
  status: JobStatus;
  type: string | null;
  recipients: Recipient[];
  items: JobItem[];
  result: string | null;
  createdAt: string;
  /** Set when the scheduler first claims the job — survives crash recovery. */
  startedAt: string | null;
  ranAt: string | null;
  repeat: RepeatRule | null;
  /** Agent email (Cloudflare Access identity); null = tracking was off. */
  sentBy: string | null;
  /** Evolution instance to send through; null = the default at run time. */
  instance: string | null;
  /** Batch pacing / clock cutoff; null = send in one run (the default). */
  batch: BatchRule | null;
}

/**
 * The two job lists the UI shows. 'scheduled' = upcoming queue (pending,
 * running, cancelled — excluding immediate sends); 'history' = the record of
 * everything composed (finished jobs + all immediate "send now" jobs).
 */
export type JobScope = 'scheduled' | 'history';

/** One page of a scope: rows + counts over the whole scope for filter chips. */
export interface JobPage {
  jobs: Job[];
  total: number;
  counts: Partial<Record<JobStatus, number>>;
}

export type SendStatus = 'pending' | 'sent' | 'skipped' | 'failed';

/** One row of the per-recipient send ledger. */
export interface JobSend {
  jobId: string;
  recipient: string;
  isGroup: boolean;
  itemIndex: number;
  status: SendStatus;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  /** Evolution message id of the sent row — the key acks match against. */
  messageId: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

/**
 * A campaign's state, read from the ledger rather than from in-flight counters
 * — so it is exact after a page refresh, a server restart, or a pause that
 * spans days. `nextRunAt` is when an unattended batch resumes; `ratePerMin` and
 * `etaMinutes` are null until enough has been sent to measure.
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
  /**
   * Why the campaign stopped short, in the scheduler's own words — the daily
   * cold-contact cap, a dead line, a batch boundary, an operator's pause.
   * null once it is running again or finished.
   */
  holdReason: string | null;
}

export interface BlacklistEntry {
  id: number;
  phone_number: string;
  name: string;
  added_date: string;
  why_blacklisted: string;
}

/** One source list in a recipe. `name` is only a label for a deleted source. */
export interface ListRecipeSource {
  id: string;
  name: string;
}

/**
 * How a "combined" list was built: union every `include`, then subtract every
 * `exclude`. Members are still materialized rows — this is the recipe kept so
 * the editor can show it and Rebuild can re-run it. Order is irrelevant.
 */
export interface ListRecipe {
  v: 1;
  include: ListRecipeSource[];
  exclude: ListRecipeSource[];
}

/** A saved audience: name + members, pickable as recipients in Compose. */
export interface RecipientList {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
  /** null for a hand-made list; set when the members came from other lists. */
  recipe: ListRecipe | null;
  /** Instance names this list is visible on; null = every line. */
  lineScope: string[] | null;
  /** Email of the agent who created it; null = predates this column / agent id off. */
  createdBy: string | null;
}

export interface ListMember {
  recipient: string;
  isGroup: boolean;
  name: string;
}

/** Lightweight media descriptor on a quick reply (never carries the bytes). */
export interface QuickReplyMedia {
  /** 'file' = uploaded, bytes stored server-side; 'url' = hosted elsewhere. */
  kind: 'file' | 'url';
  mediatype: 'image' | 'video' | 'audio' | 'document';
  mimetype: string;
  filename?: string;
  /** url-kind only — where the bytes live. */
  url?: string;
}

export interface QuickReply {
  id: number;
  shortcut: string;
  text: string;
  /** Owner of a personal reply; null = shared with the whole team. */
  agentEmail: string | null;
  /** Evolution line this reply belongs to; null = the default instance. */
  instance: string | null;
  /** Optional attached media (sent with `text` as caption); null = text-only. */
  media: QuickReplyMedia | null;
}
