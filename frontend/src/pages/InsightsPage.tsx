import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { agentBadgeClass, agentLabel, usePerm } from '../lib/agents';
import { api, type AnalyticsRange } from '../lib/api';
import type { AgentInsightsRow, AnalyticsSummary, MaintenanceReport } from '../types';

// Today + the usual presets. `1` resolves to days=1 server-side (today only).
const RANGES = [1, 7, 30, 90] as const;

/**
 * Rough disk footprint of a stored WhatsApp message on the Evolution Postgres,
 * measured on the studio server (Message table ≈ 402 MB for ≈ 238k messages →
 * ~1.7 KB each, payload + indexes). Only ever shown as an "≈" estimate — the
 * webchat backend can't read Evolution's table sizes directly.
 */
const AVG_MSG_BYTES = 1740;

const fmtNum = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString();

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

/** Human duration from seconds: "4.2s", "3m 10s", "1.5h". */
function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${(sec / 3600).toFixed(1)}h`;
}

const todayStr = (): string => new Date().toISOString().slice(0, 10);
const isCustom = (r: AnalyticsRange): r is { from: string; to: string } => 'from' in r;
const rangeLabel = (r: AnalyticsRange): string =>
  isCustom(r) ? `${r.from} → ${r.to}` : r.days === 1 ? 'today' : `last ${r.days} days`;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
/** Pretty short day label for a YYYY-MM-DD bucket (UTC, matching the server). */
const dayLabel = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * Trend chip: cur vs prev with an up/down arrow, coloured by whether the move
 * is good. Hidden when there's no basis for comparison.
 */
function Delta({ cur, prev, goodUp = true }: { cur: number; prev: number | null | undefined; goodUp?: boolean }) {
  if (prev == null || (prev === 0 && cur === 0)) return null;
  const diff = cur - prev;
  if (Math.round(diff * 10) === 0) return <span className="text-[11px] font-medium text-gray-400">±0%</span>;
  const up = diff > 0;
  const good = up === goodUp;
  const pct = prev === 0 ? null : Math.round((diff / Math.abs(prev)) * 100);
  const cls = good ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500';
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${cls}`}
      title={`${prevLabelTip(prev)} → ${cur.toLocaleString()}`}
    >
      {up ? '▲' : '▼'}
      {pct == null ? 'new' : `${Math.abs(pct)}%`}
    </span>
  );
}
const prevLabelTip = (n: number): string => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1));

/** Headline number with an optional trend chip and a sub-hint. */
function Stat({
  label,
  value,
  hint,
  cur,
  prev,
  goodUp = true,
}: {
  label: string;
  value: string | number;
  hint?: string;
  cur?: number;
  prev?: number | null;
  goodUp?: boolean;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <p className="text-2xl font-bold text-gray-800">{value}</p>
        {cur != null && <Delta cur={cur} prev={prev} goodUp={goodUp} />}
      </div>
      {hint && <p className="text-xs text-gray-400">{hint}</p>}
    </div>
  );
}

