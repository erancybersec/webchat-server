import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { normalizePhone, normalizeRecipientId } from '../lib/phone';
import type { Recipient } from '../types';
import RecipientTableModal, { parseRecipientLine } from './RecipientTableModal';

export interface RecipientChipsProps {
  value: Recipient[];
  onChange: (next: Recipient[]) => void;
}

/** Past this many recipients the chips collapse behind "+N more" (table view). */
const CHIP_CAP = 24;

/**
 * v1-style recipient input: type a number and press Enter/comma, or paste a
 * whole list. Chips show normalized ids; blacklisted ones get flagged in a
 * non-blocking warning (the server skips them at send time anyway).
 */
export default function RecipientChips({ value, onChange }: RecipientChipsProps) {
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  /** the table opens with every row ticked when it was reached with Ctrl+A */
  const [tableSelectAll, setTableSelectAll] = useState(false);
  /** what "Clear all" threw away, kept for one Undo */
  const [cleared, setCleared] = useState<Recipient[] | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const tagPickerRef = useRef<HTMLDivElement>(null);
  const blacklist = useQuery({ queryKey: ['blacklist'], queryFn: api.blacklist.list, staleTime: 60_000 });
  const lists = useQuery({ queryKey: ['lists'], queryFn: api.lists.list, staleTime: 60_000 });
  const chatMeta = useQuery({ queryKey: ['chat-meta'], queryFn: api.chatMeta.get, staleTime: 60_000 });

  // close the pickers on any press outside them
  useEffect(() => {
    if (!pickerOpen && !tagPickerOpen) return;
    const close = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
      if (!tagPickerRef.current?.contains(e.target as Node)) setTagPickerOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [pickerOpen, tagPickerOpen]);

  /** Merge a saved list's members in as chips, names included ({{name}} source). */
  async function addFromList(id: string) {
    setPickerOpen(false);
    try {
      const detail = await api.lists.get(id);
      const byId = new Map(value.map((r) => [r.id, r]));
      let changed = false;
      for (const m of detail.members) {
        const existing = byId.get(m.recipient);
        if (existing) {
          // the list fills a missing name, mirroring the table's re-paste rule
          if (!existing.name && m.name) {
            byId.set(m.recipient, { ...existing, name: m.name });
            changed = true;
          }
          continue;
        }
        byId.set(m.recipient, { id: m.recipient, isGroup: m.isGroup, ...(m.name ? { name: m.name } : {}) });
        changed = true;
      }
      if (changed) onChange([...byId.values()]);
    } catch {
      setInvalid(['could not load list']);
    }
  }

  /** Everyone whose chat carries the tag, resolved at pick time. */
  async function addFromTag(tag: string) {
    setTagPickerOpen(false);
    try {
      const { jids } = await api.chatMeta.byTag(tag);
      const seen = new Set(value.map((r) => r.id));
      const added: Recipient[] = [];
      for (const jid of jids) {
        const id = jid.includes('@g.us') ? jid : (jid.split('@')[0] ?? jid);
        if (seen.has(id)) continue;
        seen.add(id);
        added.push({ id, isGroup: jid.includes('@g.us') });
      }
      if (added.length) onChange([...value, ...added]);
    } catch {
      setInvalid(['could not load tagged chats']);
    }
  }

  const blacklisted = new Set((blacklist.data ?? []).map((e) => e.phone_number));
  const flagged = value.filter(
    (r) => !r.isGroup && blacklisted.has(normalizePhone(r.id) ?? r.id.split('@')[0] ?? ''),
  );

  function commit(text: string) {
    const bad: string[] = [];
    const seen = new Set(value.map((r) => r.id));
    const added: Recipient[] = [];
    const push = (r: Recipient) => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      added.push(r);
    };
    for (const line of text.split('\n').map((s) => s.trim()).filter(Boolean)) {
      // a line of pure numbers ("a, b; c") is many recipients; anything else
      // is one `number, name` row (Excel paste) so the name survives
      const parts = line.split(/[,;\t|]+/).map((s) => s.trim()).filter(Boolean);
      const ids = parts.map(normalizeRecipientId);
      if (parts.length > 1 && ids.every(Boolean)) {
        for (const id of ids as string[]) push({ id, isGroup: id.includes('@g.us') });
        continue;
      }
      const row = parseRecipientLine(line);
      if (row) push(row);
      else bad.push(line);
    }
    if (added.length) onChange([...value, ...added]);
    setInvalid(bad);
    setDraft('');
  }

  return (
    <div>
      <div
        className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1.5"
        onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}
      >
        {value.slice(0, CHIP_CAP).map((r) => (
          <span
            key={r.id}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
              r.isGroup ? 'bg-blue-50 text-blue-700' : 'bg-green-50 text-wa-dark'
            }`}
          >
            {r.name && (
              <span className="max-w-28 truncate" dir="auto">
                {r.name}
              </span>
            )}
            <span className="font-mono">{r.isGroup ? `👥 ${r.id.split('@')[0]}` : r.id}</span>
            <button
              type="button"
              onClick={() => onChange(value.filter((x) => x.id !== r.id))}
              className="text-gray-400 hover:text-red-500"
            >
              ✕
            </button>
          </span>
        ))}
        {value.length > CHIP_CAP && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setTableSelectAll(false);
              setTableOpen(true);
            }}
            className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-200"
          >
            +{value.length - CHIP_CAP} more — open table
          </button>
        )}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit(draft);
            } else if (e.key === 'Backspace' && !draft && value.length) {
              onChange(value.slice(0, -1));
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !draft && value.length) {
              // chips aren't selectable text, so Ctrl+A means "select recipients":
              // hand it to the table, which does have per-row selection
              e.preventDefault();
              setTableSelectAll(true);
              setTableOpen(true);
            }
          }}
          onBlur={() => draft.trim() && commit(draft)}
          onPaste={(e) => {
            e.preventDefault();
            commit(e.clipboardData.getData('text'));
          }}
          placeholder={value.length ? '' : 'Type a number and press Enter…'}
          className="min-w-44 flex-1 border-none bg-transparent py-0.5 text-sm outline-none"
        />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <p className="text-xs text-gray-400">
          {value.length} recipient{value.length === 1 ? '' : 's'}
          {value.some((r) => r.name) && (
            <span> · {value.filter((r) => r.name).length} with a name for {'{{first_name}}'}</span>
          )}{' '}
          · Enter or comma after each
        </p>
        <button
          type="button"
          // preventDefault keeps the input focused: its blur-commit re-renders the
          // chips row mid-click, moving this button before mouseup lands on it
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (draft.trim()) commit(draft);
            setTableSelectAll(false);
            setTableOpen(true);
          }}
          title="Edit recipients as a number/name table — select, remove in bulk, paste straight from Excel"
          className="rounded-md border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-600 hover:border-wa hover:bg-green-50 hover:text-wa-dark"
        >
          ⊞ Table
        </button>
        {value.length > 0 && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setCleared(value);
              onChange([]);
              setInvalid([]);
              setDraft('');
            }}
            title="Remove every recipient (undoable)"
            className="rounded-md border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-600 hover:border-red-300 hover:bg-red-50 hover:text-red-600"
          >
            ✕ Clear all
          </button>
        )}
        {cleared && !value.length && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange(cleared);
              setCleared(null);
            }}
            className="rounded-md border border-wa bg-green-50 px-2 py-0.5 text-xs font-medium text-wa-dark hover:bg-green-100"
          >
            ↩ Undo — restore {cleared.length}
          </button>
        )}
        {(lists.data ?? []).length > 0 && (
          <div ref={pickerRef} className="relative">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (draft.trim()) commit(draft);
                setPickerOpen(!pickerOpen);
              }}
              className="rounded-md border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-600 hover:border-wa hover:bg-green-50 hover:text-wa-dark"
            >
              ＋ Add from list ▾
            </button>
            {pickerOpen && (
              <ul className="absolute left-0 top-full z-10 mt-1 max-h-48 w-56 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                {(lists.data ?? []).map((l) => (
                  <li key={l.id}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void addFromList(l.id)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-green-50"
                    >
                      <span className="min-w-0 truncate" dir="auto">
                        {l.name}
                      </span>
                      <span className="shrink-0 text-xs text-gray-400">{l.memberCount}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {(chatMeta.data?.allTags ?? []).length > 0 && (
          <div ref={tagPickerRef} className="relative">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (draft.trim()) commit(draft);
                setTagPickerOpen(!tagPickerOpen);
              }}
              className="rounded-md border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-600 hover:border-wa hover:bg-green-50 hover:text-wa-dark"
            >
              🏷 Add by tag ▾
            </button>
            {tagPickerOpen && (
              <ul className="absolute left-0 top-full z-10 mt-1 max-h-48 w-56 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                {(chatMeta.data?.allTags ?? []).map((t) => (
                  <li key={t}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void addFromTag(t)}
                      className="w-full px-3 py-1.5 text-left text-sm hover:bg-green-50"
                      dir="auto"
                    >
                      {t}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {invalid.length > 0 && (
        <div className="mt-1 text-xs text-red-500">Invalid, not added: {invalid.join(', ')}</div>
      )}
      {flagged.length > 0 && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          ⚠ {flagged.length} recipient{flagged.length === 1 ? ' is' : 's are'} blacklisted and will
          be skipped at send time: {flagged.map((r) => r.id).join(', ')}
        </div>
      )}
      {tableOpen && (
        <RecipientTableModal
          value={value}
          onApply={onChange}
          onClose={() => {
            setTableOpen(false);
            setTableSelectAll(false);
          }}
          selectAllOnOpen={tableSelectAll}
        />
      )}
    </div>
  );
}
