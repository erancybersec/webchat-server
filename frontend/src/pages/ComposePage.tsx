import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import QueueEditor, { finalizeItems, validateItem } from '../components/QueueEditor';
import RecipientChips from '../components/RecipientChips';
import SendProgress from '../components/SendProgress';
import { api } from '../lib/api';
import { batchSummary, clockLabel, coldCapCaveat, estimateFinish } from '../lib/campaign';
import { clearComposeDraft, peekComposeDraft } from '../lib/composeDraft';
import { navigate as gotoJob } from '../lib/nav';
import { useJobSend } from '../lib/useJobSend';
import { useNeedsApproval } from '../lib/workbench';
import type { BatchRule, Job, JobItem, Recipient, RepeatFreq } from '../types';

const REPEAT_OPTIONS: Array<{ value: RepeatFreq | ''; label: string }> = [
  { value: '', label: 'No repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

/** datetime-local wants local wall-clock time, not the ISO/UTC string. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** v1-parity Compose: recipient chips + an ordered multi-item Message Sequence. */
export default function ComposePage() {
  const qc = useQueryClient();
  // Draft handed over by "Edit" / "Edit & resend" on the Scheduled/History
  // tabs — peek (not consume) because StrictMode runs initializers twice.
  const [draft] = useState(peekComposeDraft);
  useEffect(() => {
    clearComposeDraft();
  }, []);
  const editingJobId = draft?.jobId;
  const [recipients, setRecipients] = useState<Recipient[]>(draft?.recipients ?? []);
  const [items, setItems] = useState<JobItem[]>(() =>
    draft?.items.length
      ? // fresh _k keys: the editor needs stable list identity for drag/reorder
        draft.items.map((it) => ({ ...it, data: { ...it.data, _k: crypto.randomUUID() } }))
      : [{ type: 'text', data: { text: '' } }],
  );
  const [when, setWhen] = useState(() =>
    draft?.scheduledAt ? toLocalInput(draft.scheduledAt) : '',
  );
  const [showSchedule, setShowSchedule] = useState(!!editingJobId);
  const [repeatFreq, setRepeatFreq] = useState<RepeatFreq | ''>(draft?.repeat?.freq ?? '');
  const [repeatUntil, setRepeatUntil] = useState(() =>
    draft?.repeat?.until ? toLocalInput(draft.repeat.until) : '',
  );
  // Campaign pacing — two independent controls, off unless the send is big
  // enough to want them (or the job being edited already has them).
  // 1. the sending window: run until an hour, continue at another
  const [windowOn, setWindowOn] = useState(!!draft?.batch?.pauseAt);
  const [pauseAt, setPauseAt] = useState(draft?.batch?.pauseAt ?? '21:00');
  const [resumeAt, setResumeAt] = useState(draft?.batch?.resumeAt ?? '09:00');
  const [autoResume, setAutoResume] = useState(!!draft?.batch?.resumeAt);
  // 2. batches: stop every N messages
  const [batchOn, setBatchOn] = useState(!!draft?.batch?.size);
  const [batchSize, setBatchSize] = useState(String(draft?.batch?.size ?? 50));
  const [batchAuto, setBatchAuto] = useState((draft?.batch?.pauseMin ?? 30) > 0);
  const [batchPauseMin, setBatchPauseMin] = useState(String(draft?.batch?.pauseMin || 30));
  const [randomizeWait, setRandomizeWait] = useState(!!draft?.batch?.pauseMinMax);
  const [batchPauseMax, setBatchPauseMax] = useState(
    String(draft?.batch?.pauseMinMax ?? draft?.batch?.pauseMin ?? 30),
  );
  // 3. Advanced: override this line's cold-contact cap for this send only —
  // collapsed unless a loaded draft already carries one, so it stays out of
  // the way for the common case
  const [advancedOpen, setAdvancedOpen] = useState(!!draft?.batch?.coldCap || !!draft?.batch?.delay);
  const [coldCapOn, setColdCapOn] = useState(!!draft?.batch?.coldCap);
  const [coldCapDaily, setColdCapDaily] = useState(String(draft?.batch?.coldCap?.dailyCap ?? 50));
  // 4. Advanced: override this send's delay between messages, in place of the
  // Settings default
  const [delayOverrideOn, setDelayOverrideOn] = useState(!!draft?.batch?.delay);
  const [delayMinOverride, setDelayMinOverride] = useState(String(draft?.batch?.delay?.minSec ?? 1));
  const [delayMaxOverride, setDelayMaxOverride] = useState(String(draft?.batch?.delay?.maxSec ?? 3));
  const [feedback, setFeedback] = useState('');
  // set alongside `feedback` when the message is about a specific paused
  // campaign, so the line can offer a straight jump to its live progress
  const [feedbackJobId, setFeedbackJobId] = useState<string | null>(null);
  const { progress, setProgress, run } = useJobSend();
  // the repeat picker only appears when the server-side safety toggle is on
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get, staleTime: 60_000 });
  const recurringEnabled = !!settings.data?.recurringEnabled;

  const itemErrors = items.map(validateItem);
  const ready = recipients.length > 0 && items.length > 0 && itemErrors.every((e) => !e);

  const { needed: willNeedApproval } = useNeedsApproval(recipients.length);
  const limits = useQuery({ queryKey: ['sending-limits'], queryFn: api.sendingLimits, staleTime: 30_000 });
  // How many of the current chips are strangers to this line vs. already in a
  // conversation, so the ration hint below can use a real count instead of
  // assuming worst case.
  const classification = useQuery({
    queryKey: ['classify-recipients', recipients.map((r) => r.id).join(',')],
    queryFn: () => api.classifyRecipients(recipients),
    enabled: recipients.length > 0,
    staleTime: 15_000,
  });
  const coldCount = classification.data?.cold ?? null;
  // an active override governs this send instead of the line's fetched ration
  const coldCapDailyNum = Math.max(1, Math.round(Number(coldCapDaily) || 1));
  const coldLeft = coldCapOn
    ? Math.max(0, coldCapDailyNum - (limits.data?.coldContacts.spent ?? 0))
    : limits.data?.coldContacts.enabled
      ? limits.data.coldContacts.remaining
      : null;
  const overRation = coldLeft != null && (coldCount ?? recipients.length) > coldLeft;
  const coldCaveat = limits.data
    ? coldCapCaveat(
        recipients.length,
        limits.data.coldContacts,
        coldCapOn ? { dailyCap: coldCapDailyNum } : undefined,
      )
    : null;

  // A paused campaign is edited in place: its send ledger already records who
  // received the message, so the edit only reaches the rest — and the sequence
  // has to keep its shape (the server refuses an added or removed item).
  const partlySent = !!draft?.partlySent;
  const messages = recipients.length * items.length;
  const delayMinNum = Math.max(0, Number(delayMinOverride) || 0);
  const delayMaxNum = Math.max(delayMinNum, Number(delayMaxOverride) || delayMinNum);
  const avgDelaySec = delayOverrideOn
    ? (delayMinNum + delayMaxNum) / 2
    : ((settings.data?.delayMin ?? 1) + (settings.data?.delayMax ?? 3)) / 2;
  // the server's zone + its current clock, shown next to the window's hours
  const serverZone = settings.data
    ? `${settings.data.timezone}, now ${new Date(settings.data.serverTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '';

  /** undefined = leave the job's pacing alone; null = clear it. */
  function batchRule(): BatchRule | null | undefined {
    if (!windowOn && !batchOn && !coldCapOn && !delayOverrideOn) return partlySent ? undefined : null;
    const rule: BatchRule = {
      pauseMin: batchOn && batchAuto ? Math.max(0, Math.round(Number(batchPauseMin) || 0)) : 0,
    };
    if (batchOn) {
      rule.size = Math.max(1, Math.round(Number(batchSize) || 1));
      if (batchAuto && randomizeWait) {
        const max = Math.max(1, Math.round(Number(batchPauseMax) || 0));
        if (max > rule.pauseMin) rule.pauseMinMax = max;
      }
    }
    if (windowOn) {
      rule.pauseAt = pauseAt;
      if (autoResume) rule.resumeAt = resumeAt;
    }
    if (coldCapOn) rule.coldCap = { dailyCap: coldCapDailyNum };
    if (delayOverrideOn) rule.delay = { minSec: delayMinNum, maxSec: delayMaxNum };
    return rule;
  }
  const rule = windowOn || batchOn || coldCapOn || delayOverrideOn ? (batchRule() ?? null) : null;
  // an honest finish moment even for an unbroken run — Compose shouldn't ever
  // say nothing about when a send will be done, paced or not
  const est = messages > 0 ? estimateFinish(rule ?? { pauseMin: 0 }, messages, avgDelaySec) : null;

  async function sendNow() {
    setFeedback('');
    setFeedbackJobId(null);
    try {
      const result = await run(recipients, finalizeItems(items), batchRule() ?? null);
      setFeedback(
        result.held
          ? 'Submitted for approval — it sends once an approver releases it (Scheduled tab)'
          : result.paused
            ? 'First batch sent — the campaign card in History pauses, continues and logs the rest'
            : 'Done — full record in the History tab',
      );
    } catch (e) {
      setFeedback(String((e as Error).message));
    } finally {
      qc.invalidateQueries({ queryKey: ['jobs'] });
    }
  }

  /** @returns the saved job, or null if the save failed (feedback already set). */
  async function schedule(): Promise<Job | null> {
    setFeedback('');
    setFeedbackJobId(null);
    setProgress(null);
    try {
      // while recurring is disabled in Settings the field is omitted entirely,
      // so an edit never accidentally clears (or trips on) an existing rule
      const repeat = !recurringEnabled
        ? undefined
        : repeatFreq
          ? {
              freq: repeatFreq,
              ...(repeatUntil ? { until: new Date(repeatUntil).toISOString() } : {}),
            }
          : null;
      const batch = batchRule();
      const saved = await api.jobs.save({
        // updates the original pending (or paused) job in place when editing
        id: editingJobId,
        scheduledAt: new Date(when).toISOString(),
        recipients,
        items: finalizeItems(items),
        ...(repeat !== undefined ? { repeat } : {}),
        ...(batch !== undefined ? { batch } : {}),
      });
      setFeedback(
        saved.status === 'pending_approval'
          ? `Submitted for approval — once released it fires ${new Date(when).toLocaleString()}`
          : partlySent
            ? 'Saved — the recipients still to go get the new message.'
            : editingJobId
              ? `Scheduled job updated — fires ${new Date(when).toLocaleString()}`
              : `Scheduled for ${new Date(when).toLocaleString()} → Scheduled tab`,
      );
      if (partlySent && saved.status !== 'pending_approval') setFeedbackJobId(saved.id);
      setShowSchedule(false);
      qc.invalidateQueries({ queryKey: ['jobs'] });
      return saved;
    } catch (e) {
      setFeedback(String((e as Error).message));
      return null;
    }
  }

  /** Save the paused campaign's edits, then pick it back up right away. */
  async function saveAndContinue() {
    const saved = await schedule();
    if (!saved || saved.status === 'pending_approval') return;
    try {
      await api.jobs.resume(saved.id);
      setFeedback('Saved — continuing the campaign now.');
      setFeedbackJobId(saved.id);
      qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (e) {
      setFeedback(String((e as Error).message));
      setFeedbackJobId(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 overflow-y-auto p-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">Compose &amp; Send</h2>
        <p className="text-sm text-gray-500">
          Build a message sequence and send it to one or multiple recipients in one click.
        </p>
      </div>

      {editingJobId && !partlySent && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
          Editing a scheduled job — <b>Confirm</b> under 🕐 Schedule saves your changes to it.
          The Send button sends right now and leaves the scheduled copy untouched.
        </div>
      )}
      {partlySent && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
          Editing an <b>in-progress campaign</b>. Everyone it already sent to keeps what they got — your
          changes only reach the recipients still to go. You can reword the messages and change the
          recipient list, but <b>not add or remove a message</b> in the sequence.
        </div>
      )}
      {draft && !editingJobId && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-wa-dark">
          Loaded from History — edit anything below, then send or schedule it as a new job.
        </div>
      )}

      <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">
            Recipient(s) <span className="text-red-400">*</span>
          </label>
          <RecipientChips value={recipients} onChange={setRecipients} />
          {classification.data && (
            <p className="mt-1.5 text-xs text-gray-500">
              <b>{classification.data.cold}</b> never contacted this line before,{' '}
              <b>{classification.data.known}</b> already in a conversation
              {classification.data.groups > 0 ? `, ${classification.data.groups} group(s)` : ''}.
            </p>
          )}
        </div>

        {overRation && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <p>
              This line may reach <b>{coldLeft}</b> more first-time contacts today. Anyone already
              in a conversation with it still gets the message right away — the rest carry over to
              the following days on their own, and the campaign card says so while it waits.
            </p>
            {coldCaveat && <p className="mt-1">{coldCaveat}</p>}
          </div>
        )}

        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">Message Sequence</label>
          <QueueEditor items={items} onChange={setItems} />
        </div>

        {/* A paused campaign is saved, never re-sent from here: "Send" would
            create a brand-new job and message everyone a second time. */}
        {partlySent ? (
          <div className="flex gap-2">
            <button
              onClick={() => void schedule()}
              disabled={!ready || !when}
              className="flex-1 rounded-lg border border-wa px-4 py-2.5 text-sm font-semibold text-wa-dark hover:bg-green-50 disabled:opacity-50"
            >
              Save changes
            </button>
            <button
              onClick={() => void saveAndContinue()}
              disabled={!ready || !when}
              title="Saves your edits, then picks the campaign back up right away"
              className="flex-1 rounded-lg bg-wa py-2.5 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
            >
              Save &amp; continue sending
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => void sendNow()}
              disabled={!ready || progress?.running}
              className="flex-1 rounded-lg bg-wa py-2.5 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
            >
              {willNeedApproval
                ? `Submit for approval (${recipients.length} recipients)`
                : `Send ${items.length > 1 ? `Sequence (${items.length})` : 'Message'} to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`}
            </button>
            <button
              onClick={() => setShowSchedule(!showSchedule)}
              className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-600 hover:border-wa hover:bg-green-50 hover:text-wa-dark"
            >
              🕐 Schedule
            </button>
          </div>
        )}

        {/* Campaign pacing — always visible, and applies to both buttons above
            (sending now starts the campaign). The two halves are independent:
            a sending window alone is the common case, batching is the extra. */}
        <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
          <p className="text-xs font-medium text-gray-700">
            Pacing for {messages.toLocaleString()} message{messages === 1 ? '' : 's'}
          </p>

          {/* 1 — the sending window */}
          <div className="space-y-1.5">
            <label className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={windowOn}
                onChange={(e) => setWindowOn(e.target.checked)}
                className="h-4 w-4 accent-wa"
              />
              <span className="font-medium text-gray-700">Send only between certain hours</span>
              {/* these hours are read on the SERVER — say whose clock that is,
                  so 21:00 can't quietly mean 21:00 somewhere else */}
              {windowOn && serverZone && (
                <span className="text-gray-400">server time · {serverZone}</span>
              )}
            </label>
            {windowOn && (
              <div className="flex flex-wrap items-center gap-2 pl-6 text-xs text-gray-600">
                <span>Pause at</span>
                <input
                  type="time"
                  value={pauseAt}
                  onChange={(e) => setPauseAt(e.target.value)}
                  className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
                />
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={autoResume}
                    onChange={(e) => setAutoResume(e.target.checked)}
                    className="h-4 w-4 accent-wa"
                  />
                  and continue at
                </label>
                <input
                  type="time"
                  value={resumeAt}
                  disabled={!autoResume}
                  onChange={(e) => setResumeAt(e.target.value)}
                  className="rounded-lg border border-gray-300 px-2 py-1 text-sm disabled:opacity-50"
                />
                {!autoResume && (
                  <span className="text-gray-400">(otherwise it waits for your Continue)</span>
                )}
              </div>
            )}
          </div>

          {/* 2 — batches, optional on top */}
          <div className="space-y-1.5">
            <label className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={batchOn}
                onChange={(e) => setBatchOn(e.target.checked)}
                className="h-4 w-4 accent-wa"
              />
              <span className="font-medium text-gray-700">Also stop every so many messages</span>
            </label>
            {batchOn && (
              <div className="flex flex-wrap items-center gap-2 pl-6 text-xs text-gray-600">
                <span>Send</span>
                <input
                  type="number"
                  min={1}
                  value={batchSize}
                  onChange={(e) => setBatchSize(e.target.value)}
                  className="w-20 rounded-lg border border-gray-300 px-2 py-1 text-sm"
                />
                <span>messages, then</span>
                <select
                  value={batchAuto ? 'auto' : 'manual'}
                  onChange={(e) => setBatchAuto(e.target.value === 'auto')}
                  className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
                >
                  <option value="auto">wait</option>
                  <option value="manual">wait for me</option>
                </select>
                {batchAuto && (
                  <>
                    <input
                      type="number"
                      min={0}
                      value={batchPauseMin}
                      onChange={(e) => setBatchPauseMin(e.target.value)}
                      className="w-20 rounded-lg border border-gray-300 px-2 py-1 text-sm"
                    />
                    <span>minutes</span>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={randomizeWait}
                        onChange={(e) => setRandomizeWait(e.target.checked)}
                        className="h-4 w-4 accent-wa"
                      />
                      randomize
                    </label>
                    {randomizeWait && (
                      <>
                        <span>up to</span>
                        <input
                          type="number"
                          min={1}
                          value={batchPauseMax}
                          onChange={(e) => setBatchPauseMax(e.target.value)}
                          className="w-20 rounded-lg border border-gray-300 px-2 py-1 text-sm"
                        />
                        <span>minutes</span>
                      </>
                    )}
                  </>
                )}
                {items.length > 1 && (
                  <span className="text-gray-400">
                    (a {items.length}-message sequence counts as {items.length} per recipient)
                  </span>
                )}
              </div>
            )}
          </div>

          {/* 3 — Advanced, collapsed: per-compose cold-contact cap and delay overrides */}
          <div className="space-y-1.5 border-t border-gray-200 pt-2">
            <button
              type="button"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="text-xs font-medium text-gray-500 hover:text-gray-700"
            >
              {advancedOpen ? '▾' : '▸'} Advanced
            </button>
            {advancedOpen && (
              <div className="space-y-1.5 pl-2">
                <label className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={coldCapOn}
                    onChange={(e) => setColdCapOn(e.target.checked)}
                    className="h-4 w-4 accent-wa"
                  />
                  <span className="font-medium text-gray-700">
                    Override today's cold-contact cap for this campaign
                  </span>
                </label>
                {coldCapOn && (
                  <div className="flex flex-wrap items-center gap-2 pl-6 text-xs text-gray-600">
                    <span>Reach up to</span>
                    <input
                      type="number"
                      min={1}
                      value={coldCapDaily}
                      onChange={(e) => setColdCapDaily(e.target.value)}
                      className="w-20 rounded-lg border border-gray-300 px-2 py-1 text-sm"
                    />
                    <span>first-time contacts per day, for this send only</span>
                  </div>
                )}
                <label className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={delayOverrideOn}
                    onChange={(e) => setDelayOverrideOn(e.target.checked)}
                    className="h-4 w-4 accent-wa"
                  />
                  <span className="font-medium text-gray-700">
                    Override the delay between messages for this send
                  </span>
                </label>
                {delayOverrideOn && (
                  <div className="flex flex-wrap items-center gap-2 pl-6 text-xs text-gray-600">
                    <span>Wait</span>
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={delayMinOverride}
                      onChange={(e) => setDelayMinOverride(e.target.value)}
                      className="w-16 rounded-lg border border-gray-300 px-2 py-1 text-sm"
                    />
                    <span>to</span>
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={delayMaxOverride}
                      onChange={(e) => setDelayMaxOverride(e.target.value)}
                      className="w-16 rounded-lg border border-gray-300 px-2 py-1 text-sm"
                    />
                    <span>seconds between messages, instead of the Settings default</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {rule ? (
            <p className="text-[11px] font-medium text-wa-dark">
              {batchSummary(rule, messages, avgDelaySec)}
            </p>
          ) : (
            <p className="text-[11px] text-gray-400">
              {messages.toLocaleString()} messages in one unbroken run (~{avgDelaySec}s apart). You
              can still pause it at any moment from the campaign card.
            </p>
          )}
          {/* the finish moment on its own, bold — separate from the how
              (batches, window) so the when is never buried in a long line */}
          {est && (
            <p className="text-[11px] font-semibold text-wa-dark">
              Finishes {clockLabel(est.finishAt.toISOString())}
            </p>
          )}
          <p className="text-[11px] text-gray-400">
            Pause, continue, edit-the-rest and the per-recipient log all live on the campaign card
            in Scheduled / History — it keeps going with the browser closed.
          </p>
        </div>

        {showSchedule && (
          <div className="space-y-2 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <p className="text-xs font-medium text-gray-700">
              Schedule this sequence (fires server-side — the browser can close)
            </p>
            <div className="flex items-center gap-2">
              <input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <button
                onClick={() => void schedule()}
                disabled={!ready || !when}
                className="rounded-lg bg-wa px-4 py-2 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
              >
                Confirm
              </button>
            </div>
            {recurringEnabled ? (
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs font-medium text-gray-600">Repeat</label>
                <select
                  value={repeatFreq}
                  onChange={(e) => setRepeatFreq(e.target.value as RepeatFreq | '')}
                  className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                >
                  {REPEAT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {repeatFreq && (
                  <>
                    <label className="text-xs font-medium text-gray-600">until</label>
                    <input
                      type="datetime-local"
                      value={repeatUntil}
                      onChange={(e) => setRepeatUntil(e.target.value)}
                      className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    />
                    {!repeatUntil && <span className="text-xs text-gray-400">(forever if empty)</span>}
                  </>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-gray-400">
                Repeating schedules are disabled — enable “Allow recurring jobs” in Settings to use
                them.
              </p>
            )}
          </div>
        )}

        {progress && <SendProgress progress={progress} />}
        {feedback && (
          <div className="text-sm text-wa-dark">
            {feedback}
            {feedbackJobId && (
              <button
                type="button"
                onClick={() => gotoJob({ job: feedbackJobId })}
                className="ml-1 font-semibold underline hover:no-underline"
              >
                View progress →
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