/** Preset day buttons (Today/7/30/90) plus a collapsible custom from/to range. */
function RangePicker({
  range,
  onChange,
}: {
  range: AnalyticsRange;
  onChange: (r: AnalyticsRange) => void;
}) {
  const custom = isCustom(range);
  const [open, setOpen] = useState(custom);
  const [from, setFrom] = useState(custom ? range.from : '');
  const [to, setTo] = useState(custom ? range.to : todayStr());
  const valid = !!from && !!to && from <= to;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-1">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => {
              setOpen(false);
              onChange({ days: r });
            }}
            className={`rounded-md px-3 py-1 text-sm font-medium ${
              !custom && range.days === r ? 'bg-wa text-white' : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            {r === 1 ? 'Today' : `${r}d`}
          </button>
        ))}
        <button
          onClick={() => setOpen((o) => !o)}
          className={`rounded-md px-3 py-1 text-sm font-medium ${
            custom ? 'bg-wa text-white' : 'text-gray-500 hover:bg-gray-50'
          }`}
        >
          Custom
        </button>
      </div>
      {open && (
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white p-1 text-sm">
          <input
            type="date"
            value={from}
            max={to || todayStr()}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-gray-200 px-2 py-1 text-gray-700"
            aria-label="From date"
          />
          <span className="text-gray-400">→</span>
          <input
            type="date"
            value={to}
            max={todayStr()}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-gray-200 px-2 py-1 text-gray-700"
            aria-label="To date"
          />
          <button
            disabled={!valid}
            onClick={() => onChange({ from, to })}
            className="rounded-md bg-wa px-3 py-1 font-medium text-white hover:bg-wa-dark disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-gray-700">{title}</h3>
      {children}
    </div>
  );
}

/** Mini horizontal legend swatch. */
function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span>
      <span className={`mr-1 inline-block h-2 w-2 rounded-sm align-middle ${color}`} />
      {label}
    </span>
  );
}

type Seg = { value: number; color: string; label: string };
type DayDatum = { day: string; total: number; segs: Seg[]; detail: string };

/**
 * Interactive stacked day chart. Click/focus a bar to pin its breakdown in the
 * detail line; otherwise the busiest day is shown. This is the "graphs include
 * details" piece — every bar's exact numbers are one tap away.
 */
function DayChart({ data, legend }: { data: DayDatum[]; legend: Seg[] }) {
  const [sel, setSel] = useState<number | null>(null);
  if (!data.length) return null;
  const max = Math.max(1, ...data.map((d) => d.total));
  const peakIdx = data.reduce((best, d, i) => (d.total > data[best].total ? i : best), 0);
  const shown = sel != null ? data[sel] : data[peakIdx];
  return (
    <>
      <div className="flex h-36 items-end gap-px overflow-x-auto">
        {data.map((d, i) => {
          const active = (sel ?? peakIdx) === i;
          return (
            <button
              key={d.day}
              type="button"
              onClick={() => setSel((s) => (s === i ? null : i))}
              onMouseEnter={() => setSel(i)}
              onMouseLeave={() => setSel(null)}
              title={`${d.day}: ${d.detail}`}
              aria-label={`${d.day}: ${d.detail}`}
              className={`flex min-w-3 max-w-[24px] flex-1 cursor-pointer flex-col justify-end self-stretch rounded-t-sm ${
                active ? 'bg-gray-100' : ''
              }`}
            >
              <div
                className="flex flex-col justify-end overflow-hidden rounded-t-sm"
                style={{ height: `${(d.total / max) * 100}%` }}
              >
                {d.segs.map((s) => (
                  <div key={s.label} className={`w-full ${s.color}`} style={{ flexGrow: s.value }} />
                ))}
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500">
        {legend.map((s) => (
          <Swatch key={s.label} color={s.color} label={s.label} />
        ))}
        <span className="ml-auto font-medium text-gray-600">
          {sel != null ? '' : 'Peak · '}
          {dayLabel(shown.day)}: {shown.detail}
        </span>
      </div>
    </>
  );
}

/** Sent → delivered → read funnel with conversion %s and a failure-rate chip. */
function Funnel({ d }: { d: AnalyticsSummary }) {
  const { sent, delivered, read, failed } = d.totals;
  const attempted = sent + failed;
  const pct = (n: number, base: number) => (base ? Math.round((n / base) * 100) : 0);
  const failRate = attempted ? Math.round((failed / attempted) * 100) : 0;
  const stages = [
    { label: 'Sent', n: sent, of: 'of attempts', base: pct(sent, attempted), bar: 'bg-wa' },
    { label: 'Delivered', n: delivered, of: 'of sent', base: pct(delivered, sent), bar: 'bg-emerald-400' },
    { label: 'Read', n: read, of: 'of sent', base: pct(read, sent), bar: 'bg-sky-400' },
  ];
  if (attempted === 0)
    return <p className="py-4 text-center text-sm text-gray-400">No bulk/scheduled sends in this period.</p>;
  return (
    <div className="space-y-3">
      {stages.map((s) => (
        <div key={s.label}>
          <div className="mb-1 flex items-baseline justify-between text-sm">
            <span className="text-gray-600">{s.label}</span>
            <span className="text-gray-800">
              <span className="font-semibold">{fmtNum(s.n)}</span>{' '}
              <span className="text-xs text-gray-400">
                {s.base}% {s.of}
              </span>
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-gray-100">
            <div className={`h-full rounded-full ${s.bar}`} style={{ width: `${s.base}%` }} />
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between border-t border-gray-100 pt-2 text-sm">
        <span className="text-gray-600">Failure rate</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            failRate >= 10 ? 'bg-red-50 text-red-600' : failRate > 0 ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600'
          }`}
        >
          {failRate}% · {fmtNum(failed)} failed
        </span>
      </div>
    </div>
  );
}

