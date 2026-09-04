import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { registerAgents } from './routes/agents.js';
import { registerAiAgent } from './routes/aiagent.js';
import { registerAnalytics } from './routes/analytics.js';
import { registerBlacklist } from './routes/blacklist.js';
import { registerChats } from './routes/chats.js';
import { registerEvents } from './routes/events.js';
import { registerGateway } from './routes/gateway.js';
import { registerGroups } from './routes/groups.js';
import { registerInstances } from './routes/instances.js';
import { registerJobs } from './routes/jobs.js';
import { registerLists } from './routes/lists.js';
import { registerMaintenance } from './routes/maintenance.js';
import { registerProfile } from './routes/profile.js';
import { registerMeta } from './routes/meta.js';
import { registerPush } from './routes/push.js';
import { registerToolbarPrefs } from './routes/toolbarPrefs.js';
import { registerQuickReplies } from './routes/quickreplies.js';
import { registerReminders } from './routes/reminders.js';
import { registerSending } from './routes/sending.js';
import { registerVerification } from './routes/verification.js';
import { registerSettings } from './routes/settings.js';
import { registerStatic } from './routes/static.js';
import { attachAckTracker } from './services/acks.js';
import { AgentsStore, emailFromRequest } from './services/agents.js';
import {
  AI_AGENT_COLOR,
  AI_AGENT_EMAIL,
  AI_AGENT_NAME,
  AiAgentListener,
  AiAgentRunner,
  AiAgentStore,
  AiAuditLog,
  AiPendingSendStore,
  evolutionThreadReader,
} from './services/aiagent.js';
import { KnowledgeStore } from './services/knowledge.js';
import { StudioDataStore } from './services/studioData.js';
import { requirePerm, type PermissionKey } from './services/authz.js';
import { BlacklistStore } from './services/blacklist.js';
import { VerificationService, VerificationStore } from './services/verification.js';
import { attachChatWatcher, ChatMetaStore } from './services/chatmeta.js';
import { ContactNameResolver } from './services/contacts.js';
import { EventRelay } from './services/events.js';
import { EvolutionClient, type EvolutionApi } from './services/evolution.js';
import {
  attachContactFamiliarity,
  ContactFamiliarityStore,
  seedFamiliarityFromChats,
} from './services/familiarity.js';
import { AiReplyQuota, ColdSendQuota } from './services/quota.js';
import { InstanceAccess, InstancesService } from './services/instances.js';
import { JobStore } from './services/jobs.js';
import { ListsStore } from './services/lists.js';
import { MaintenanceService } from './services/maintenance.js';
import { attachMessageCache, MessageCacheStore } from './services/msgcache.js';
import { attachChatUnread, ChatUnreadStore } from './services/chatunread.js';
import { ReadReceiptStore } from './services/readreceipts.js';
import { attachMessageStats, MessageStatsStore } from './services/msgstats.js';
import { OptOutListener } from './services/optout.js';
import { AgentPresence } from './services/presence.js';
import { NotifyPrefsStore } from './services/notifyprefs.js';
import { ToolbarPrefsStore } from './services/toolbarPrefs.js';
import { attachJobNotifier, attachPushNotifier, PushService } from './services/push.js';
import { QuickRepliesStore } from './services/quickreplies.js';
import { RemindersStore } from './services/reminders.js';
import { Scheduler } from './services/scheduler.js';
import { Sender } from './services/sender.js';
import { SettingsStore } from './services/settings.js';

export interface BuildOptions {
  cfg: Config;
  db: Db;
  /** Override for tests; defaults to a real Evolution client. */
  evo?: EvolutionApi;
  logger?: boolean;
}

export interface App {
  app: FastifyInstance;
  scheduler: Scheduler;
  relay: EventRelay;
  jobs: JobStore;
  blacklist: BlacklistStore;
  /** One-time cold-contact-cap bootstrap; safe to call again (it no-ops). */
  seedFamiliarity: () => Promise<void>;
  /** The AI agent's poller — started in index.ts, driven manually by tests. */
  aiAgent: AiAgentRunner;
  aiAgentStore: AiAgentStore;
}

