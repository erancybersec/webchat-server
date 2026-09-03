import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { agentBadgeClass, agentLabel, useAgents, useMe } from '../../lib/agents';
import { api } from '../../lib/api';
import { useReminders } from '../../lib/workbench';
import type { AgentPresenceEntry, AiState, ChatMeta, ChatWorkStatus, Reminder } from '../../types';

const STATUS_OPTIONS: Array<{ id: ChatWorkStatus; label: string; cls: string }> = [
  { id: 'open', label: 'Open', cls: 'bg-blue-100 text-blue-700' },
  { id: 'pending', label: 'Pending', cls: 'bg-amber-100 text-amber-700' },
  { id: 'resolved', label: 'Resolved', cls: 'bg-green-100 text-green-700' },
];

function remindPresets(): Array<{ label: string; at: () => Date }> {
  return [
    { label: 'In 1 hour', at: () => new Date(Date.now() + 3600_000) },
    {
      label: 'Tomorrow 09:00',
      at: () => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        return d;
      },
    },
    {
      label: 'In 3 days',
      at: () => {
        const d = new Date(Date.now() + 3 * 86_400_000);
        d.setHours(9, 0, 0, 0);
        return d;
      },
    },
  ];
}

/** How each AI state reads in the bar, and what it means for the operator. */
const AI_PILL: Record<AiState, { label: string; cls: string; title: string }> = {
  ACTIVE: {
    label: 'AI answering',
    cls: 'bg-violet-100 text-violet-700',
    title: 'The AI is answering this conversation automatically',
  },
  PAUSED: {
    label: 'AI paused',
    cls: 'bg-gray-100 text-gray-600',
    title: 'Someone took this chat over — the AI stays paused until it is explicitly resumed',
  },
  HANDOFF_REQUESTED: {
    label: 'handed off',
    cls: 'bg-amber-100 text-amber-700',
    title: 'The AI asked for a person',
  },
  LIMIT_REACHED: {
    label: 'AI limit reached',
    cls: 'bg-gray-100 text-gray-600',
    title: 'This conversation used its reply allowance; it resets when the lead comes back after the session gap',
  },
};

export interface WorkbenchBarProps {
  /** Canonical jid (server chat-meta key) for this conversation. */
  jid: string;
  meta: ChatMeta | undefined;
  /** Other agents currently viewing/typing in this chat. */
  others: AgentPresenceEntry[];
}

/**
 * The agent-workbench strip under a thread header: workflow status,
 * assignment, tags, internal notes, and follow-up reminders. Deliberately
 * separate from read/unread — that keeps mimicking WhatsApp Web.
 */
