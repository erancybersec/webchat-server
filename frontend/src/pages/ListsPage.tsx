import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useConfirm } from '../components/Confirm';
import { useToast } from '../components/Toast';
import { api } from '../lib/api';
import {
  EMPTY_RECIPE,
  eligibleSources,
  recipeIsEmpty,
  recipeSourceIds,
  resolveRecipe,
  usedSourceIds,
} from '../lib/listRecipe';
import { normalizePhone } from '../lib/phone';
import type { ListMember, ListRecipe, ListRecipeSource, RecipientList } from '../types';

/** Parse one paste line: phone first, optional name after a comma/tab/pipe. */
function parseMemberLine(line: string): ListMember | null {
  const parts = line
    .split(/[,\t|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const phone = normalizePhone(parts[i]);
    if (phone) {
      const rest = parts.filter((_, j) => j !== i);
      return { recipient: phone, isGroup: false, name: rest[0] ?? '' };
    }
  }
  return null;
}

const n = (v: number) => v.toLocaleString();

/**
 * Saved audiences: named recipient sets. Compose's "Add from list" pulls them
 * in as chips, names included — which is what {{name}} personalization uses.
 *
 * A list is either hand-made (paste numbers) or *combined* — built as the union
 * of other lists minus the ones it excludes. A combined list still stores plain
 * member rows, so everything downstream is unchanged; what it adds is the saved
 * recipe, which the card can rebuild in one click after a source list changes.
 */
export default function ListsPage() {
  const qc = useQueryClient();
  const flash = useToast();
  const confirmDlg = useConfirm();
  const lists = useQuery({ queryKey: ['lists'], queryFn: api.lists.list });
  const [editing, setEditing] = useState<RecipientList | null>(null);
  const [creating, setCreating] = useState(false);
  const [rebuilding, setRebuilding] = useState<string | null>(null);

  /**
   * Recipe previews are computed from the source lists' members, so a stale
   * cached source would let the editor count (and save) an audience that no
   * longer exists — both keys have to move together after any write.
   */
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['lists'] });
    qc.invalidateQueries({ queryKey: ['list-members'] });
  };

  const removeList = useMutation({
    mutationFn: (id: string) => api.lists.remove(id),
    onSuccess: (_res, id) => {
      // Drop the entry outright: invalidating would refetch, 404, and keep the
      // last-known members as `data`, which is exactly the stale set that must
      // not survive — a gone list has to read as gone.
      qc.removeQueries({ queryKey: ['list-members', id] });
      invalidate();
      flash('List deleted');
    },
    onError: (e) => flash(`Delete failed — ${(e as Error).message}`, 'err'),
  });

  async function onDelete(l: RecipientList) {
    const usedBy = (lists.data ?? []).filter((o) =>
      recipeSourceIds(o.recipe ?? EMPTY_RECIPE).includes(l.id),
    );
    const ok = await confirmDlg({
      title: `Delete “${l.name}”?`,
      body:
        `The list and its ${l.memberCount} member(s) are removed. Jobs already created keep their recipients.` +
        (usedBy.length
          ? ` ${usedBy.map((o) => `“${o.name}”`).join(', ')} ${usedBy.length === 1 ? 'is' : 'are'} built from this list and can no longer be rebuilt — the members already saved there stay.`
          : ''),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) removeList.mutate(l.id);
  }

  /**
   * Re-run a saved recipe against its sources as they are now. Same math the
   * editor previews with, so a rebuild and a re-save land on the same members.
   */
  async function onRebuild(l: RecipientList) {
    const recipe = l.recipe;
    if (!recipe) return;
    setRebuilding(l.id);
    try {
      const loaded = await Promise.all(
        recipeSourceIds(recipe).map(async (id) => {
          try {
            return [id, (await api.lists.get(id)).members] as const;
          } catch {
            return [id, null] as const;
          }
        }),
      );
      const membersById = new Map<string, ListMember[]>();
      for (const [id, members] of loaded) if (members) membersById.set(id, members);
      const res = resolveRecipe(recipe, membersById);
      if (res.missing.length) {
        const names = res.missing.map((id) => sourceLabel(recipe, id));
        flash(`Can't rebuild — source list ${names.join(', ')} is gone`, 'err');
        return;
      }
      const before = l.memberCount;
      await api.lists.update(l.id, { members: res.members, recipe });
      invalidate();
      const delta = res.members.length - before;
      flash(
        delta === 0
          ? `“${l.name}” rebuilt — still ${n(res.members.length)} recipients`
          : `“${l.name}” rebuilt — ${n(res.members.length)} recipients (${delta > 0 ? '+' : ''}${n(delta)})`,
      );
    } catch (e) {
      flash(`Rebuild failed — ${(e as Error).message}`, 'err');
    } finally {
      setRebuilding(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 overflow-y-auto p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Recipient lists</h2>
          <p className="text-sm text-gray-500">
            Saved audiences — pick a whole list as recipients in Compose. Member names feed
            personalization: a member stored as "דנה כהן" sends as{' '}
            <code className="rounded bg-gray-100 px-1">{'{{first_name}}'}</code> דנה,{' '}
            <code className="rounded bg-gray-100 px-1">{'{{last_name}}'}</code> כהן or{' '}
            <code className="rounded bg-gray-100 px-1">{'{{full_name}}'}</code> דנה כהן. A list can
            also be built from other lists — two of them added together, minus a third.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="shrink-0 rounded-lg bg-wa px-4 py-2 text-sm font-semibold text-white hover:bg-wa-dark"
        >
          ＋ New list
        </button>
      </div>

      {lists.isLoading && <p className="py-10 text-center text-sm text-gray-400">Loading…</p>}
      {!lists.isLoading && !(lists.data ?? []).length && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-400">
          No lists yet — create one and paste numbers straight from Excel.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {(lists.data ?? []).map((l) => (
          <div key={l.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-semibold text-gray-800" dir="auto">
                  {l.name}
                </p>
                <p className="text-xs text-gray-500">
                  {l.memberCount} member{l.memberCount === 1 ? '' : 's'} · created{' '}
                  {new Date(l.createdAt).toLocaleDateString()}
                </p>
              </div>
              {l.recipe && (
                <span
                  title={recipeSummary(l.recipe)}
                  className="shrink-0 rounded bg-green-50 px-1.5 py-0.5 text-[11px] font-medium text-wa-dark"
                >
                  Combined
                </span>
              )}
            </div>
            {l.recipe && (
              <p className="mt-1.5 truncate text-xs text-gray-400" dir="auto">
                {recipeSummary(l.recipe)}
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setEditing(l)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:border-wa hover:bg-green-50 hover:text-wa-dark"
              >
                Edit
              </button>
              {l.recipe && (
                <button
                  onClick={() => void onRebuild(l)}
                  disabled={rebuilding === l.id}
                  title="Re-run the recipe against its source lists as they are now"
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:border-wa hover:bg-green-50 hover:text-wa-dark disabled:opacity-50"
                >
                  {rebuilding === l.id ? 'Rebuilding…' : 'Rebuild'}
                </button>
              )}
              <button
                onClick={() => void onDelete(l)}
                className="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {(creating || editing) && (
        <ListEditor
          list={editing}
          allLists={lists.data ?? []}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            invalidate();
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** "All Odoo Leads + Studio customers − Active customers", for cards + titles. */
function recipeSummary(recipe: ListRecipe): string {
  const label = (s: ListRecipeSource) => s.name || s.id;
  return [
    recipe.include.map(label).join(' + '),
    ...recipe.exclude.map((s) => `− ${label(s)}`),
  ].join(' ');
}

function sourceLabel(recipe: ListRecipe, id: string): string {
  const hit = [...recipe.include, ...recipe.exclude].find((s) => s.id === id);
  return `“${hit?.name || id}”`;
}

type EditorMode = 'paste' | 'combine';

function ListEditor({
  list,
  allLists,
  onClose,
  onSaved,
}: {
  list: RecipientList | null;
  allLists: RecipientList[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const flash = useToast();
  const [name, setName] = useState(list?.name ?? '');
  const [mode, setMode] = useState<EditorMode>(list?.recipe ? 'combine' : 'paste');
  const [members, setMembers] = useState<ListMember[]>([]);
  const [paste, setPaste] = useState('');
  const [recipe, setRecipe] = useState<ListRecipe>(list?.recipe ?? EMPTY_RECIPE);
  // Off = freeze: save the members this recipe produced as a plain list.
  const [keepRecipe, setKeepRecipe] = useState(true);
  const [pick, setPick] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [loading, setLoading] = useState(!!list);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!list) return;
    let alive = true;
    api.lists
      .get(list.id)
      .then((d) => {
        if (!alive) return;
        setMembers(d.members);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        flash('Could not load list members', 'err');
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [list, flash]);

  // Source members, one query each — shared cache keys, so a source already
  // opened elsewhere costs nothing and Rebuild reuses what the editor loaded.
  const sourceIds = recipeSourceIds(recipe);
  // No staleTime: the count next to a source row and the recipient total under
  // it are claims about the sources as they are right now, so opening the
  // editor re-reads them rather than trusting a snapshot.
  const sources = useQueries({
    queries: sourceIds.map((id) => ({
      queryKey: ['list-members', id],
      queryFn: () => api.lists.get(id),
      // A deleted source 404s; retrying it three times only delays the row
      // reading "deleted" and the save being refused.
      retry: false,
    })),
  });
  const sourcesLoading = sources.some((q) => q.isLoading);
  const blacklist = useQuery({
    queryKey: ['blacklist'],
    queryFn: api.blacklist.list,
    staleTime: 60_000,
  });

  // Plain derivations, not memos: the recipe spans a handful of lists, so the
  // whole resolve is a few thousand map operations — cheaper than the deps
  // bookkeeping a memo over query results would need to stay correct.
  const membersById = new Map<string, ListMember[]>();
  sourceIds.forEach((id, i) => {
    const d = sources[i]?.data;
    if (d) membersById.set(id, d.members);
  });
  const combined = resolveRecipe(recipe, membersById);
  const shownMembers = mode === 'combine' ? combined.members : members;
  const blSet = new Set((blacklist.data ?? []).map((e) => e.phone_number));
  const blocked = shownMembers.filter((m) => blSet.has(m.recipient)).length;

  const pickable = eligibleSources(allLists, list?.id ?? undefined).filter(
    (l) => !usedSourceIds(recipe).has(l.id),
  );

  function addSource(op: 'include' | 'exclude') {
    const hit = pickable.find((l) => l.id === pick);
    if (!hit) return;
    setRecipe((r) => ({ ...r, [op]: [...r[op], { id: hit.id, name: hit.name }] }));
    setPick('');
  }

  function dropSource(op: 'include' | 'exclude', id: string) {
    setRecipe((r) => ({ ...r, [op]: r[op].filter((s) => s.id !== id) }));
  }

  function addPasted() {
    const fresh: ListMember[] = [];
    let invalid = 0;
    const seen = new Set(members.map((m) => m.recipient));
    for (const ln of paste.split('\n')) {
      if (!ln.trim()) continue;
      const m = parseMemberLine(ln);
      if (!m) {
        invalid++;
        continue;
      }
      if (seen.has(m.recipient)) continue;
      seen.add(m.recipient);
      fresh.push(m);
    }
    setMembers((prev) => [...prev, ...fresh]);
    setPaste('');
    if (invalid) flash(`${invalid} line(s) had no valid phone — skipped`, 'err');
  }

  async function save() {
    if (!name.trim()) return flash('List name is required', 'err');
    if (mode === 'combine') {
      if (recipeIsEmpty(recipe)) return flash('Include at least one list', 'err');
      if (sourcesLoading) return flash('Still loading the source lists', 'err');
      if (combined.missing.length)
        return flash(
          `Source list ${combined.missing.map((id) => sourceLabel(recipe, id)).join(', ')} could not be loaded — nothing saved`,
          'err',
        );
    }
    // Combine mode saves the members the recipe produced; the recipe rides
    // along unless it was frozen. Paste mode always clears it.
    const payload =
      mode === 'combine'
        ? { members: combined.members, recipe: keepRecipe ? recipe : null }
        : { members, recipe: null };
    setBusy(true);
    try {
      if (list) await api.lists.update(list.id, { name: name.trim(), ...payload });
      else await api.lists.create(name.trim(), payload.members, payload.recipe);
      flash('List saved');
      onSaved();
    } catch (e) {
      flash(`Save failed — ${(e as Error).message}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  const tab = (m: EditorMode, label: string) => (
    <button
      key={m}
      onClick={() => setMode(m)}
      className={`flex-1 rounded-md px-3 py-1.5 text-sm ${
        mode === m
          ? 'border border-gray-200 bg-white font-medium text-gray-800'
          : 'text-gray-500 hover:text-gray-700'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={list ? `Edit list ${list.name}` : 'New list'}
        className="animate-pop flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <span className="font-semibold text-gray-800">{list ? 'Edit list' : 'New list'}</span>
          <button onClick={onClose} className="text-xl leading-none text-gray-400 hover:text-gray-700">
            ×
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
            <input
              autoFocus={!list}
              value={name}
              dir="auto"
              onChange={(e) => setName(e.target.value)}
              placeholder="VIP customers"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="flex gap-1 rounded-lg bg-gray-50 p-1">
            {tab('paste', 'Paste numbers')}
            {tab('combine', 'Combine lists')}
          </div>

          {mode === 'paste' ? (
            <>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Add members</label>
                <textarea
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  placeholder={'0521234567, ישראל ישראלי\n972529876543, דוגמה לקוח\n0501234567'}
                  className="h-24 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
                />
                <button
                  onClick={addPasted}
                  disabled={!paste.trim()}
                  className="mt-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  Add pasted numbers
                </button>
              </div>
              {loading ? (
                <p className="py-4 text-center text-sm text-gray-400">Loading members…</p>
              ) : (
                <div>
                  <p className="mb-1 text-xs font-medium text-gray-500">
                    {members.length} member{members.length === 1 ? '' : 's'}
                  </p>
                  <ul className="max-h-56 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200">
                    {members.map((m) => (
                      <li key={m.recipient} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                        <span className="font-mono text-gray-700" dir="ltr">
                          {m.recipient}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-gray-500" dir="auto">
                          {m.name}
                        </span>
                        <button
                          onClick={() =>
                            setMembers((prev) => prev.filter((x) => x.recipient !== m.recipient))
                          }
                          title="Remove"
                          className="rounded px-1.5 text-base leading-none text-gray-400 hover:bg-red-50 hover:text-red-600"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                    {!members.length && (
                      <li className="px-3 py-4 text-center text-xs text-gray-400">No members yet</li>
                    )}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <>
              <ul className="space-y-2">
                {(['include', 'exclude'] as const).flatMap((op) =>
                  recipe[op].map((s) => (
                    <li
                      key={`${op}:${s.id}`}
                      className="flex items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-2"
                    >
                      <span
                        className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${
                          op === 'include' ? 'bg-green-50 text-wa-dark' : 'bg-red-50 text-red-600'
                        }`}
                      >
                        {op === 'include' ? '＋ Include' : '− Exclude'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-gray-800" dir="auto">
                        {s.name || s.id}
                      </span>
                      <span className="shrink-0 text-xs text-gray-400">
                        {membersById.has(s.id)
                          ? n(membersById.get(s.id)!.length)
                          : sources[sourceIds.indexOf(s.id)]?.isError
                            ? 'deleted'
                            : '…'}
                      </span>
                      <button
                        onClick={() => dropSource(op, s.id)}
                        title="Remove"
                        className="rounded px-1.5 text-base leading-none text-gray-400 hover:bg-red-50 hover:text-red-600"
                      >
                        ×
                      </button>
                    </li>
                  )),
                )}
                {recipeIsEmpty(recipe) && !recipe.exclude.length && (
                  <li className="rounded-lg border border-dashed border-gray-300 px-3 py-4 text-center text-xs text-gray-400">
                    Pick a list below to start — every included list is added together, then the
                    excluded ones are taken out.
                  </li>
                )}
              </ul>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                  aria-label="Choose a list"
                  className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                >
                  <option value="">Choose a list…</option>
                  {pickable.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({l.memberCount})
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => addSource('include')}
                  disabled={!pick}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:border-wa hover:bg-green-50 hover:text-wa-dark disabled:opacity-50"
                >
                  ＋ Include
                </button>
                <button
                  onClick={() => addSource('exclude')}
                  disabled={!pick}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                >
                  − Exclude
                </button>
              </div>
              {!pickable.length && !recipeIsEmpty(recipe) && (
                <p className="text-xs text-gray-400">
                  Every other hand-made list is already in the recipe. A combined list can't be
                  built from another combined one — freeze it first, or paste its numbers.
                </p>
              )}

              <div className="rounded-lg bg-gray-50 p-3">
                {sourcesLoading ? (
                  <p className="text-sm text-gray-400">Counting…</p>
                ) : (
                  <>
                    <p className="flex items-baseline gap-2">
                      <span className="text-2xl font-semibold text-gray-800">
                        {combined.missing.length ? '—' : n(combined.members.length)}
                      </span>
                      <span className="text-sm text-gray-500">recipients</span>
                    </p>
                    {/* A total computed without one of its sources would be a
                        lie either way round — an unloadable include undercounts,
                        an unloadable exclude overcounts — so say nothing until
                        the row is dealt with. */}
                    {combined.missing.length > 0 ? (
                      <p className="mt-1 text-xs leading-5 text-red-600">
                        Source list {combined.missing.map((id) => sourceLabel(recipe, id)).join(', ')}{' '}
                        is gone — remove the row to count and save this list.
                      </p>
                    ) : (
                      <p className="mt-1 text-xs leading-5 text-gray-400">
                        {n(combined.scanned)} from {recipe.include.length} list
                        {recipe.include.length === 1 ? '' : 's'} · {n(combined.duplicates)} duplicate
                        {combined.duplicates === 1 ? '' : 's'} merged · {n(combined.excluded)} excluded
                        {blocked > 0 && (
                          <>
                            <br />
                            {n(blocked)} also on the blacklist — skipped at send time
                          </>
                        )}
                      </p>
                    )}
                    {combined.members.length > 0 && !combined.missing.length && (
                      <button
                        onClick={() => setShowPreview((v) => !v)}
                        className="mt-2 text-sm font-medium text-wa-dark hover:underline"
                      >
                        {showPreview ? 'Hide members' : 'Preview members'}
                      </button>
                    )}
                  </>
                )}
              </div>

              {showPreview && (
                <ul className="max-h-56 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200">
                  {combined.members.slice(0, 500).map((m) => (
                    <li key={m.recipient} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                      <span className="font-mono text-gray-700" dir="ltr">
                        {m.recipient}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-gray-500" dir="auto">
                        {m.name}
                      </span>
                    </li>
                  ))}
                  {combined.members.length > 500 && (
                    <li className="px-3 py-2 text-center text-xs text-gray-400">
                      + {n(combined.members.length - 500)} more
                    </li>
                  )}
                </ul>
              )}
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-5 py-3">
          {mode === 'combine' ? (
            <label className="flex items-center gap-2 text-xs text-gray-500">
              <input
                type="checkbox"
                checked={keepRecipe}
                onChange={(e) => setKeepRecipe(e.target.checked)}
                className="accent-wa"
              />
              Keep the recipe so I can rebuild it later
            </label>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={busy || loading || (mode === 'combine' && sourcesLoading)}
              className="rounded-lg bg-wa px-4 py-2 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save list'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
