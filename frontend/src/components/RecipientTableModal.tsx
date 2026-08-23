import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useConfirm } from './Confirm';
import { useToast } from './Toast';
import { api } from '../lib/api';
import { normalizeRecipientId } from '../lib/phone';
import type { Recipient } from '../types';

/** Parse one pasted line: number first, then name (tab / comma / pipe — Excel paste). */
export function parseRecipientLine(line: string): Recipient | null {
  const parts = line
    .split(/[,\t|;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const id = normalizeRecipientId(parts[i]!);
    if (!id) continue;
    const name = parts.filter((_, j) => j !== i)[0] ?? '';
    return { id, isGroup: id.includes('@g.us'), ...(name ? { name } : {}) };
  }
  return null;
}

export interface RecipientTableModalProps {
  value: Recipient[];
  onApply: (next: Recipient[]) => void;
  onClose: () => void;
  /** open with every row already ticked (the chips row's Ctrl+A shortcut) */
  selectAllOnOpen?: boolean;
}

/**
 * Recipients as an editable number/name table: paste straight from Excel,
 * fix names inline (they feed {{name}}), tick rows to remove or keep in bulk,
 * and optionally save the table as a reusable list.
 */
export default function RecipientTableModal({
  value,
  onApply,
  onClose,
  selectAllOnOpen = false,
}: RecipientTableModalProps) {
  const qc = useQueryClient();
  const flash = useToast();
  const confirmDlg = useConfirm();
  const [rows, setRows] = useState<Recipient[]>(value);
  const [paste, setPaste] = useState('');
  const [invalid, setInvalid] = useState<string[]>([]);
  const [listName, setListName] = useState('');
  const [savingList, setSavingList] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(selectAllOnOpen ? value.map((r) => r.id) : []),
  );
  const [filter, setFilter] = useState('');
  /** last row ticked, so Shift-click can fill the range in between */
  const anchor = useRef<number | null>(null);

  const named = rows.filter((r) => r.name).length;

  const q = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      q
        ? rows.filter(
            (r) => r.id.toLowerCase().includes(q) || (r.name ?? '').toLowerCase().includes(q),
          )
        : rows,
    [rows, q],
  );
  const selectedCount = selected.size;
  const visibleSelected = visible.filter((r) => selected.has(r.id)).length;
  const allVisibleTicked = visible.length > 0 && visibleSelected === visible.length;

  // Ctrl/Cmd+A ticks everything on screen — but never while a text field has
  // focus, where it has to keep meaning "select this text"
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a') return;
      const el = document.activeElement as HTMLElement | null;
      const editable =
        el?.tagName === 'TEXTAREA' ||
        (el?.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'checkbox') ||
        el?.isContentEditable;
      if (editable) return;
      e.preventDefault();
      setSelected(new Set(visible.map((r) => r.id)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  function toggleRow(i: number, id: string, shift: boolean) {
    // read the anchor now: the updater below runs at render time, after the
    // assignment at the end of this function has already moved it to `i`
    const from = anchor.current;
    setSelected((prev) => {
      const next = new Set(prev);
      const on = !prev.has(id);
      if (shift && from !== null && from < visible.length) {
        const [a, b] = from < i ? [from, i] : [i, from];
        for (let k = a; k <= b; k++) {
          const rid = visible[k]!.id;
          if (on) next.add(rid);
          else next.delete(rid);
        }
      } else if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    anchor.current = i;
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of visible) {
        if (allVisibleTicked) next.delete(r.id);
        else next.add(r.id);
      }
      return next;
    });
    anchor.current = null;
  }

  function removeSelected() {
    setRows((prev) => prev.filter((r) => !selected.has(r.id)));
    setSelected(new Set());
    anchor.current = null;
  }

  function keepOnlySelected() {
    setRows((prev) => prev.filter((r) => selected.has(r.id)));
    setSelected(new Set());
    anchor.current = null;
  }

  async function clearAll() {
    if (
      rows.length > 5 &&
      !(await confirmDlg({
        title: `Remove all ${rows.length} recipients?`,
        body: 'Only the table empties — the recipients box changes when you press Apply.',
        confirmLabel: 'Remove all',
        danger: true,
      }))
    )
      return;
    setRows([]);
    setSelected(new Set());
    anchor.current = null;
  }

  function addPasted() {
    const bad: string[] = [];
    setRows((prev) => {
      const byId = new Map(prev.map((r) => [r.id, r]));
      for (const ln of paste.split('\n')) {
        if (!ln.trim()) continue;
        const parsed = parseRecipientLine(ln);
        if (!parsed) {
          bad.push(ln.trim());
          continue;
        }
        const existing = byId.get(parsed.id);
        // re-pasting an existing number with a name fills the blank, never erases
        byId.set(parsed.id, { ...existing, ...parsed, name: parsed.name || existing?.name });
      }
      return [...byId.values()];
    });
    setInvalid(bad);
    setPaste('');
  }

  function setName(id: string, name: string) {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, name: name.trim() ? name : undefined } : r)),
    );
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((x) => x.id !== id));
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function copyTable() {
    const picked = selectedCount ? rows.filter((r) => selected.has(r.id)) : rows;
    const tsv = picked.map((r) => `${r.id}\t${r.name ?? ''}`).join('\n');
    navigator.clipboard
      ?.writeText(tsv)
      .then(() => flash(`Copied ${picked.length} rows`))
      .catch(() => flash('Copy failed', 'err'));
  }

  async function saveAsList() {
    if (!listName.trim()) return;
    setSavingList(true);
    try {
      await api.lists.create(
        listName.trim(),
        rows.map((r) => ({ recipient: r.id, isGroup: r.isGroup, name: r.name ?? '' })),
      );
      // without this the new list stays invisible to "Add from list" (60s staleTime)
      await qc.invalidateQueries({ queryKey: ['lists'] });
      flash(`List “${listName.trim()}” saved — reusable from “Add from list”`);
      setListName('');
    } catch (e) {
      flash(`Save failed — ${(e as Error).message}`, 'err');
    } finally {
      setSavingList(false);
    }
  }

  const smallBtn =
    'rounded-md border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-600 hover:border-wa hover:bg-green-50 hover:text-wa-dark';

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Recipients table"
        className="animate-pop flex max-h-[88vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <div>
            <span className="font-semibold text-gray-800">Recipients table</span>
            <span className="ml-2 text-xs text-gray-400">
              {rows.length} recipient{rows.length === 1 ? '' : 's'} · {named} with a name
            </span>
          </div>
          <button onClick={onClose} className="text-xl leading-none text-gray-400 hover:text-gray-700">
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div>
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={'Paste number, name rows — straight from Excel:\n0521234567\tישראל ישראלי\n0541234567, דוגמה לקוח\n0501234567'}
              className="h-20 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
            />
            <div className="mt-1 flex items-center gap-2">
              <button
                onClick={addPasted}
                disabled={!paste.trim()}
                className="rounded-lg bg-wa px-3 py-1.5 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
              >
                Add to table
              </button>
              <span className="text-[11px] text-gray-400">
                number first, then name (tab / comma / pipe) · re-pasting fills missing names
              </span>
            </div>
            {invalid.length > 0 && (
              <div className="mt-1 text-xs text-red-500">
                No valid number, skipped: {invalid.slice(0, 5).join(' · ')}
                {invalid.length > 5 && ` (+${invalid.length - 5})`}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={filter}
              dir="auto"
              onChange={(e) => {
                setFilter(e.target.value);
                anchor.current = null;
              }}
              placeholder="Filter number or name…"
              className="w-48 rounded-lg border border-gray-300 px-2.5 py-1 text-sm"
            />
            {q && (
              <span className="text-[11px] text-gray-400">
                {visible.length} of {rows.length} shown
              </span>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {selectedCount > 0 ? (
                <>
                  <span className="text-xs font-medium text-gray-600">{selectedCount} selected</span>
                  <button
                    onClick={removeSelected}
                    className="rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-100"
                  >
                    Remove selected
                  </button>
                  <button onClick={keepOnlySelected} className={smallBtn}>
                    Keep only these
                  </button>
                  <button onClick={() => setSelected(new Set())} className={smallBtn}>
                    Deselect
                  </button>
                </>
              ) : (
                <span className="text-[11px] text-gray-400">
                  tick rows · Shift-click a range · Ctrl+A selects all
                </span>
              )}
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="w-9 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={allVisibleTicked}
                      ref={(el) => {
                        if (el) el.indeterminate = visibleSelected > 0 && !allVisibleTicked;
                      }}
                      onChange={toggleAllVisible}
                      disabled={!visible.length}
                      title={allVisibleTicked ? 'Deselect all' : 'Select all'}
                      aria-label={allVisibleTicked ? 'Deselect all' : 'Select all'}
                      className="h-3.5 w-3.5 accent-wa"
                    />
                  </th>
                  <th className="w-40 px-3 py-2">Number</th>
                  <th className="px-3 py-2">
                    Name <span className="font-normal normal-case text-gray-400">→ {'{{first_name}}'}</span>
                  </th>
                  <th className="w-10 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {!rows.length && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-sm text-gray-400">
                      Empty — paste numbers above to fill the table.
                    </td>
                  </tr>
                )}
                {rows.length > 0 && !visible.length && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-sm text-gray-400">
                      No row matches “{filter.trim()}”.
                    </td>
                  </tr>
                )}
                {visible.map((r, i) => (
                  <tr
                    key={r.id}
                    className={`border-t border-gray-100 ${selected.has(r.id) ? 'bg-green-50/70' : ''}`}
                  >
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        // onClick carries shiftKey; React's checkbox onChange does not
                        onClick={(e) => toggleRow(i, r.id, e.shiftKey)}
                        onChange={() => {}}
                        aria-label={`Select ${r.id}`}
                        className="h-3.5 w-3.5 accent-wa"
                      />
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-gray-600" dir="ltr">
                      {r.isGroup ? `👥 ${r.id.split('@')[0]}` : r.id}
                    </td>
                    <td className="px-1.5 py-1">
                      <input
                        value={r.name ?? ''}
                        dir="auto"
                        onChange={(e) => setName(r.id, e.target.value)}
                        placeholder="—"
                        className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm hover:border-gray-200 focus:border-wa focus:outline-none"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <button
                        onClick={() => removeRow(r.id)}
                        title="Remove"
                        className="rounded px-1.5 text-base leading-none text-gray-400 hover:bg-red-50 hover:text-red-600"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-5 py-3">
          <button
            onClick={copyTable}
            disabled={!rows.length}
            title="Copy as number↹name rows (paste into Excel or back here)"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            ⧉ Copy{selectedCount ? ` (${selectedCount})` : ''}
          </button>
          <button
            onClick={() => void clearAll()}
            disabled={!rows.length}
            title="Empty the table — takes effect when you Apply"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:border-red-300 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
          >
            🗑 Clear all
          </button>
          <div className="flex min-w-0 items-center gap-1">
            <input
              value={listName}
              dir="auto"
              onChange={(e) => setListName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveAsList()}
              placeholder="Save as list…"
              className="w-32 rounded-lg border border-gray-300 px-2.5 py-2 text-sm"
            />
            {listName.trim() && (
              <button
                onClick={() => void saveAsList()}
                disabled={savingList || !rows.length}
                className="rounded-lg border border-gray-300 px-2.5 py-2 text-sm font-medium text-gray-600 hover:border-wa hover:bg-green-50 hover:text-wa-dark disabled:opacity-50"
              >
                {savingList ? '…' : 'Save'}
              </button>
            )}
          </div>
          <div className="ml-auto flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onApply(rows);
                onClose();
              }}
              className="rounded-lg bg-wa px-4 py-2 text-sm font-semibold text-white hover:bg-wa-dark"
            >
              Apply ({rows.length})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