/** Average traffic by weekday — the "patterns" view; busiest day highlighted. */
function WeekdayPattern({ perDay }: { perDay: NonNullable<AnalyticsSummary['activity']>['perDay'] }) {
  const sums = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }));
  for (const p of perDay) {
    const wd = new Date(`${p.day}T00:00:00Z`).getUTCDay();
    sums[wd].total += p.inbound + p.outbound;
    sums[wd].days += 1;
  }
  const avg = sums.map((s) => (s.days ? s.total / s.days : 0));
  const max = Math.max(1, ...avg);
  if (avg.every((a) => a === 0)) return null;
  const peak = avg.indexOf(Math.max(...avg));
  return (
    <div>
      <div className="flex h-20 items-end gap-1.5">
        {avg.map((a, i) => (
          <div key={i} className="flex flex-1 flex-col items-center justify-end self-stretch" title={`${WEEKDAYS[i]}: ${Math.round(a)} msgs/day avg`}>
            <div
              className={`w-full rounded-t-sm ${i === peak ? 'bg-wa' : 'bg-gray-300'}`}
              style={{ height: `${Math.max(4, (a / max) * 100)}%` }}
            />
            <span className={`mt-1 text-[10px] ${i === peak ? 'font-semibold text-gray-700' : 'text-gray-400'}`}>
              {WEEKDAYS[i][0]}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-gray-500">
        Busiest day: <span className="font-medium text-gray-700">{WEEKDAYS[peak]}</span> · avg{' '}
        {Math.round(avg[peak])} msgs/day
      </p>
    </div>
  );
}

const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`;

/** 24-bar hour-of-day histogram (UTC); busiest hour highlighted. */
function HourChart({ hours }: { hours: number[] }) {
  const total = hours.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const max = Math.max(1, ...hours);
  const peak = hours.indexOf(Math.max(...hours));
  return (
    <div>
      <div className="flex h-20 items-end gap-px">
        {hours.map((n, h) => (
          <div
            key={h}
            className="flex flex-1 flex-col justify-end self-stretch"
            title={`${hourLabel(h)} UTC: ${n} send${n === 1 ? '' : 's'}`}
          >
            <div
              className={`w-full rounded-t-sm ${h === peak ? 'bg-wa' : 'bg-gray-300'}`}
              style={{ height: `${Math.max(3, (n / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-gray-400">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>23:00</span>
      </div>
      <p className="mt-1 text-[11px] text-gray-500">
        Busiest hour: <span className="font-medium text-gray-700">{hourLabel(peak)} UTC</span> · {hours[peak]} sends
      </p>
    </div>
  );
}

/**
 * Per-agent activity: reply share, depth (msgs/chat), delivery, active days and
 * a daily-sends trend — plus a team activity-by-hour chart (full roster only).
 */
function AgentActivity({ range, mineOnly }: { range: AnalyticsRange; mineOnly: boolean }) {
  const q = useQuery({
    queryKey: ['agent-insights', range],
    queryFn: () => api.agentInsights(range),
    staleTime: 60_000,
  });
  if (q.isLoading) return <p className="py-6 text-center text-sm text-gray-400">Loading…</p>;
  if (q.isError)
    return (
      <p role="alert" className="py-6 text-center text-sm text-red-500">
        {(q.error as Error).message}
      </p>
    );
  const rows = q.data?.agents ?? [];
  if (!rows.length)
    return (
      <p className="py-6 text-center text-sm text-gray-400">
        No attributed activity in this period{mineOnly ? '' : ' — sends are attributed while agent identification is on'}.
      </p>
    );
  const teamChat = rows.reduce((s, a) => s + a.chatSends, 0);
  const teamHours = Array.from({ length: 24 }, (_, h) => rows.reduce((s, a) => s + (a.perHour?.[h] ?? 0), 0));

  return (
    <div className="space-y-4">
      {!mineOnly && teamHours.some((n) => n > 0) && (
        <div>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
            When the team sends — by hour
          </h4>
          <HourChart hours={teamHours} />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-400">
            <tr>
              <th className="py-1 pr-3">Agent</th>
              {!mineOnly && (
                <th className="py-1 pr-3" title="This agent's chat replies as a share of the whole team's">
                  Reply share
                </th>
              )}
              <th className="py-1 pr-3">Chat sends</th>
              <th className="py-1 pr-3" title="Average messages this agent sends per conversation they touch">
                Msgs / chat
              </th>
              <th className="py-1 pr-3" title="Distinct chats with attributed sends (tracked from v2.8)">
                Chats
              </th>
              <th className="py-1 pr-3">Job sends</th>
              <th className="py-1 pr-3" title="Delivered / read of this agent's job sends">
                Deliv · Read
              </th>
              <th className="py-1 pr-3">Failed</th>
              <th className="py-1 pr-3" title="Days in the period with at least one send">
                Active days
              </th>
              <th className="py-1" title="Sends per day (last 21 days of the period)">
                Daily sends
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a: AgentInsightsRow) => {
              const maxDay = Math.max(1, ...a.perDay.map((p) => p.sent));
              const pct = (n: number) => (a.jobSent ? `${Math.round((n / a.jobSent) * 100)}%` : '—');
              const share = teamChat ? Math.round((a.chatSends / teamChat) * 100) : 0;
              const perChat = a.chatSends && a.chatsTouched ? (a.chatSends / a.chatsTouched).toFixed(1) : '—';
              const lastActive = a.perDay.length ? a.perDay[a.perDay.length - 1].day : null;
              return (
                <tr key={a.email} className="border-t border-gray-100">
                  <td className="py-1.5 pr-3">
                    <span
                      title={a.email}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${agentBadgeClass(a.color)}`}
                    >
                      {agentLabel(a)}
                    </span>
                  </td>
                  {!mineOnly && (
                    <td className="py-1.5 pr-3">
                      <div className="flex items-center gap-1.5">
                        <span className="w-8 font-medium text-gray-800">{share}%</span>
                        <div className="h-1.5 w-14 overflow-hidden rounded-full bg-gray-100">
                          <div className="h-full rounded-full bg-wa" style={{ width: `${share}%` }} />
                        </div>
                      </div>
                    </td>
                  )}
                  <td className="py-1.5 pr-3 font-medium text-gray-800">{a.chatSends}</td>
                  <td className="py-1.5 pr-3 text-gray-600">{perChat}</td>
                  <td className="py-1.5 pr-3 text-gray-600">{a.chatsTouched}</td>
                  <td className="py-1.5 pr-3 font-medium text-gray-800">{a.jobSent}</td>
                  <td
                    className="py-1.5 pr-3 text-gray-600"
                    title={`${a.jobDelivered} delivered, ${a.jobRead} read of ${a.jobSent} job sends`}
                  >
                    {pct(a.jobDelivered)} · {pct(a.jobRead)}
                  </td>
                  <td className={`py-1.5 pr-3 ${a.jobFailed ? 'text-red-500' : 'text-gray-400'}`}>{a.jobFailed}</td>
                  <td
                    className="py-1.5 pr-3 text-gray-600"
                    title={lastActive ? `last active ${lastActive}` : 'no sends in period'}
                  >
                    {a.perDay.length}
                  </td>
                  <td className="py-1.5">
                    <div className="flex h-6 items-end gap-px">
                      {a.perDay.slice(-21).map((p) => (
                        <div
                          key={p.day}
                          title={`${p.day}: ${p.sent} send${p.sent === 1 ? '' : 's'}`}
                          className="w-1.5 rounded-t-sm bg-wa"
                          style={{ height: `${Math.max(8, (p.sent / maxDay) * 100)}%` }}
                        />
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Disk / DB / Evolution storage telemetry + retention status (admins). */
function ServerHealth() {
  const q = useQuery({
    queryKey: ['maintenance'],
    queryFn: api.maintenance.get,
    staleTime: 60_000,
    retry: 1,
  });
  if (q.isLoading) return <p className="py-6 text-center text-sm text-gray-400">Loading…</p>;
  if (q.isError)
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-gray-700">Server health</h3>
        <p role="alert" className="text-sm text-red-500">{(q.error as Error).message}</p>
      </div>
    );
  const d = q.data as MaintenanceReport;
  const usedPct = d.disk ? Math.round(((d.disk.totalBytes - d.disk.freeBytes) / d.disk.totalBytes) * 100) : null;
  const diskLow = d.disk != null && (usedPct! >= 85 || d.disk.freeBytes < 10e9);
  const deadInstances = (d.evolution ?? []).filter((i) => i.connectionStatus !== 'open');
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-700">Server health & storage</h3>

      {diskLow && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-600">
          ⚠ Disk is filling up — {fmtBytes(d.disk!.freeBytes)} free. Consider running a cleanup in
          Settings → Maintenance.
        </p>
      )}

      {d.disk && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-gray-500">
            <span>Server disk</span>
            <span>
              {fmtBytes(d.disk.totalBytes - d.disk.freeBytes)} used of {fmtBytes(d.disk.totalBytes)} ({usedPct}%)
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-gray-100">
            <div
              className={`h-full rounded-full ${diskLow ? 'bg-red-500' : usedPct! >= 70 ? 'bg-amber-400' : 'bg-wa'}`}
              style={{ width: `${usedPct}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-lg bg-gray-50 px-3 py-2">
          <p className="text-xs text-gray-400">App database</p>
          <p className="font-medium text-gray-700">
            {fmtBytes(d.db.sizeBytes)}
            {d.db.walBytes > 0 && <span className="text-xs text-gray-400"> +{fmtBytes(d.db.walBytes)} WAL</span>}
          </p>
          <p className="text-xs text-gray-500">
            {fmtNum(d.tables.jobs ?? 0)} jobs · {fmtNum(d.tables.job_sends ?? 0)} ledger rows ·{' '}
            {fmtNum(d.tables.message_agents ?? 0)} attributions
          </p>
        </div>
        <div className="rounded-lg bg-gray-50 px-3 py-2">
          <p className="text-xs text-gray-400">History retention</p>
          <p className="font-medium text-gray-700">
            {d.retentionDays > 0 ? `auto-purge after ${d.retentionDays} days` : 'off — history kept forever'}
          </p>
          <p className="text-xs text-gray-500">configure under Settings → Maintenance</p>
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs text-gray-400">WhatsApp messages stored on the Evolution server (per channel)</p>
        {d.evolutionError ? (
          <p className="text-sm text-red-500">Evolution unreachable — {d.evolutionError}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {(d.evolution ?? []).map((i) => (
              <li key={i.name} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-gray-600">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${i.connectionStatus === 'open' ? 'bg-wa' : 'bg-red-500'}`}
                  />
                  {i.name}
                  {i.name === d.defaultInstance && <span className="text-[10px] text-gray-400">(default)</span>}
                  {i.connectionStatus !== 'open' && (
                    <span className="text-xs text-red-500">
                      disconnected{i.disconnectedAt ? ` since ${new Date(i.disconnectedAt).toLocaleDateString()}` : ''}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-right text-gray-700">
                  {i.counts ? (
                    <>
                      {fmtNum(i.counts.messages)} msgs · {fmtNum(i.counts.chats)} chats
                      <span
                        className="block text-[10px] text-gray-400"
                        title={`Estimated at ~${AVG_MSG_BYTES} bytes per stored message`}
                      >
                        ≈ {fmtBytes(i.counts.messages * AVG_MSG_BYTES)} on disk
                      </span>
                    </>
                  ) : (
                    '—'
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {!d.evolutionError && (d.evolution ?? []).some((i) => i.counts) && (
          <p className="mt-1 text-[10px] text-gray-400">
            Chat-message sizes are estimated (~{(AVG_MSG_BYTES / 1024).toFixed(1)} KB each) — the
            stored messages live on the Evolution server, separate from this app's job history.
          </p>
        )}
        {deadInstances.length > 0 && (
          <p className="mt-1 text-xs text-amber-600">
            Disconnected channels keep their stored history on the server — reconnect them from the
            Evolution manager or consider archiving.
          </p>
        )}
      </div>
    </div>
  );
}

/** The Overview tab: KPIs with trends, traffic + patterns, deliverability, jobs. */
function Overview({ d, range }: { d: AnalyticsSummary; range: AnalyticsRange }) {
  const act = d.activity;
  const inbound = act?.totals.inbound ?? 0;
  const outbound = act?.totals.outbound ?? 0;
  const chats = act?.totals.chats ?? 0;
  // reply ratio = our outbound per inbound message; >100% means we send more
  // than we receive (broadcast-heavy). prev mirror from d.prev.
  const replyRatio = inbound ? Math.round((outbound / inbound) * 100) : null;
  const prevReplyRatio = d.prev.inbound ? Math.round(((d.prev.outbound ?? 0) / d.prev.inbound) * 100) : null;
  const readRate = d.totals.sent ? Math.round((d.totals.read / d.totals.sent) * 100) : null;
  const prevReadRate = d.prev.sent ? Math.round((d.prev.read / d.prev.sent) * 100) : null;

  const trafficDays: DayDatum[] = (act?.perDay ?? []).map((p) => ({
    day: p.day,
    total: p.inbound + p.outbound,
    segs: [
      { value: p.inbound, color: 'bg-sky-400', label: 'received' },
      { value: p.outbound, color: 'bg-wa', label: 'sent' },
    ],
    detail: `${p.inbound} in · ${p.outbound} out · ${p.chats} chats`,
  }));
  const sendDays: DayDatum[] = d.perDay.map((p) => ({
    day: p.day,
    total: p.sent + p.failed + p.skipped,
    segs: [
      { value: p.failed, color: 'bg-red-400', label: 'failed' },
      { value: p.skipped, color: 'bg-gray-300', label: 'skipped' },
      { value: p.sent, color: 'bg-wa', label: 'sent' },
    ],
    detail: `${p.sent} sent · ${p.skipped} skipped · ${p.failed} failed`,
  }));

  return (
    <div className="space-y-4">
      {/* headline KPIs with period-over-period trends */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Received" value={fmtNum(inbound)} hint={rangeLabel(range)} cur={inbound} prev={d.prev.inbound} />
        <Stat label="Sent (chat)" value={fmtNum(outbound)} hint={rangeLabel(range)} cur={outbound} prev={d.prev.outbound} />
        <Stat label="Active chats" value={fmtNum(chats)} hint={rangeLabel(range)} cur={chats} prev={d.prev.chats} />
        <Stat
          label="Reply ratio"
          value={replyRatio != null ? `${replyRatio}%` : '—'}
          hint="sent per received"
          cur={replyRatio ?? 0}
          prev={prevReplyRatio}
        />
        <Stat
          label="Read rate"
          value={readRate != null ? `${readRate}%` : '—'}
          hint="of job sends read"
          cur={readRate ?? 0}
          prev={prevReadRate}
        />
        <Stat
          label="Avg delivery"
          value={fmtDuration(d.latency.deliverSec)}
          hint={`read in ${fmtDuration(d.latency.readSec)}`}
          cur={d.latency.deliverSec ?? 0}
          prev={null}
          goodUp={false}
        />
      </div>

      <Panel title={`Chat traffic per day — ${rangeLabel(range)}`}>
        {!trafficDays.length ? (
          <p className="py-6 text-center text-sm text-gray-400">
            No traffic recorded yet — live counters started with v2.9
            {act?.since ? ` (tracking since ${act.since})` : ''}.
          </p>
        ) : (
          <>
            <DayChart
              data={trafficDays}
              legend={[
                { value: 0, color: 'bg-sky-400', label: 'received' },
                { value: 0, color: 'bg-wa', label: 'sent' },
              ]}
            />
            <p className="mt-1 text-[11px] text-gray-400">
              days in UTC{act?.since ? ` · tracking since ${act.since}` : ''}
            </p>
          </>
        )}
      </Panel>

      {act && act.perDay.length > 1 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Panel title="Activity by weekday">
            <WeekdayPattern perDay={act.perDay} />
          </Panel>
          <Panel title={`Deliverability — ${rangeLabel(range)}`}>
            <Funnel d={d} />
          </Panel>
        </div>
      )}
      {(!act || act.perDay.length <= 1) && (
        <Panel title={`Deliverability — ${rangeLabel(range)}`}>
          <Funnel d={d} />
        </Panel>
      )}

      <Panel title={`Bulk & scheduled sends per day — ${rangeLabel(range)}`}>
        {!sendDays.length ? (
          <p className="py-6 text-center text-sm text-gray-400">No sends in this period.</p>
        ) : (
          <DayChart
            data={sendDays}
            legend={[
              { value: 0, color: 'bg-wa', label: 'sent' },
              { value: 0, color: 'bg-gray-300', label: 'skipped' },
              { value: 0, color: 'bg-red-400', label: 'failed' },
            ]}
          />
        )}
        <p className="mt-2 text-right text-[11px] text-gray-400">
          {fmtNum(d.allTime.sent)} sent all-time · {fmtNum(d.allTime.failed)} failed
        </p>
      </Panel>

      <div className="grid gap-3 sm:grid-cols-2">
        <Panel title="Jobs by status">
          {Object.keys(d.jobs).length === 0 ? (
            <p className="py-4 text-center text-sm text-gray-400">No jobs yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {Object.entries(d.jobs).map(([status, n]) => (
                <li key={status} className="flex justify-between">
                  <span className="capitalize text-gray-600">{status.replace('_', ' ')}</span>
                  <span className="font-medium text-gray-800">{n}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Blacklist">
          <ul className="space-y-1 text-sm">
            <li className="flex justify-between">
              <span className="text-gray-600">Total numbers</span>
              <span className="font-medium text-gray-800">{d.blacklist.total}</span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-gray-600">Added · {rangeLabel(range)}</span>
              <span className="flex items-center gap-1.5">
                <span className="font-medium text-gray-800">{d.blacklist.added}</span>
                <Delta cur={d.blacklist.added} prev={d.prev.blacklistAdded} goodUp={false} />
              </span>
            </li>
          </ul>
        </Panel>
      </div>

      {d.topErrors.length > 0 && (
        <Panel title="Top failure reasons">
          <ul className="space-y-1.5">
            {d.topErrors.map((e) => (
              <li key={e.error} className="flex items-start justify-between gap-3 text-sm">
                <span className="min-w-0 break-words text-gray-600">{e.error}</span>
                <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-600">
                  ×{e.count}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

type Tab = 'overview' | 'agents' | 'server';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'server', label: 'Server' },
];

/** Read-only aggregates over the send ledger + live traffic counters. */
export default function InsightsPage() {
  const [range, setRange] = useState<AnalyticsRange>({ days: 30 });
  const [tab, setTab] = useState<Tab>('overview');
  // Full dashboard needs insights.view; agents with only viewOwn get their
  // own numbers ("My activity") — the server enforces the same split.
  const canViewAll = usePerm('insights.view');
  const summary = useQuery({
    queryKey: ['analytics', range],
    queryFn: () => api.analytics(range),
    staleTime: 60_000,
    enabled: canViewAll !== false,
  });

  if (canViewAll === false) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 overflow-y-auto p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-800">My activity</h2>
            <p className="text-sm text-gray-500">Your sends across chats and jobs.</p>
          </div>
          <RangePicker range={range} onChange={setRange} />
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <AgentActivity range={range} mineOnly />
        </div>
      </div>
    );
  }

  const d = summary.data;

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto">
      {/* sticky control bar: title, export, range picker, tabs */}
      <div className="sticky top-0 z-10 space-y-3 border-b border-gray-200 bg-gray-50/95 p-4 backdrop-blur">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-800">Insights</h2>
            <p className="text-sm text-gray-500">Chat traffic, send activity, delivery, and server health.</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <a
              href={api.analyticsCsvUrl(range)}
              download
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
            >
              ⬇ CSV
            </a>
            <RangePicker range={range} onChange={setRange} />
          </div>
        </div>
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                tab === t.id ? 'bg-wa text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4 p-4">
        {summary.isLoading && <p className="py-10 text-center text-sm text-gray-400">Loading…</p>}
        {summary.isError && (
          <p role="alert" className="py-10 text-center text-sm text-red-500">
            Could not load analytics — {(summary.error as Error).message}
          </p>
        )}

        {d && tab === 'overview' && <Overview d={d} range={range} />}
        {tab === 'agents' && (
          <Panel title={`By agent — ${rangeLabel(range)}`}>
            <AgentActivity range={range} mineOnly={false} />
          </Panel>
        )}
        {tab === 'server' && <ServerHealth />}
      </div>
    </div>
  );
}