export async function buildApp(opts: BuildOptions): Promise<App> {
  const { cfg, db } = opts;
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 25 * 1024 * 1024, // base64 media can be large
  });

  const agents = new AgentsStore(db);
  const blacklist = new BlacklistStore(db);
  const jobs = new JobStore(db);
  const lists = new ListsStore(db);
  const quickReplies = new QuickRepliesStore(db);
  const chatMeta = new ChatMetaStore(db);
  const reminders = new RemindersStore(db);
  const presence = new AgentPresence();
  const settings = new SettingsStore(db);
  // Saved operator settings override env config — applied before anything
  // captures cfg.evo so boot-time consumers (EventRelay) see the final values.
  settings.applyTo(cfg);
  const evo = opts.evo ?? new EvolutionClient(cfg.evo);
  // Number verification is a CACHE of what WhatsApp said, kept apart from the
  // blacklist on purpose (migration 019). The sender consults it; campaigns
  // additionally refuse to send to a number it has marked dead.
  const verification = new VerificationService(
    evo,
    new VerificationStore(db),
    cfg,
    (m) => app.log.info(m),
  );
  const sender = new Sender(evo, blacklist, verification);
  // Multi-instance: per-agent grants + the cached safe view of fetchInstances
  const instanceAccess = new InstanceAccess(cfg, agents);
  const instancesService = new InstancesService(evo);
  // Cold-contact cap (migration 020): rations FIRST CONTACT only. Recipients
  // this line already has a thread with, and groups, are never counted —
  // capping conversations you are already in would break the day job without
  // touching the risk, which comes from unsolicited first messages.
  const familiarityStore = new ContactFamiliarityStore(db);
  const coldQuota = new ColdSendQuota(db, cfg);
  const familiarity = {
    classify: (recipient: string, inst: string) =>
      familiarityStore.classify(recipient, inst || cfg.evo.instance),
  };
  // not started here — index.ts starts it after listen (tests drive it manually)
  const relay = new EventRelay(
    { ...cfg.evo, enabled: cfg.eventsEnabled },
    (m) => app.log.info(m),
  );
  const maintenance = new MaintenanceService(
    db,
    cfg.dbPath,
    () => !!db.prepare(`SELECT 1 FROM jobs WHERE status='running' LIMIT 1`).get(),
    (m) => app.log.info(m),
  );
  const scheduler = new Scheduler(
    jobs,
    sender,
    cfg,
    (m) => app.log.info(m),
    // job progress reaches browsers through the same SSE stream as Evolution events
    (event, data) => relay.broadcast({ event, data }),
    new ContactNameResolver(evo),
    agents,
    reminders,
    // retention: cfg is read live, so the Settings field applies on the next tick
    () => {
      if (cfg.retentionDays > 0)
        maintenance.cleanup({ olderThanDays: cfg.retentionDays, gentle: true });
      coldQuota.purge();
    },
    verification,
    {
      familiarity,
      // adapters resolve the blank instance to the Settings default, so the
      // scheduler never has to know which line "" means
      quota: {
        remaining: (inst, override) => coldQuota.remaining(inst || cfg.evo.instance, new Date(), override),
        record: (inst, recipient) => coldQuota.record(inst || cfg.evo.instance, recipient),
      },
      health: {
        isOpen: async (inst) => {
          const want = inst || cfg.evo.instance;
          if (!want) return null;
          const found = (await instancesService.list()).find((i) => i.name === want);
          // an instance we can't find says nothing; only an explicit
          // non-'open' status is treated as "the line is down"
          return found ? found.connectionStatus === 'open' : null;
        },
      },
    },
  );
  const emit = (event: string, data: unknown) => relay.broadcast({ event, data });
  // incoming-event consumers: opt-out keywords, delivery/read acks, message
  // activity counters (Insights), and the chat watcher (jid aliases +
  // auto-reopen of resolved chats on inbound)
  new OptOutListener(cfg, blacklist, sender, (m) => app.log.info(m)).attach(relay);
  // AI agent for inbound leads (migration 024). Read-only: it retrieves
  // knowledge/studio data and can request a human handoff, and has no tool that
  // writes to any business system. The master switch defaults OFF and the line
  // allow-list defaults EMPTY — attaching the listener costs nothing until both
  // are set deliberately in Settings.
  const knowledge = new KnowledgeStore(db);
  const studioData = new StudioDataStore(db);
  const aiQuota = new AiReplyQuota(db, cfg);
  const aiAgentStore = new AiAgentStore(db, (jid) => chatMeta.canon(jid));
  const aiPending = new AiPendingSendStore(db);
  const aiAudit = new AiAuditLog(db);
  // The AI's own sender row, so its messages badge like any other sender's.
  // is_bot keeps it out of the human roster and the assignment picker.
  agents.ensureBot(AI_AGENT_EMAIL, AI_AGENT_NAME, AI_AGENT_COLOR);
  const aiAgent = new AiAgentRunner({
    cfg,
    store: aiAgentStore,
    pending: aiPending,
    audit: aiAudit,
    chatMeta,
    agents,
    sender,
    quota: aiQuota,
    knowledge,
    studio: studioData,
    thread: evolutionThreadReader(evo),
    emit,
    log: (m) => app.log.info(m),
  });
  new AiAgentListener({
    cfg,
    store: aiAgentStore,
    chatMeta,
    pending: aiPending,
    onImmediateHandoff: (jid, inst, reason) => aiAgent.handoffNow(jid, inst, reason),
    emit,
    log: (m) => app.log.info(m),
  }).attach(relay);
  // capture WHEN the recipient reads a sent message (the live ack is the only
  // carrier of the read time — see ReadReceiptStore) and track delivery/read
  // against the job ledger in the same pass.
  const readReceipts = new ReadReceiptStore(db);
  attachAckTracker(relay, jobs, (id) => readReceipts.markRead(id));
  const msgStats = new MessageStatsStore(db);
  attachMessageStats(relay, msgStats, (m) => app.log.info(m));
  // An inbound message is what makes someone "known" to the cold-contact cap.
  // Outbound never promotes a stranger — see ContactFamiliarityStore.
  // canon resolves the @lid every incoming direct message arrives under back to
  // the real number — without it a reply would never mark anyone known
  attachContactFamiliarity(
    relay,
    familiarityStore,
    () => cfg.evo.instance,
    (jid) => chatMeta.canon(jid),
    (m) => app.log.info(m),
  );
  // Snapshot message bodies as they arrive so a delete-for-everyone can still
  // show what it originally said (Evolution nulls the content on its side).
  const msgCache = new MessageCacheStore(db);
  attachMessageCache(relay, msgCache, (m) => app.log.info(m));
  // Shared, server-side unread badges: Evolution's findChats unreadCount is
  // unreliable here, so the relay tracks incoming-per-chat and the read/unread
  // endpoints move the shared cursor — every agent sees the same badge.
  const chatUnread = new ChatUnreadStore(db);
  attachChatUnread(relay, chatUnread, (jid) => chatMeta.canon(jid), (m) => app.log.info(m));
  const chatUnreadGw = {
    unreadFor: (inst: string, jid: string) => chatUnread.unreadFor(inst, chatMeta.canon(jid)),
    markRead: (inst: string, jid: string) => chatUnread.markRead(inst, chatMeta.canon(jid)),
    markUnread: (inst: string, jid: string) =>
      chatUnread.markUnread(inst, chatMeta.canon(jid), Date.now()),
  };
  attachChatWatcher(
    relay,
    chatMeta,
    (jid) => emit('CHAT_STATUS', { jid, status: 'open', by: '' }),
    (m) => app.log.info(m),
    () => cfg.evo.instance,
  );
  // Web Push: notifies a phone even when the app is closed (the in-page path
  // can't fire once the OS suspends the tab). Keyed by chat assignment like the
  // in-page notifier; which Evolution lines notify is operator-controlled
  // (Settings → Notifications), defaulting to the default line only.
  const push = new PushService(db, { subject: cfg.vapidSubject, log: (m) => app.log.info(m) });
  // Per-person notification preferences (group/DM mutes, quiet hours, keyword
  // alerts, job-ended) layered on top of the global notifyInstances allowlist.
  const notifyPrefs = new NotifyPrefsStore(db);
  // Per-agent nav tab order (which tabs sit in the main bar vs. "More").
  const toolbarPrefs = new ToolbarPrefsStore(db);
  attachPushNotifier(
    relay,
    push,
    chatMeta,
    () => cfg.evo.instance,
    () => cfg.notifyInstances,
    notifyPrefs,
    (m) => app.log.info(m),
  );
  // Push a summary to the job's creator when a scheduled/bulk job finishes.
  attachJobNotifier(relay, push, jobs, notifyPrefs, (m) => app.log.info(m));

  // Optional bearer-token auth for the API. Off when API_TOKEN is empty —
  // typical when an access proxy (e.g. Cloudflare Access) fronts the server.
  if (cfg.apiToken) {
    const tokenMatches = (candidate: string): boolean => {
      const a = Buffer.from(candidate);
      const b = Buffer.from(cfg.apiToken);
      return a.length === b.length && timingSafeEqual(a, b);
    };
    app.addHook('onRequest', async (req, reply) => {
      const path = (req.raw.url ?? '').split('?')[0]!;
      if (!path.startsWith('/api/') || path === '/api/health') return;
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      // ?token= because EventSource (SSE) cannot set request headers — accepted
      // only on /api/events so tokens stay out of access logs elsewhere
      const query =
        path === '/api/events'
          ? (req.query as Record<string, unknown> | undefined)?.token
          : undefined;
      const token =
        (req.headers['x-api-token'] as string | undefined) ??
        (typeof query === 'string' && query ? query : bearer);
      if (!tokenMatches(token)) return reply.code(401).send({ error: 'unauthorized' });
    });
  }

  // Agent identification (Settings toggle): auto-provision the agent and bump
  // last_seen from the Cloudflare Access identity header on every API request.
  app.addHook('onRequest', async (req) => {
    if (!cfg.agentsEnabled) return;
    if (!(req.raw.url ?? '').startsWith('/api/')) return;
    const email = emailFromRequest(req);
    if (email) agents.seen(email);
  });

  // Role-based access (admin vs agent), enforced per route on top of the
  // identity the provision hook above just recorded.
  const guard = (key: PermissionKey) => requirePerm(key, { cfg, agents });

  registerMeta(app, cfg, { quota: coldQuota, familiarity: familiarityStore });
  // wake: immediate sends / reruns fire on save instead of waiting for the poll
  registerJobs(
    app,
    jobs,
    () => void scheduler.tick(),
    () => cfg.recurringEnabled,
    cfg,
    agents,
    emit,
    instanceAccess,
    lists,
    (jobId, recipient) => scheduler.sendOneNow(jobId, recipient),
  );
  registerLists(app, lists, { cfg, agents, access: instanceAccess });
  registerQuickReplies(app, quickReplies, { cfg, agents });
  registerAnalytics(app, db, guard('insights.view'), { cfg, agents, stats: msgStats });
  registerBlacklist(app, blacklist);
  registerVerification(app, verification);
  registerSending(app, sender, cfg, agents, chatMeta, instanceAccess);
  registerAgents(app, agents, cfg, guard('agents.manage'), { meta: chatMeta, emit, access: instanceAccess });
  registerChats(app, { cfg, meta: chatMeta, agents, presence, emit, ai: aiAgentStore, db });
  registerAiAgent(app, {
    cfg,
    knowledge,
    studio: studioData,
    runner: aiAgent,
    audit: aiAudit,
    requireAdmin: guard('settings.manage'),
  });
  registerReminders(app, { cfg, agents, reminders });
  registerPush(app, { cfg, push, prefs: notifyPrefs });
  registerToolbarPrefs(app, { cfg, prefs: toolbarPrefs });
  registerInstances(app, {
    cfg,
    agents,
    access: instanceAccess,
    instances: instancesService,
    evo,
    requireAdmin: guard('settings.manage'),
  });
  registerMaintenance(app, {
    cfg,
    maintenance,
    instances: instancesService,
    access: instanceAccess,
    requireViewer: guard('insights.view'),
    requireAdmin: guard('settings.manage'),
  });
  registerGateway(
    app,
    evo,
    instanceAccess,
    msgCache,
    (messageId, req, chatJid) => {
      // remember which agent deleted a message for everyone (Settings toggle)
      if (!cfg.agentsEnabled) return;
      const email = emailFromRequest(req);
      if (email) agents.recordDelete(messageId, email, chatMeta.canon(chatJid) ?? chatJid);
    },
    (messageId, req, chatJid) => {
      // remember which agent edited a message (Settings toggle)
      if (!cfg.agentsEnabled) return;
      const email = emailFromRequest(req);
      if (email) agents.recordEdit(messageId, email, chatMeta.canon(chatJid) ?? chatJid);
    },
    readReceipts,
    chatUnreadGw,
    emit,
    (rawInstance, jid, altJid) => {
      // Learn lid↔phone aliases from opened threads — but only the default
      // instance, mirroring attachChatWatcher (chat meta is jid-keyed app-wide,
      // and a reconnecting secondary instance replays history).
      if (rawInstance === cfg.evo.instance) chatMeta.learnAlias(jid, altJid);
    },
  );
  registerGroups(app, evo, instanceAccess);
  registerProfile(app, evo, instanceAccess);
  registerEvents(app, relay, instanceAccess);
  registerSettings(app, { cfg, store: settings, relay, requireAdmin: guard('settings.manage') });
  await registerStatic(app, cfg);

  app.addHook('onClose', async () => {
    await scheduler.stop();
    aiAgent.stopPolling();
    relay.stop();
  });

  /**
   * One-time bootstrap of the cold-contact cap, per line: everyone Evolution
   * already has a thread with counts as known. Without it, switching the cap on
   * would treat years of existing contacts as strangers and ration messages to
   * people the studio speaks with every week. Non-fatal and never awaited by
   * boot — a failure only means the first campaign sees more cold contacts than
   * it should, which errs toward sending less.
   */
  const seedFamiliarity = async (): Promise<void> => {
    const inst = cfg.evo.instance;
    if (!inst || !evo.configured || familiarityStore.seeded(inst)) return;
    try {
      await seedFamiliarityFromChats(evo, familiarityStore, inst, (m) => app.log.info(m));
    } catch (e) {
      app.log.warn(`[familiarity] seed failed (${String((e as Error).message ?? e)}) — retried next boot`);
    }
  };

  return { app, scheduler, relay, jobs, blacklist, seedFamiliarity, aiAgent, aiAgentStore };
}
