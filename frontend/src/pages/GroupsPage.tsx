import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useConfirm } from '../components/Confirm';
import QueueEditor, { finalizeItems, validateItem } from '../components/QueueEditor';
import SendProgress from '../components/SendProgress';
import { useToast } from '../components/Toast';
import { api } from '../lib/api';
import { buildContactNames, displayNumber } from '../lib/chatModel';
import { useJobSend } from '../lib/useJobSend';
import { useNeedsApproval } from '../lib/workbench';
import type { JobItem } from '../types';

type SubTab = 'browse' | 'create' | 'manage';

interface BulkResult {
  jid: string;
  name: string;
  ok: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function useGroups() {
  return useQuery({ queryKey: ['groups'], queryFn: api.chats.groups, staleTime: 60_000 });
}

function groupName(groups: Array<Record<string, any>>, jid: string): string {
  return groups.find((g) => g.id === jid)?.subject ?? jid;
}

/** Alphabetical by subject (Hebrew-aware), falling back to the jid. */
function sortGroups(list: Array<Record<string, any>>): Array<Record<string, any>> {
  return [...list].sort((a, b) =>
    String(a.subject ?? a.id ?? '').localeCompare(String(b.subject ?? b.id ?? ''), 'he'),
  );
}

/* ── Browse & Send ─────────────────────────────────────────────────────── */

function BrowseTab({
  selected,
  setSelected,
  goManage,
}: {
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  goManage: () => void;
}) {
  const qc = useQueryClient();
  const groups = useGroups();
  const [filter, setFilter] = useState('');
  // start with an empty Text block already chosen, like Compose — the agent
  // can type a broadcast immediately instead of first clicking "+ Text".
  const [items, setItems] = useState<JobItem[]>(() => [{ type: 'text', data: { text: '' } }]);
  const [when, setWhen] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [feedback, setFeedback] = useState('');
  const { progress, setProgress, run } = useJobSend();

  const list = sortGroups(
    ((Array.isArray(groups.data) ? groups.data : []) as Array<Record<string, any>>)
      .filter((g) => g.id)
      .filter(
        (g) => !filter.trim() || String(g.subject ?? '').toLowerCase().includes(filter.toLowerCase()),
      ),
  );

  const ready = selected.size > 0 && items.length > 0 && items.every((i) => !validateItem(i));
  const recipients = [...selected].map((id) => ({ id, isGroup: true }));
  const { needed: willNeedApproval } = useNeedsApproval(selected.size);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  /** Same server-side job path as Compose "Send Now" — so a broadcast lands in
   *  History with a per-group ledger and survives a closed tab. */
  async function broadcast() {
    setFeedback('');
    try {
      const result = await run(recipients, finalizeItems(items));
      setFeedback(
        result.held
          ? 'Submitted for approval — it sends once an approver releases it (Scheduled tab)'
          : 'Broadcast done — full record in the History tab',
      );
    } catch (e) {
      setFeedback(`Broadcast failed — ${String((e as Error).message ?? e)}`);
    } finally {
      qc.invalidateQueries({ queryKey: ['jobs'] });
    }
  }

  async function schedule() {
    setFeedback('');
    setProgress(null);
    try {
      const saved = await api.jobs.save({
        scheduledAt: new Date(when).toISOString(),
        recipients,
        items: finalizeItems(items),
        type: 'group-broadcast',
      });
      setFeedback(
        saved.status === 'pending_approval'
          ? 'Submitted for approval — it fires once an approver releases it (Scheduled tab)'
          : `Scheduled for ${new Date(when).toLocaleString()} → Scheduled tab`,
      );
      setShowSchedule(false);
      qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (e) {
      setFeedback(`Scheduling failed — ${String((e as Error).message ?? e)}`);
    }
  }

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
      <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-800">My Groups</h3>
          <span className="text-xs text-gray-400">
            {groups.isLoading ? 'loading…' : `${list.length} groups`}
          </span>
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search groups…"
          dir="auto"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <div className="flex justify-between text-xs text-gray-500">
          <span>{selected.size} selected</span>
          <div className="flex gap-3">
            <button onClick={() => setSelected(new Set(list.map((g) => g.id)))} className="font-medium text-wa-dark hover:underline">
              Select All
            </button>
            <button onClick={() => setSelected(new Set())} className="font-medium text-gray-400 hover:text-gray-600">
              Clear
            </button>
          </div>
        </div>
        <div className="max-h-[55vh] space-y-1 overflow-y-auto pr-1">
          {groups.isError && <div className="py-4 text-sm text-red-500">{String(groups.error)}</div>}
          {list.map((g) => (
            <label
              key={g.id}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-gray-50"
            >
              <input
                type="checkbox"
                checked={selected.has(g.id)}
                onChange={() => toggle(g.id)}
                className="h-4 w-4 accent-(--color-wa)"
              />
              {g.pictureUrl ? (
                <img src={g.pictureUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-xs">👥</span>
              )}
              <span className="min-w-0 flex-1 truncate text-sm" dir="auto">
                {g.subject || g.id}
              </span>
              <span className="shrink-0 text-xs text-gray-400">{g.size ?? ''}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <button
          onClick={goManage}
          disabled={!selected.size}
          className="w-full rounded-xl border border-green-300 bg-green-50 py-2.5 text-sm font-semibold text-wa-dark hover:bg-green-100 disabled:opacity-40"
        >
          ⚙ Manage Selected Groups ({selected.size})
        </button>
        <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-800">Message Sequence</h3>
          <QueueEditor items={items} onChange={setItems} />
          <div className="flex gap-2">
            <button
              onClick={() => void broadcast()}
              disabled={!ready || progress?.running}
              className="flex-1 rounded-lg bg-wa py-2.5 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
            >
              {willNeedApproval ? 'Submit for approval' : 'Broadcast'} to {selected.size} group
              {selected.size === 1 ? '' : 's'}
            </button>
            <button
              onClick={() => setShowSchedule(!showSchedule)}
              className="rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-600 hover:border-wa hover:bg-green-50"
            >
              🕐
            </button>
          </div>
          {showSchedule && (
            <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 p-3">
              <input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <button
                onClick={() => void schedule()}
                disabled={!ready || !when}
                className="rounded-lg bg-wa px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Confirm
              </button>
            </div>
          )}
          {progress && <SendProgress progress={progress} />}
          {feedback && <div className="text-sm text-wa-dark">{feedback}</div>}
        </div>
      </div>
    </div>
  );
}

/* ── Create ────────────────────────────────────────────────────────────── */

function CreateTab() {
  const qc = useQueryClient();
  const [subject, setSubject] = useState('');
  const [desc, setDesc] = useState('');
  const [participants, setParticipants] = useState('');
  const [feedback, setFeedback] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.groups.create(
        subject,
        participants.split('\n').map((s) => s.trim()).filter(Boolean),
        desc || undefined,
      ),
    onSuccess: () => {
      setFeedback(`Group "${subject}" created`);
      setSubject('');
      setDesc('');
      setParticipants('');
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
    onError: (e) => setFeedback(`Create failed: ${String((e as Error).message)}`),
  });

  const ready = subject.trim() && participants.trim();
  return (
    <div className="max-w-xl space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <label className="block">
        <span className="text-sm font-medium text-gray-700">
          Group Name <span className="text-red-400">*</span>
        </span>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          dir="auto"
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-gray-700">Description</span>
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={3}
          dir="auto"
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-gray-700">
          Participants <span className="text-red-400">*</span>{' '}
          <span className="font-normal text-gray-400">(one per line, international format)</span>
        </span>
        <textarea
          value={participants}
          onChange={(e) => setParticipants(e.target.value)}
          rows={5}
          placeholder={'972501234567\n972509876543'}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
        />
      </label>
      <button
        onClick={() => create.mutate()}
        disabled={!ready || create.isPending}
        className="w-full rounded-lg bg-wa py-2.5 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
      >
        + Create Group
      </button>
      {feedback && <div className="text-sm text-wa-dark">{feedback}</div>}
    </div>
  );
}

/* ── Manage ────────────────────────────────────────────────────────────── */

function ManageTab({ selected, setSelected }: { selected: Set<string>; setSelected: (s: Set<string>) => void }) {
  const groups = useGroups();
  const confirmDlg = useConfirm();
  const toast = useToast();
  const all = (Array.isArray(groups.data) ? groups.data : []) as Array<Record<string, any>>;
  const [picUrl, setPicUrl] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [results, setResults] = useState<BulkResult[]>([]);
  const [busyLabel, setBusyLabel] = useState('');

  const jids = [...selected];
  const single = jids.length === 1 ? jids[0]! : null;
  // Manage only ever acts on the groups picked in Browse & Send — show just those.
  const visible = sortGroups(all.filter((g) => selected.has(g.id)));

  async function runBulk(label: string, fn: (jid: string) => Promise<unknown>) {
    if (!jids.length) return;
    const ok = await confirmDlg({
      title: label.replace(/…$/, ''),
      body: `Apply to ${jids.length} selected group${jids.length === 1 ? '' : 's'}?`,
      confirmLabel: 'Apply',
    });
    if (!ok) return;
    setBusyLabel(label);
    setResults([]);
    const out: BulkResult[] = [];
    for (const jid of jids) {
      try {
        await fn(jid);
        out.push({ jid, name: groupName(all, jid), ok: true });
      } catch (e) {
        out.push({ jid, name: groupName(all, jid), ok: false, error: String((e as Error).message) });
      }
      setResults([...out]);
      await sleep(300);
    }
    setBusyLabel('');
    const okCount = out.filter((r) => r.ok).length;
    toast(`${okCount}/${out.length} groups updated`, okCount === out.length ? 'ok' : 'err');
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Bulk Group Actions</h3>
          <p className="text-xs text-gray-400">Select groups and apply an action to all at once</p>
        </div>

        <div>
          <div className="mb-1.5 flex justify-between text-xs text-gray-500">
            <span>{selected.size} selected</span>
            {selected.size > 0 && (
              <button onClick={() => setSelected(new Set())} className="font-medium text-gray-400 hover:text-gray-600">Clear</button>
            )}
          </div>
          <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-gray-200 p-2">
            {visible.length === 0 && (
              <div className="px-1.5 py-2 text-xs text-gray-400">
                No groups selected — pick some in “Browse &amp; Send”.
              </div>
            )}
            {visible.map((g) => (
              <label key={g.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-gray-50">
                <input
                  type="checkbox"
                  checked={selected.has(g.id)}
                  onChange={() => {
                    const next = new Set(selected);
                    if (next.has(g.id)) next.delete(g.id);
                    else next.add(g.id);
                    setSelected(next);
                  }}
                  className="h-4 w-4 accent-(--color-wa)"
                />
                <span className="truncate" dir="auto">{g.subject || g.id}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-gray-100 p-3">
          <p className="text-xs font-semibold text-gray-700">Set Group Picture (URL)</p>
          <div className="flex gap-2">
            <input value={picUrl} onChange={(e) => setPicUrl(e.target.value)} placeholder="https://example.com/img.jpg" className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <button
              onClick={() => picUrl.trim() && void runBulk('Setting picture…', (jid) => api.groups.picture(jid, picUrl.trim()))}
              disabled={!jids.length || !picUrl.trim() || !!busyLabel}
              className="rounded-lg bg-wa px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              Apply to Selected
            </button>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-gray-100 p-3">
          <p className="text-xs font-semibold text-gray-700">Set Group Name</p>
          <div className="flex gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} dir="auto" placeholder="New group name" className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <button
              onClick={() => name.trim() && void runBulk('Setting name…', (jid) => api.groups.subject(jid, name.trim()))}
              disabled={!jids.length || !name.trim() || !!busyLabel}
              className="rounded-lg bg-wa px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              Apply to Selected
            </button>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-gray-100 p-3">
          <p className="text-xs font-semibold text-gray-700">Set Description</p>
          <div className="flex items-start gap-2">
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} dir="auto" placeholder="New description…" className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <button
              onClick={() => desc.trim() && void runBulk('Setting description…', (jid) => api.groups.description(jid, desc.trim()))}
              disabled={!jids.length || !desc.trim() || !!busyLabel}
              className="rounded-lg bg-wa px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              Apply to Selected
            </button>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-gray-100 p-3">
          <p className="text-xs font-semibold text-gray-700">Group Settings</p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['announcement', 'Admins Only (send)'],
                ['not_announcement', 'All Members (send)'],
                ['locked', 'Admins Edit Info'],
                ['unlocked', 'All Edit Info'],
              ] as const
            ).map(([action, label]) => (
              <button
                key={action}
                onClick={() => void runBulk(`Applying "${label}"…`, (jid) => api.groups.setting(jid, action))}
                disabled={!jids.length || !!busyLabel}
                className="flex-1 whitespace-nowrap rounded-lg border border-gray-300 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs font-semibold text-gray-700">Disappearing Messages</p>
          <div className="grid grid-cols-4 gap-2">
            {(
              [
                [0, 'Off'],
                [86400, '24h'],
                [604800, '7d'],
                [7776000, '90d'],
              ] as const
            ).map(([exp, label]) => (
              <button
                key={exp}
                onClick={() => void runBulk(`Disappearing: ${label}…`, (jid) => api.groups.ephemeral(jid, exp))}
                disabled={!jids.length || !!busyLabel}
                className="rounded-lg border border-gray-300 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {(busyLabel || results.length > 0) && (
          <div className="space-y-1 text-xs">
            <div className="flex justify-between text-gray-500">
              <span>{busyLabel || 'Done'}</span>
              <span>
                {results.length}/{jids.length}
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-gray-100">
              <div
                className="h-1.5 rounded-full bg-wa transition-all"
                style={{ width: `${jids.length ? (results.length / jids.length) * 100 : 0}%` }}
              />
            </div>
            <div className="max-h-28 space-y-0.5 overflow-y-auto">
              {results.map((r) => (
                <div key={r.jid} className={r.ok ? 'text-wa-dark' : 'text-red-500'}>
                  {r.ok ? '✓' : '✗'} <span dir="auto">{r.name}</span>
                  {r.error ? ` — ${r.error}` : ''}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {single && <SingleGroupPanel jid={single} name={groupName(all, single)} onLeft={() => setSelected(new Set())} />}
      {!single && jids.length > 1 && (
        <p className="text-xs text-gray-400">
          Participant management, invite link and leave are available when exactly one group is selected.
        </p>
      )}
    </div>
  );
}

function SingleGroupPanel({ jid, name, onLeft }: { jid: string; name: string; onLeft: () => void }) {
  const qc = useQueryClient();
  const confirmDlg = useConfirm();
  const toast = useToast();
  const [numbers, setNumbers] = useState('');
  const [invite, setInvite] = useState('');
  const [feedback, setFeedback] = useState('');
  const [showParticipants, setShowParticipants] = useState(false);

  const info = useQuery({
    queryKey: ['group-info', jid],
    queryFn: () => api.groups.info(jid),
    enabled: showParticipants,
  });
  const participants: Array<Record<string, any>> =
    (info.data as any)?.participants ?? (Array.isArray(info.data) ? (info.data[0] as any)?.participants : null) ?? [];

  // saved contact names so members aren't shown as bare JIDs
  const contacts = useQuery({
    queryKey: ['contacts'],
    queryFn: api.chats.contacts,
    staleTime: 5 * 60_000,
    enabled: showParticipants,
  });
  const contactNames = useMemo(
    () => buildContactNames(Array.isArray(contacts.data) ? contacts.data : []),
    [contacts.data],
  );

  const act = useMutation({
    mutationFn: ({ action }: { action: 'add' | 'remove' | 'promote' | 'demote' }) =>
      api.groups.participants(
        jid,
        action,
        numbers.split('\n').map((s) => s.trim()).filter(Boolean),
      ),
    onSuccess: (_d, v) => {
      setFeedback(`✓ ${v.action} done`);
      qc.invalidateQueries({ queryKey: ['group-info', jid] });
    },
    onError: (e) => setFeedback(`✗ ${String((e as Error).message)}`),
  });

  async function getInvite() {
    try {
      const r = await api.groups.invite(jid);
      setInvite(r?.inviteUrl ?? (r?.inviteCode ? `https://chat.whatsapp.com/${r.inviteCode}` : JSON.stringify(r)));
    } catch (e) {
      setFeedback(`✗ ${String((e as Error).message)}`);
    }
  }

  async function leave() {
    const ok = await confirmDlg({
      title: `Leave "${name}"?`,
      body: 'This account is removed from the group and can only return via invite.',
      confirmLabel: 'Leave group',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.groups.leave(jid);
      setFeedback('✓ Left group');
      qc.invalidateQueries({ queryKey: ['groups'] });
      onLeft();
    } catch (e) {
      setFeedback(`✗ ${String((e as Error).message)}`);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-800" dir="auto">
        {name} — single group actions
      </h3>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-700">Participants</p>
          <button
            onClick={() => setShowParticipants(true)}
            className="rounded-lg border border-green-300 px-3 py-1.5 text-xs font-medium text-wa-dark hover:bg-green-50"
          >
            Load Members
          </button>
        </div>
        {showParticipants && (
          <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-gray-100 p-2 text-xs">
            {info.isLoading && <div className="text-gray-400">Loading…</div>}
            {!info.isLoading && !participants.length && (
              <div className="text-gray-400">No members found</div>
            )}
            {participants.map((p) => {
              const pid = String(p.id ?? '');
              const memberName = contactNames.get(pid) ?? '';
              return (
                <div key={pid} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {memberName && (
                      <span className="font-medium" dir="auto">
                        {memberName}{' '}
                      </span>
                    )}
                    <span className={`font-mono ${memberName ? 'text-gray-400' : ''}`}>
                      {displayNumber(pid)}
                    </span>
                  </span>
                  <span className="shrink-0 text-gray-400">
                    {p.admin === 'superadmin' ? '👑 owner' : p.admin ? '⭐ admin' : ''}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <textarea
          value={numbers}
          onChange={(e) => setNumbers(e.target.value)}
          rows={3}
          placeholder={'972501234567\n972509876543'}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
        />
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => act.mutate({ action: 'add' })} disabled={!numbers.trim() || act.isPending} className="rounded-lg bg-wa py-2 text-xs font-semibold text-white disabled:opacity-50">+ Add</button>
          <button onClick={() => act.mutate({ action: 'remove' })} disabled={!numbers.trim() || act.isPending} className="rounded-lg bg-red-500 py-2 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-50">− Remove</button>
          <button onClick={() => act.mutate({ action: 'promote' })} disabled={!numbers.trim() || act.isPending} className="rounded-lg bg-blue-500 py-2 text-xs font-semibold text-white hover:bg-blue-600 disabled:opacity-50">↑ Promote to Admin</button>
          <button onClick={() => act.mutate({ action: 'demote' })} disabled={!numbers.trim() || act.isPending} className="rounded-lg bg-orange-400 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50">↓ Demote</button>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-gray-700">Invite Link</p>
        <div className="flex gap-2">
          <button onClick={() => void getInvite()} className="rounded-lg bg-wa px-4 py-2 text-xs font-semibold text-white">Get Link</button>
          <button
            onClick={() =>
              void api.groups
                .revokeInvite(jid)
                .then(() => { setInvite(''); setFeedback('✓ Invite revoked'); })
                .catch((e) => setFeedback(String((e as Error).message ?? e)))
            }
            className="rounded-lg border border-red-300 px-4 py-2 text-xs font-semibold text-red-500 hover:bg-red-50"
          >
            Revoke
          </button>
        </div>
        {invite && (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2">
            <span className="break-all font-mono text-xs text-wa-dark">{invite}</span>
            <button
              onClick={() =>
                void navigator.clipboard
                  .writeText(invite)
                  .then(() => toast('Invite link copied'))
                  .catch(() => toast('Copy failed', 'err'))
              }
              className="shrink-0 rounded border border-gray-300 px-2 py-1 text-xs text-gray-500 hover:text-gray-700"
            >
              Copy
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between rounded-lg border border-red-100 p-3">
        <div>
          <p className="text-xs font-semibold text-red-600">Leave Group</p>
          <p className="text-xs text-gray-400">Remove this account from the group.</p>
        </div>
        <button onClick={() => void leave()} className="rounded-lg border border-red-300 px-4 py-2 text-xs font-semibold text-red-500 hover:bg-red-50">
          Leave
        </button>
      </div>

      {feedback && <div className="text-xs text-gray-600">{feedback}</div>}
    </div>
  );
}

/* ── Page shell ────────────────────────────────────────────────────────── */

export default function GroupsPage() {
  const [tab, setTab] = useState<SubTab>('browse');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  return (
    <div className="mx-auto h-full max-w-5xl space-y-4 overflow-y-auto p-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">Groups</h2>
        <p className="text-sm text-gray-500">Browse, message, create and manage your WhatsApp groups.</p>
      </div>
      <div className="flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
        {(
          [
            ['browse', 'Browse & Send'],
            ['create', 'Create Group'],
            ['manage', 'Manage Group'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-all ${
              tab === id ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'browse' && (
        <BrowseTab selected={selected} setSelected={setSelected} goManage={() => setTab('manage')} />
      )}
      {tab === 'create' && <CreateTab />}
      {tab === 'manage' && <ManageTab selected={selected} setSelected={setSelected} />}
    </div>
  );
}
