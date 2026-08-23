import { useMemo, useState } from 'react';
import { agentLabel, useAgents, useMe, usePerm } from '../lib/agents';
import { useActiveInstance, useInstances } from '../lib/instance';
import { useQuickReplies } from '../lib/quickReplies';
import type { ServerQuickReply } from '../types';
import QuickReplyForm from './chat/QuickReplyForm';

type GroupBy = 'instance' | 'owner';

/** Effective instance of a reply: its own line, or '' for the default line. */
const effInstance = (r: ServerQuickReply) => r.instance ?? '';

export default function QuickRepliesPage() {
  // Admins get the cross-instance / cross-owner roster; everyone else sees
  // their own scoped list (and the server enforces the same on the API).
  const isAdmin = usePerm('agents.manage') === true;
  const store = useQuickReplies({ all: isAdmin });
  const replies = store.replies;

  const me = useMe();
  const canPersonal = !!(me.data?.enabled && me.data.email);
  const agents = useAgents(isAdmin);
  const instances = useInstances();
  const activeInstance = useActiveInstance();
  const defaultName = instances.data?.default ?? '';

  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('instance');
  // null = list view, 'new' = adding, number = editing that reply id
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  // A reply pinned to the default line carries either no instance (legacy) or
  // the default's own name — collapse both to one canonical key/label.
  const isDefaultLine = (inst: string) => inst === '' || inst === defaultName;
  const lineKey = (inst: string) => (isDefaultLine(inst) ? '' : inst);

  // Owner label for a reply: an agent's display name, or the shared marker.
  const ownerLabel = (email: string | null) => {
    if (!email) return 'Shared (team)';
    const a = agents.data?.find((x) => x.email === email);
    return a ? agentLabel(a) : email;
  };
  const instanceLabel = (inst: string) =>
    isDefaultLine(inst) ? `${defaultName || 'Default'} (default line)` : inst;

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      replies.filter(
        (r) => !q || r.shortcut.toLowerCase().includes(q) || r.text.toLowerCase().includes(q),
      ),
    [replies, q],
  );

  // Admins can group/sort by instance or owner with a click; non-admins see a
  // single flat list (their roster is one instance anyway).
  const groups = useMemo(() => {
    if (!isAdmin) return [{ key: '', label: '', rows: visible }];
    const map = new Map<string, ServerQuickReply[]>();
    for (const r of visible) {
      const key = groupBy === 'instance' ? lineKey(effInstance(r)) : (r.agentEmail ?? '');
      (map.get(key) ?? map.set(key, []).get(key)!).push(r);
    }
    const label = (key: string) =>
      groupBy === 'instance' ? instanceLabel(key) : ownerLabel(key || null);
    // default line / shared bucket ('') sorts first, then alphabetical.
    return [...map.entries()]
      .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : label(a).localeCompare(label(b))))
      .map(([key, rows]) => ({ key, label: label(key), rows }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, isAdmin, groupBy, agents.data, defaultName]);

  // Clash detection is per effective instance — the same shortcut may live on
  // different lines. A new reply lands on the active line; an edit keeps its own.
  function isTaken(s: string): boolean {
    const lower = s.toLowerCase();
    const targetEff = editing === 'new' || editing == null
      ? activeInstance
      : effInstance(replies.find((r) => r.id === editing) ?? ({ instance: null } as ServerQuickReply));
    const target = lineKey(targetEff);
    return replies.some(
      (r) => r.id !== editing && lineKey(effInstance(r)) === target && r.shortcut.toLowerCase() === lower,
    );
  }

  const editingRow = typeof editing === 'number' ? replies.find((r) => r.id === editing) : undefined;

  function startEdit(id: number | 'new') {
    setConfirmId(null);
    setEditing(id);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 overflow-y-auto p-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">Quick replies</h2>
        <p className="text-sm text-gray-500">
          Snippets agents insert by typing “/” in the composer.{' '}
          {isAdmin
            ? 'You can see every line and every agent’s personal replies.'
            : 'Showing the replies available on your current line.'}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search quick replies…"
          dir="auto"
          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        {isAdmin && (
          <div className="flex shrink-0 items-center gap-1 rounded-lg bg-gray-100 p-1 text-sm">
            {(['instance', 'owner'] as const).map((g) => (
              <button
                key={g}
                onClick={() => setGroupBy(g)}
                className={`rounded-md px-3 py-1 font-medium capitalize transition-colors ${
                  groupBy === g ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                By {g}
              </button>
            ))}
          </div>
        )}
        <button
          onClick={() => startEdit('new')}
          className="shrink-0 rounded-lg bg-wa px-3 py-2 text-sm font-medium text-white hover:bg-wa-dark"
        >
          + New
        </button>
      </div>

      {editing === 'new' && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-4 py-2 text-xs font-medium text-gray-500">
            New reply on {instanceLabel(activeInstance)}
          </div>
          <QuickReplyForm
            mode="add"
            canPersonal={canPersonal}
            isTaken={isTaken}
            onCancel={() => setEditing(null)}
            onSubmit={({ shortcut, text, personal, media }) => {
              store.add(shortcut, text, personal, media);
              setEditing(null);
            }}
          />
        </div>
      )}

      <div className="space-y-4">
        {!visible.length && (
          <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-400">
            {replies.length ? 'No matches.' : 'No quick replies yet.'}
          </div>
        )}
        {groups.map((group) => (
          <div key={group.key || 'all'}>
            {isAdmin && group.label && (
              <h3 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
                {group.label}
                <span className="ml-1.5 font-normal normal-case text-gray-300">({group.rows.length})</span>
              </h3>
            )}
            <div className="divide-y divide-gray-50 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
              {group.rows.map((r) =>
                editingRow?.id === r.id ? (
                  <QuickReplyForm
                    key={r.id}
                    mode="edit"
                    initial={{ shortcut: r.shortcut, text: r.text, personal: !!r.agentEmail, media: r.media }}
                    canPersonal={canPersonal}
                    isTaken={isTaken}
                    onCancel={() => setEditing(null)}
                    onSubmit={({ shortcut, text, media }) => {
                      store.edit(r.id, shortcut, text, media);
                      setEditing(null);
                    }}
                  />
                ) : (
                  <div
                    key={r.id}
                    className="group flex items-start gap-2 px-4 py-3 hover:bg-gray-50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs font-medium text-wa-dark">
                        /{r.shortcut}
                        {r.media && (
                          <span className="rounded-full bg-gray-100 px-1.5 py-px font-sans text-[10px] font-medium text-gray-500" title={`${r.media.mediatype} attached`}>
                            📎 {r.media.mediatype}
                          </span>
                        )}
                        {r.agentEmail && (
                          <span className="rounded-full bg-amber-50 px-1.5 py-px font-sans text-[10px] font-medium text-amber-700">
                            {isAdmin && groupBy === 'instance' ? ownerLabel(r.agentEmail) : 'personal'}
                          </span>
                        )}
                        {isAdmin && groupBy === 'owner' && (
                          <span className="rounded-full bg-gray-100 px-1.5 py-px font-sans text-[10px] font-medium text-gray-500">
                            {instanceLabel(effInstance(r))}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 whitespace-pre-wrap text-sm text-gray-600" dir="auto">
                        {r.text || <span className="text-gray-400">(no caption)</span>}
                      </div>
                    </div>
                    {confirmId === r.id ? (
                      <div className="flex shrink-0 items-center gap-1 text-xs">
                        <button
                          onClick={() => {
                            store.remove(r.id);
                            setConfirmId(null);
                          }}
                          className="rounded-md bg-red-500 px-2 py-1 font-medium text-white hover:bg-red-600"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setConfirmId(null)}
                          className="rounded-md border border-gray-300 px-2 py-1 text-gray-600 hover:bg-gray-100"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <button
                          onClick={() => startEdit(r.id)}
                          title="Edit"
                          aria-label={`Edit /${r.shortcut}`}
                          className="rounded p-1.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z"/></svg>
                        </button>
                        <button
                          onClick={() => setConfirmId(r.id)}
                          title="Delete"
                          aria-label={`Delete /${r.shortcut}`}
                          className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>
                        </button>
                      </div>
                    )}
                  </div>
                ),
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