export default function WorkbenchBar({ jid, meta, others }: WorkbenchBarProps) {
  const qc = useQueryClient();
  const me = useMe();
  const roster = useAgents();
  const agentsByEmail = new Map((roster.data ?? []).map((a) => [a.email, a]));
  const invalidateMeta = () => void qc.invalidateQueries({ queryKey: ['chat-meta'] });

  const status = meta?.statuses[jid]?.status ?? 'open';
  const assignment = meta?.assignments[jid];
  const tags = meta?.tags[jid] ?? [];
  // Only present once the AI has actually engaged with this chat (or someone
  // took it over) — so the bar stays clean everywhere the feature is unused.
  const aiState = meta?.aiStates?.[jid];

  const [assignOpen, setAssignOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);
  const [remindNote, setRemindNote] = useState('');
  const [remindAt, setRemindAt] = useState('');
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!assignOpen && !tagsOpen && !remindOpen) return;
    const close = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) {
        setAssignOpen(false);
        setTagsOpen(false);
        setRemindOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [assignOpen, tagsOpen, remindOpen]);

  const setStatus = useMutation({
    mutationFn: (s: ChatWorkStatus) => api.chatMeta.setStatus(jid, s),
    onSuccess: invalidateMeta,
  });
  const assign = useMutation({
    mutationFn: (email: string | null) => api.chatMeta.assign(jid, email),
    onSuccess: () => {
      setAssignOpen(false);
      invalidateMeta();
    },
  });
  const saveTags = useMutation({
    mutationFn: (next: string[]) => api.chatMeta.setTags(jid, next),
    onSuccess: invalidateMeta,
  });

  // Take Over is ONE request: it claims the chat and pauses the AI together, so
  // there is no window where the assignment landed and the pause didn't.
  const takeOver = useMutation({
    mutationFn: () => api.chatMeta.takeOver(jid),
    onSuccess: invalidateMeta,
  });
  // Resume is refused server-side while a human still owns the chat; being
  // unassigned again is necessary but not sufficient — someone has to say so.
  const resumeAi = useMutation({
    mutationFn: () => api.chatMeta.resumeAi(jid),
    onSuccess: invalidateMeta,
  });
  const aiActivity = useQuery({
    queryKey: ['ai-audit', jid],
    queryFn: () => api.aiAgent.audit(jid, 10),
    enabled: aiOpen,
  });

  const notes = useQuery({
    queryKey: ['chat-notes', jid],
    queryFn: () => api.chatMeta.notes(jid),
    enabled: notesOpen,
  });
  const addNote = useMutation({
    mutationFn: (body: string) => api.chatMeta.addNote(jid, body),
    onSuccess: () => {
      setNoteDraft('');
      void qc.invalidateQueries({ queryKey: ['chat-notes', jid] });
    },
  });
  const removeNote = useMutation({
    mutationFn: (id: number) => api.chatMeta.removeNote(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['chat-notes', jid] }),
  });

  const remindersQ = useReminders();
  const fired = (remindersQ.data ?? []).filter(
    (r): r is Reminder => r.chatJid === jid && r.status === 'fired',
  );
  const upcoming = (remindersQ.data ?? []).filter(
    (r) => r.chatJid === jid && r.status === 'pending',
  );
  const createReminder = useMutation({
    mutationFn: (input: { dueAt: string; note: string }) =>
      api.reminders.create(jid, input.dueAt, input.note),
    onSuccess: () => {
      setRemindOpen(false);
      setRemindNote('');
      setRemindAt('');
      void qc.invalidateQueries({ queryKey: ['reminders'] });
    },
  });
  const dismissReminder = useMutation({
    mutationFn: (id: number) => api.reminders.dismiss(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reminders'] }),
  });

  function commitTag() {
    const t = tagDraft.trim();
    if (!t) return;
    setTagDraft('');
    if (!tags.includes(t)) saveTags.mutate([...tags, t]);
  }

  const assignedAgent = assignment ? agentsByEmail.get(assignment.agentEmail) : undefined;
  const mine = !!me.data?.email && assignment?.agentEmail === me.data.email;

  return (
    <div ref={popRef} className="border-b border-gray-200 bg-white px-3 py-1.5 text-xs">
      {/* mobile: one horizontally-scrollable row (no wrap) so the workbench
          never steals a second row above the conversation; desktop wraps. */}
      <div className="flex items-center gap-1.5 overflow-x-auto md:flex-wrap md:overflow-visible [&>*]:shrink-0 md:[&>*]:shrink">
        {/* workflow status — additive overlay, never touches read/unread */}
        <div className="flex overflow-hidden rounded-full border border-gray-200">
          {STATUS_OPTIONS.map((o) => (
            <button
              key={o.id}
              onClick={() => status !== o.id && setStatus.mutate(o.id)}
              disabled={setStatus.isPending}
              className={`px-2 py-0.5 font-medium transition-colors ${
                status === o.id ? o.cls : 'text-gray-400 hover:bg-gray-50'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* assignment */}
        <div className="relative">
          <button
            onClick={() => setAssignOpen(!assignOpen)}
            className={`rounded-full px-2 py-0.5 font-medium ${
              assignment
                ? agentBadgeClass(assignedAgent?.color ?? '')
                : 'border border-dashed border-gray-300 text-gray-400 hover:border-gray-400'
            }`}
            title={assignment ? `Assigned to ${assignment.agentEmail}` : 'Assign this chat'}
          >
            👤 {assignment ? agentLabel(assignedAgent ?? { email: assignment.agentEmail }) : 'Assign'}
          </button>
          {assignOpen && (
            <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
              {me.data?.email && !mine && (
                <button
                  onClick={() => assign.mutate(me.data!.email)}
                  className="block w-full px-3 py-1.5 text-left font-medium text-wa-dark hover:bg-green-50"
                >
                  Claim — assign to me
                </button>
              )}
              {(roster.data ?? [])
                .filter((a) => a.active && a.email !== assignment?.agentEmail)
                .map((a) => (
                  <button
                    key={a.email}
                    onClick={() => assign.mutate(a.email)}
                    className="block w-full truncate px-3 py-1.5 text-left hover:bg-gray-50"
                    title={a.email}
                  >
                    {agentLabel(a)}
                  </button>
                ))}
              {assignment && (
                <button
                  onClick={() => assign.mutate(null)}
                  className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                >
                  Unassign
                </button>
              )}
            </div>
          )}
        </div>

        {/* AI agent: what it is doing here, and the two ways to change that.
            Note the pill is NOT derived from `assignment` — human ownership and
            the AI's resume latch are separate facts on purpose. */}
        {aiState && (
          <>
            <button
              onClick={() => setAiOpen(!aiOpen)}
              title={
                AI_PILL[aiState.state].title +
                (aiState.reason ? ` — ${aiState.reason}` : '') +
                '. Click for the AI activity log.'
              }
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${AI_PILL[aiState.state].cls}`}
            >
              🤖 {AI_PILL[aiState.state].label}
              {aiState.state === 'HANDOFF_REQUESTED' && aiState.reason && (
                <span className="max-w-[14rem] truncate font-normal opacity-80" dir="auto">
                  — {aiState.reason}
                </span>
              )}
            </button>
            {aiState.state === 'ACTIVE' && (
              <button
                onClick={() => takeOver.mutate()}
                disabled={takeOver.isPending}
                title="Claim this chat and stop the AI answering it"
                className="rounded-full border border-violet-300 px-2 py-0.5 font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50"
              >
                Take over
              </button>
            )}
            {aiState.state !== 'ACTIVE' && !assignment && (
              <button
                onClick={() => resumeAi.mutate()}
                disabled={resumeAi.isPending}
                title="Let the AI answer this conversation again"
                className="rounded-full border border-violet-300 px-2 py-0.5 font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50"
              >
                Resume AI
              </button>
            )}
          </>
        )}

        {/* tags */}
        {tags.map((t) => (
          <span key={t} className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-gray-600" dir="auto">
            🏷 {t}
            <button
              onClick={() => saveTags.mutate(tags.filter((x) => x !== t))}
              aria-label={`Remove tag ${t}`}
              className="text-gray-400 hover:text-red-500"
            >
              ✕
            </button>
          </span>
        ))}
        <div className="relative">
          <button
            onClick={() => setTagsOpen(!tagsOpen)}
            className="rounded-full border border-dashed border-gray-300 px-2 py-0.5 text-gray-400 hover:border-gray-400"
          >
            + tag
          </button>
          {tagsOpen && (
            <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitTag();
                  }
                }}
                placeholder="New tag…"
                dir="auto"
                autoFocus
                className="mb-1 w-full rounded-md border border-gray-300 px-2 py-1"
              />
              {(meta?.allTags ?? [])
                .filter((t) => !tags.includes(t) && (!tagDraft.trim() || t.toLowerCase().includes(tagDraft.toLowerCase())))
                .slice(0, 6)
                .map((t) => (
                  <button
                    key={t}
                    onClick={() => saveTags.mutate([...tags, t])}
                    className="block w-full rounded px-2 py-1 text-left hover:bg-gray-50"
                    dir="auto"
                  >
                    🏷 {t}
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* reminders */}
        <div className="relative">
          <button
            onClick={() => setRemindOpen(!remindOpen)}
            className={`rounded-full px-2 py-0.5 ${
              upcoming.length
                ? 'bg-amber-50 font-medium text-amber-700'
                : 'border border-dashed border-gray-300 text-gray-400 hover:border-gray-400'
            }`}
            title={upcoming.length ? `Reminder ${new Date(upcoming[0]!.dueAt).toLocaleString()}` : 'Remind me about this chat'}
          >
            ⏰ {upcoming.length ? new Date(upcoming[0]!.dueAt).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Remind'}
          </button>
          {remindOpen && (
            <div className="absolute left-0 top-full z-20 mt-1 w-60 rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
              <div className="mb-1.5 flex flex-wrap gap-1">
                {remindPresets().map((p) => (
                  <button
                    key={p.label}
                    onClick={() => createReminder.mutate({ dueAt: p.at().toISOString(), note: remindNote })}
                    className="rounded-full bg-green-50 px-2 py-0.5 font-medium text-wa-dark hover:bg-green-100"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                type="datetime-local"
                value={remindAt}
                onChange={(e) => setRemindAt(e.target.value)}
                className="mb-1 w-full rounded-md border border-gray-300 px-2 py-1"
              />
              <input
                value={remindNote}
                onChange={(e) => setRemindNote(e.target.value)}
                placeholder="Note (optional)…"
                dir="auto"
                className="mb-1.5 w-full rounded-md border border-gray-300 px-2 py-1"
              />
              <button
                onClick={() =>
                  remindAt && createReminder.mutate({ dueAt: new Date(remindAt).toISOString(), note: remindNote })
                }
                disabled={!remindAt || createReminder.isPending}
                className="w-full rounded-md bg-wa py-1 font-medium text-white hover:bg-wa-dark disabled:opacity-50"
              >
                Set reminder
              </button>
              {upcoming.map((r) => (
                <div key={r.id} className="mt-1.5 flex items-center justify-between gap-2 rounded bg-amber-50 px-2 py-1 text-amber-800">
                  <span className="min-w-0 truncate">
                    {new Date(r.dueAt).toLocaleString()} {r.note && `— ${r.note}`}
                  </span>
                  <button
                    onClick={() => dismissReminder.mutate(r.id)}
                    className="shrink-0 text-amber-600 hover:text-red-600"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* notes toggle */}
        <button
          onClick={() => setNotesOpen(!notesOpen)}
          className={`rounded-full px-2 py-0.5 ${
            notesOpen ? 'bg-yellow-100 font-medium text-yellow-800' : 'border border-dashed border-gray-300 text-gray-400 hover:border-gray-400'
          }`}
        >
          📝 Notes
        </button>

        {/* teammates in this chat right now */}
        {others.length > 0 && (
          <span className="ml-auto flex items-center gap-1 font-medium text-purple-600">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-purple-500" />
            {others
              .map((o) => {
                const a = agentsByEmail.get(o.email);
                return `${agentLabel(a ?? { email: o.email })}${o.typing ? ' is typing…' : ' is viewing'}`;
              })
              .join(' · ')}
          </span>
        )}
      </div>

      {/* pending banner — a quiet, persistent reminder that this chat still
          needs work, with a one-tap way to clear it. Only while status=pending. */}
      {status === 'pending' && (
        <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-amber-800">
          <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          <span className="min-w-0 truncate font-medium">This chat is marked Pending</span>
          <button
            onClick={() => setStatus.mutate('resolved')}
            disabled={setStatus.isPending}
            className="ml-auto shrink-0 rounded border border-amber-300 px-2 py-0.5 font-medium hover:bg-amber-100 disabled:opacity-50"
          >
            Mark resolved
          </button>
        </div>
      )}

      {/* AI activity — what the AI actually did here, per turn. The delivery
          outcome is the interesting column: a generated turn that was canceled
          by a take-over or a newer message still has a row. */}
      {aiOpen && aiState && (
        <div className="mt-1.5 rounded-lg border border-violet-200 bg-violet-50/60 p-2">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-violet-800">AI activity</p>
            <span className="text-[10px] text-violet-600">
              {aiState.replyCount} repl{aiState.replyCount === 1 ? 'y' : 'ies'} this session
              {aiState.changedBy && ` · last changed by ${aiState.changedBy}`}
            </span>
          </div>
          {aiActivity.isLoading && <p className="py-1 text-gray-400">Loading…</p>}
          {aiActivity.isError && (
            <p className="py-1 text-gray-400">Only admins can read the AI activity log.</p>
          )}
          {aiActivity.data?.rows.length === 0 && (
            <p className="py-1 text-gray-400">No AI turns recorded for this chat yet.</p>
          )}
          <div className="mt-1 max-h-48 space-y-1 overflow-y-auto">
            {(aiActivity.data?.rows ?? []).map((r) => (
              <div key={r.id} className="rounded bg-white/80 px-2 py-1">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-gray-500">
                  <span>{new Date(r.createdAt).toLocaleString()}</span>
                  <span
                    className={`rounded px-1 ${
                      r.deliveryOutcome === 'sent'
                        ? 'bg-green-100 text-green-700'
                        : r.deliveryOutcome === 'failed'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {r.deliveryOutcome ?? 'pending'}
                  </span>
                  {r.handoff && (
                    <span className="rounded bg-amber-100 px-1 text-amber-700">
                      handoff{r.handoffReason ? `: ${r.handoffReason}` : ''}
                    </span>
                  )}
                  <span>{r.model}</span>
                  {r.latencyMs != null && <span>{r.latencyMs} ms</span>}
                  {r.inputTokens != null && (
                    <span>
                      {r.inputTokens} in / {r.outputTokens ?? 0} out
                    </span>
                  )}
                </div>
                {r.responseText && (
                  <p className="whitespace-pre-wrap break-words text-gray-700" dir="auto">
                    {r.responseText}
                  </p>
                )}
                {r.error && <p className="text-red-600">{r.error}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* fired reminder banner */}
      {fired.map((r) => (
        <div key={r.id} className="mt-1.5 flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-amber-800">
          <span className="min-w-0 truncate" dir="auto">
            ⏰ Follow-up due{r.note ? `: ${r.note}` : ''} ({new Date(r.dueAt).toLocaleString()})
          </span>
          <button
            onClick={() => dismissReminder.mutate(r.id)}
            className="shrink-0 rounded border border-amber-300 px-2 py-0.5 font-medium hover:bg-amber-100"
          >
            Done
          </button>
        </div>
      ))}

      {/* internal notes — never enter any send path */}
      {notesOpen && (
        <div className="mt-1.5 rounded-lg border border-yellow-200 bg-yellow-50/70 p-2">
          {notes.isLoading && <p className="py-1 text-gray-400">Loading notes…</p>}
          {!notes.isLoading && !(notes.data ?? []).length && (
            <p className="py-1 text-gray-400">No internal notes yet — visible to agents only, never sent.</p>
          )}
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {(notes.data ?? []).map((n) => (
              <div key={n.id} className="group flex items-start gap-2 rounded bg-white/70 px-2 py-1">
                <div className="min-w-0 flex-1">
                  <span className="whitespace-pre-wrap break-words text-gray-700" dir="auto">
                    {n.body}
                  </span>
                  <span className="ml-2 text-[10px] text-gray-400">
                    {agentLabel(agentsByEmail.get(n.agentEmail) ?? { email: n.agentEmail || '?' })} ·{' '}
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </div>
                {(n.agentEmail === me.data?.email || !me.data?.enabled || me.data.perms?.['agents.manage']) && (
                  <button
                    onClick={() => removeNote.mutate(n.id)}
                    aria-label="Delete note"
                    className="shrink-0 text-gray-300 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
          <form
            className="mt-1.5 flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (noteDraft.trim()) addNote.mutate(noteDraft.trim());
            }}
          >
            <input
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Add an internal note…"
              dir="auto"
              className="min-w-0 flex-1 rounded-md border border-yellow-300 bg-white px-2 py-1"
            />
            <button
              type="submit"
              disabled={!noteDraft.trim() || addNote.isPending}
              className="rounded-md bg-yellow-500 px-3 py-1 font-medium text-white hover:bg-yellow-600 disabled:opacity-50"
            >
              Add
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
