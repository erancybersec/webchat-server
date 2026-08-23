import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { emailFromRequest, type AgentsStore } from '../services/agents.js';
import { can } from '../services/authz.js';
import { toCsv } from '../services/csv.js';
import type { MessageStatsStore } from '../services/msgstats.js';

// Failed rows carry no timestamp of their own — bucket them by the job's
// finish time (falling back to its scheduled time).
const DAY_EXPR = `date(COALESCE(js.sent_at, j.finished_at, j.scheduled_at))`;

// Per-instance separation: a blank-instance row belongs to the server default.
// @eff='' = no filter (whole-system aggregates). `col` is the instance column on
// whatever table/alias the query reads (jobs vs message_agents).
const instScope = (col: string): string =>
  `(@eff = '' OR COALESCE(NULLIF(${col},''), @def) = @eff)`;

/** Read-only aggregates over data the send pipeline already records. Admin-only (Insights page). */
export function registerAnalytics(
  app: FastifyInstance,
  db: Db,
  requireAdmin: preHandlerHookHandler,
  deps?: { cfg: Config; agents: AgentsStore; stats?: MessageStatsStore },
): void {
  const q = {
    perDay: db.prepare(`SELECT ${DAY_EXPR} AS day,
        SUM(js.status='sent') AS sent,
        SUM(js.status='failed') AS failed,
        SUM(js.status='skipped') AS skipped
      FROM job_sends js JOIN jobs j ON j.id = js.job_id
      WHERE js.status IN ('sent','failed','skipped') AND ${instScope('j.instance')}
        AND ${DAY_EXPR} >= @cutoff AND ${DAY_EXPR} <= @until
      GROUP BY day ORDER BY day`),
    // All-time outcomes (the "… all-time" footer line).
    sendTotals: db.prepare(`SELECT
        SUM(js.status='sent') AS sent,
        SUM(js.status='failed') AS failed,
        SUM(js.status='skipped') AS skipped,
        COUNT(js.delivered_at) AS delivered,
        COUNT(js.read_at) AS readCount
      FROM job_sends js JOIN jobs j ON j.id = js.job_id
      WHERE ${instScope('j.instance')}`),
    // Same outcomes but windowed — drives the deliverability funnel and the
    // period-over-period trend chips (called twice: this window + the previous).
    sendWindow: db.prepare(`SELECT
        SUM(js.status='sent') AS sent,
        SUM(js.status='failed') AS failed,
        SUM(js.status='skipped') AS skipped,
        COUNT(js.delivered_at) AS delivered,
        COUNT(js.read_at) AS readCount
      FROM job_sends js JOIN jobs j ON j.id = js.job_id
      WHERE ${instScope('j.instance')}
        AND ${DAY_EXPR} >= @cutoff AND ${DAY_EXPR} <= @until`),
    // Mean delivery / read latency of job sends in the window, in seconds.
    // julianday() diffs are in days → ×86400. NULL acks are excluded by AVG.
    latency: db.prepare(`SELECT
        AVG(CASE WHEN js.delivered_at IS NOT NULL
              THEN (julianday(js.delivered_at) - julianday(js.sent_at)) * 86400 END) AS deliverSec,
        AVG(CASE WHEN js.read_at IS NOT NULL
              THEN (julianday(js.read_at) - julianday(js.sent_at)) * 86400 END) AS readSec
      FROM job_sends js JOIN jobs j ON j.id = js.job_id
      WHERE js.status='sent' AND js.sent_at IS NOT NULL AND ${instScope('j.instance')}
        AND ${DAY_EXPR} >= @cutoff AND ${DAY_EXPR} <= @until`),
    jobsByStatus: db.prepare(
      `SELECT status, COUNT(*) AS n FROM jobs WHERE ${instScope('instance')} GROUP BY status`,
    ),
    topErrors: db.prepare(`SELECT js.last_error AS error, COUNT(*) AS count
      FROM job_sends js JOIN jobs j ON j.id = js.job_id
      WHERE js.status='failed' AND js.last_error IS NOT NULL AND js.last_error != ''
        AND ${instScope('j.instance')}
      GROUP BY js.last_error ORDER BY count DESC LIMIT 5`),
    // Blacklist is system-wide — a phone ban applies across every line, so these
    // counters are deliberately NOT scoped by instance.
    blacklistTotal: db.prepare(`SELECT COUNT(*) AS n FROM blacklist`),
    blacklistRecent: db.prepare(
      `SELECT COUNT(*) AS n FROM blacklist WHERE date(added_date) >= @cutoff AND date(added_date) <= @until`,
    ),
    // Per-agent: job-ledger outcomes by the composing agent…
    agentJobSends: db.prepare(`SELECT j.sent_by AS email,
        SUM(js.status='sent') AS sent,
        SUM(js.status='failed') AS failed,
        SUM(js.status='skipped') AS skipped,
        COUNT(js.delivered_at) AS delivered,
        COUNT(js.read_at) AS readCount
      FROM job_sends js JOIN jobs j ON j.id = js.job_id
      WHERE j.sent_by IS NOT NULL AND js.status IN ('sent','failed','skipped')
        AND ${instScope('j.instance')}
        AND ${DAY_EXPR} >= @cutoff AND ${DAY_EXPR} <= @until
      GROUP BY j.sent_by`),
    agentJobPerDay: db.prepare(`SELECT j.sent_by AS email, ${DAY_EXPR} AS day,
        SUM(js.status='sent') AS sent
      FROM job_sends js JOIN jobs j ON j.id = js.job_id
      WHERE j.sent_by IS NOT NULL AND js.status='sent'
        AND ${instScope('j.instance')}
        AND ${DAY_EXPR} >= @cutoff AND ${DAY_EXPR} <= @until
      GROUP BY j.sent_by, day`),
    // …and chat-screen sends from message attribution. chat_jid and instance are
    // only recorded from v2.8 / this deploy on, so pre-deploy rows (blank
    // instance) fall under the default line.
    agentChatSends: db.prepare(`SELECT agent_email AS email,
        COUNT(*) AS sends,
        COUNT(DISTINCT chat_jid) AS chats
      FROM message_agents
      WHERE date(sent_at) >= @cutoff AND date(sent_at) <= @until AND ${instScope('instance')}
      GROUP BY agent_email`),
    agentChatPerDay: db.prepare(`SELECT agent_email AS email, date(sent_at) AS day,
        COUNT(*) AS sent
      FROM message_agents
      WHERE date(sent_at) >= @cutoff AND date(sent_at) <= @until AND ${instScope('instance')}
      GROUP BY agent_email, day`),
    // Hour-of-day (UTC) distribution of each agent's sends — chat-screen sends…
    agentChatPerHour: db.prepare(`SELECT agent_email AS email,
        CAST(strftime('%H', sent_at) AS INTEGER) AS hour, COUNT(*) AS n
      FROM message_agents
      WHERE date(sent_at) >= @cutoff AND date(sent_at) <= @until AND ${instScope('instance')}
      GROUP BY agent_email, hour`),
    // …and completed job sends (those carry a real send time).
    agentJobPerHour: db.prepare(`SELECT j.sent_by AS email,
        CAST(strftime('%H', js.sent_at) AS INTEGER) AS hour, COUNT(*) AS n
      FROM job_sends js JOIN jobs j ON j.id = js.job_id
      WHERE j.sent_by IS NOT NULL AND js.status='sent' AND js.sent_at IS NOT NULL
        AND ${instScope('j.instance')}
        AND date(js.sent_at) >= @cutoff AND date(js.sent_at) <= @until
      GROUP BY j.sent_by, hour`),
  };

  // Effective instance for a request: the ?instance= override, or the server
  // default (read live — Settings can change it). eff='' only when no default is
  // configured (single-instance deployment) → all queries fall through unfiltered.
  const inst = (req: { query: unknown }): { eff: string; def: string } => {
    const def = deps?.cfg.evo.instance ?? '';
    const asked = ((req.query as { instance?: string }).instance ?? '').trim();
    return { eff: asked || def, def };
  };

  type SendAgg = {
    sent: number | null;
    failed: number | null;
    skipped: number | null;
    delivered: number;
    readCount: number;
  };

  app.get('/api/analytics/summary', { preHandler: requireAdmin }, async (req) => {
    const { days, cutoff, until } = parseRange(req);
    const scope = inst(req);

    // This window vs the immediately-preceding equal-length window, for trends.
    const prevUntil = shiftDay(cutoff, -1);
    const prevCutoff = shiftDay(cutoff, -days);
    const sendOf = (c: string, u: string) =>
      q.sendWindow.get({ cutoff: c, until: u, ...scope }) as SendAgg;
    const win = sendOf(cutoff, until);
    const prevWin = sendOf(prevCutoff, prevUntil);
    const allTime = q.sendTotals.get(scope) as SendAgg;
    const lat = q.latency.get({ cutoff, until, ...scope }) as {
      deliverSec: number | null;
      readSec: number | null;
    };

    const prevAct = deps?.stats ? deps.stats.activity(prevCutoff, prevUntil, scope).totals : null;
    const prevBlk = (q.blacklistRecent.get({ cutoff: prevCutoff, until: prevUntil }) as { n: number }).n;

    const jobs: Record<string, number> = {};
    for (const r of q.jobsByStatus.all(scope) as Array<{ status: string; n: number }>) jobs[r.status] = r.n;
    return {
      days,
      from: cutoff,
      to: until,
      perDay: q.perDay.all({ cutoff, until, ...scope }),
      // totals are now WINDOWED (was all-time) — funnel + trends read these.
      totals: {
        sent: win.sent ?? 0,
        failed: win.failed ?? 0,
        skipped: win.skipped ?? 0,
        delivered: win.delivered,
        read: win.readCount,
      },
      allTime: { sent: allTime.sent ?? 0, failed: allTime.failed ?? 0 },
      // mean delivery/read latency of this window's job sends (seconds), or null
      latency: { deliverSec: lat.deliverSec, readSec: lat.readSec },
      // previous-period mirror so the client can render deltas without a 2nd call
      prev: {
        sent: prevWin.sent ?? 0,
        failed: prevWin.failed ?? 0,
        skipped: prevWin.skipped ?? 0,
        delivered: prevWin.delivered,
        read: prevWin.readCount,
        inbound: prevAct?.inbound ?? null,
        outbound: prevAct?.outbound ?? null,
        chats: prevAct?.chats ?? null,
        blacklistAdded: prevBlk,
      },
      // live chat traffic (relay-fed counters; tracked from v2.9 onward)
      activity: deps?.stats ? deps.stats.activity(cutoff, until, scope) : null,
      jobs,
      topErrors: q.topErrors.all(scope),
      blacklist: {
        total: (q.blacklistTotal.get() as { n: number }).n,
        added: (q.blacklistRecent.get({ cutoff, until }) as { n: number }).n,
      },
    };
  });

  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  const today = (): string => new Date().toISOString().slice(0, 10);
  // Shift a YYYY-MM-DD day by whole days (UTC) — used to derive the previous
  // equal-length window for trend comparisons.
  const shiftDay = (iso: string, deltaDays: number): string =>
    new Date(Date.parse(`${iso}T00:00:00Z`) + deltaDays * 86_400_000).toISOString().slice(0, 10);
  /**
   * Date window for every aggregate. Explicit `from`/`to` (YYYY-MM-DD) win
   * when both are valid and ordered (custom range picker); otherwise the
   * `days` preset back to today. `until` is inclusive — every query compares
   * date(...) BETWEEN cutoff AND until.
   */
  // a real calendar day, not just digits in the right shape — "2026-13-01"
  // matches ISO_DAY but Date.parse round-trips it to a different day.
  const realDay = (s: string): number | null => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s ? t : null;
  };
  const parseRange = (req: { query: unknown }): { days: number; cutoff: string; until: string } => {
    const qy = req.query as { days?: string; from?: string; to?: string };
    if (ISO_DAY.test(qy.from ?? '') && ISO_DAY.test(qy.to ?? '') && qy.from! <= qy.to!) {
      const f = realDay(qy.from!);
      const t = realDay(qy.to!);
      if (f != null && t != null) {
        return { days: Math.round((t - f) / 86_400_000) + 1, cutoff: qy.from!, until: qy.to! };
      }
    }
    const days = Math.min(Math.max(1, Number(qy.days) || 30), 365);
    return {
      days,
      cutoff: new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10),
      until: today(),
    };
  };

  // Per-agent activity. insights.view (admin) → everyone; insights.viewOwn
  // → the requester's own row ("My activity"); neither → 403.
  app.get('/api/analytics/agents', async (req, reply) => {
    let self: string | null = null;
    if (deps?.cfg.agentsEnabled) {
      const email = emailFromRequest(req);
      if (email) {
        const agent = deps.agents.byEmail(email);
        if (can(agent, 'insights.view')) self = null;
        else if (can(agent, 'insights.viewOwn')) self = email;
        else return reply.code(403).send({ error: 'permission required' });
      }
    }
    const { days, cutoff, until } = parseRange(req);
    const scope = inst(req);

    type AgentRow = {
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
      perHour: number[];
    };
    const byEmail = new Map<string, AgentRow>();
    const roster = new Map(deps ? deps.agents.all().map((a) => [a.email, a]) : []);
    const row = (email: string): AgentRow => {
      let r = byEmail.get(email);
      if (!r) {
        const a = roster.get(email);
        r = {
          email,
          name: a?.name ?? '',
          color: a?.color ?? '',
          jobSent: 0,
          jobFailed: 0,
          jobSkipped: 0,
          jobDelivered: 0,
          jobRead: 0,
          chatSends: 0,
          chatsTouched: 0,
          perDay: [],
          perHour: Array.from({ length: 24 }, () => 0),
        };
        byEmail.set(email, r);
      }
      return r;
    };

    for (const r of q.agentJobSends.all({ cutoff, until, ...scope }) as Array<{
      email: string; sent: number | null; failed: number | null; skipped: number | null;
      delivered: number; readCount: number;
    }>) {
      const a = row(r.email);
      a.jobSent = r.sent ?? 0;
      a.jobFailed = r.failed ?? 0;
      a.jobSkipped = r.skipped ?? 0;
      a.jobDelivered = r.delivered;
      a.jobRead = r.readCount;
    }
    for (const r of q.agentChatSends.all({ cutoff, until, ...scope }) as Array<{ email: string; sends: number; chats: number }>) {
      const a = row(r.email);
      a.chatSends = r.sends;
      a.chatsTouched = r.chats;
    }
    const daily = new Map<string, Map<string, number>>();
    for (const src of [q.agentJobPerDay, q.agentChatPerDay]) {
      for (const r of src.all({ cutoff, until, ...scope }) as Array<{ email: string; day: string; sent: number }>) {
        const m = daily.get(r.email) ?? new Map<string, number>();
        m.set(r.day, (m.get(r.day) ?? 0) + r.sent);
        daily.set(r.email, m);
      }
    }
    for (const [email, m] of daily) {
      row(email).perDay = [...m.entries()]
        .map(([day, sent]) => ({ day, sent }))
        .sort((a, b) => a.day.localeCompare(b.day));
    }
    // Hour-of-day (UTC) buckets: job + chat sends folded into one 24-slot array.
    for (const src of [q.agentJobPerHour, q.agentChatPerHour]) {
      for (const r of src.all({ cutoff, until, ...scope }) as Array<{ email: string; hour: number; n: number }>) {
        if (r.hour >= 0 && r.hour < 24) {
          const ph = row(r.email).perHour;
          ph[r.hour] = (ph[r.hour] ?? 0) + r.n;
        }
      }
    }

    const all = [...byEmail.values()].sort(
      (a, b) => b.jobSent + b.chatSends - (a.jobSent + a.chatSends),
    );
    return { days, agents: self == null ? all : all.filter((a) => a.email === self) };
  });

  // CSV export of the per-day summary (Insights page button).
  app.get('/api/analytics/export.csv', { preHandler: requireAdmin }, async (req, reply) => {
    const { days, cutoff, until } = parseRange(req);
    const rows = q.perDay.all({ cutoff, until, ...inst(req) }) as Array<{
      day: string; sent: number | null; failed: number | null; skipped: number | null;
    }>;
    const csv = toCsv(
      ['day', 'sent', 'failed', 'skipped'],
      rows.map((r) => [r.day, r.sent ?? 0, r.failed ?? 0, r.skipped ?? 0]),
    );
    const fname = days <= 366 && until === today() ? `insights-${days}d.csv` : `insights-${cutoff}_${until}.csv`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${fname}"`)
      .send(csv);
  });
}
