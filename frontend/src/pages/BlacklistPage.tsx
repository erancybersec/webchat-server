import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useConfirm } from '../components/Confirm';
import { Switch } from '../components/Switch';
import { useToast } from '../components/Toast';
import { useIsAdmin } from '../lib/agents';
import { api } from '../lib/api';
import { normalizePhone } from '../lib/phone';
import type { BlacklistEntry, VerifyStatus } from '../types';

declare global {
  interface Window {
    XLSX?: any;
  }
}

type ParsedRow = { phone: string; name: string; why: string };

/** Dynamically load SheetJS only when an Excel file is dropped (no build-time dep). */
function loadSheetJS(): Promise<any> {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('SheetJS load failed'));
    document.head.appendChild(s);
  });
}

/** Parse one import line: phone first, then name, reason (comma / tab / pipe). */
function parseLine(line: string): ParsedRow | { error: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed
    .split(/[,\t|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  let phone: string | null = null;
  let idx = -1;
  for (let i = 0; i < parts.length; i++) {
    const p = normalizePhone(parts[i]);
    if (p) {
      phone = p;
      idx = i;
      break;
    }
  }
  if (!phone) return { error: trimmed };
  const rest = parts.filter((_, i) => i !== idx);
  return { phone, name: rest[0] ?? '', why: rest[1] ?? '' };
}

const CSV_COLS: Array<keyof BlacklistEntry> = [
  'id',
  'phone_number',
  'name',
  'added_date',
  'why_blacklisted',
];

export default function BlacklistPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['blacklist'], queryFn: api.blacklist.list });
  const entries = list.data ?? [];

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const flash = useToast();
  const confirmDlg = useConfirm();

  const invalidate = () => qc.invalidateQueries({ queryKey: ['blacklist'] });

  const q = search.trim().toLowerCase();
  const rows = entries.filter(
    (e) =>
      !q ||
      e.phone_number.includes(q) ||
      (e.name ?? '').toLowerCase().includes(q) ||
      (e.why_blacklisted ?? '').toLowerCase().includes(q),
  );

  // ── mutations ──────────────────────────────────────────────────────────────
  const addOne = useMutation({
    mutationFn: (r: ParsedRow) =>
      api.blacklist.add({ phone_number: r.phone, name: r.name, why_blacklisted: r.why }),
    onSuccess: (res, r) => {
      invalidate();
      flash(res.added ? `Added: ${r.phone}` : 'Already on the list');
    },
    onError: (e) => flash(`Could not save — ${(e as Error).message}`, 'err'),
  });

  const addMany = useMutation({
    mutationFn: (rs: ParsedRow[]) =>
      api.blacklist.addMany(
        rs.map((r) => ({ phone_number: r.phone, name: r.name, why_blacklisted: r.why })),
      ),
    onSuccess: (res) => {
      invalidate();
      flash(`${res.added} added${res.invalid.length ? `, ${res.invalid.length} skipped` : ''}`);
    },
    onError: () => flash('Import failed', 'err'),
  });

  const update = useMutation({
    mutationFn: ({ phone, patch }: { phone: string; patch: Partial<BlacklistEntry> }) =>
      api.blacklist.update(phone, patch),
    onSuccess: () => {
      invalidate();
      flash('Saved');
    },
    onError: (e) => flash(`Save failed — ${String((e as Error).message ?? e)}`, 'err'),
  });

  const removeMany = useMutation({
    mutationFn: (phones: string[]) =>
      phones.length === 1
        ? api.blacklist.remove(phones[0]).then(() => undefined)
        : api.blacklist.removeMany(phones).then(() => undefined),
    onSuccess: (_r, phones) => {
      setSelected((prev) => {
        const next = new Set(prev);
        phones.forEach((p) => next.delete(p));
        return next;
      });
      invalidate();
      flash(`${phones.length} removed`);
    },
    onError: () => flash('Delete failed', 'err'),
  });

  // ── selection ────────────────────────────────────────────────────────────────
  function toggleSel(phone: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(phone) ? next.delete(phone) : next.add(phone);
      return next;
    });
  }
  function toggleAll(on: boolean) {
    setSelected(on ? new Set(rows.map((r) => r.phone_number)) : new Set());
  }
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.phone_number));

  async function deleteOne(e: BlacklistEntry) {
    const ok = await confirmDlg({
      title: `Remove ${e.name || e.phone_number}?`,
      body: 'The number can be messaged again once removed from the blacklist.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) removeMany.mutate([e.phone_number]);
  }
  async function deleteSelected() {
    const phones = [...selected];
    if (!phones.length) return;
    const ok = await confirmDlg({
      title: `Remove ${phones.length} number${phones.length === 1 ? '' : 's'}?`,
      body: 'They can be messaged again once removed from the blacklist.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) removeMany.mutate(phones);
  }

  // ── inline edit commit ────────────────────────────────────────────────────────
  function commitEdit(entry: BlacklistEntry, field: keyof BlacklistEntry, raw: string): boolean {
    const val = raw.trim();
    if (field === 'phone_number') {
      if (val === entry.phone_number) return true;
      const n = normalizePhone(val);
      if (!n) {
        flash('Invalid phone — reverted', 'err');
        return false;
      }
      if (n !== entry.phone_number && entries.some((b) => b.phone_number === n)) {
        flash('Already on the list — reverted', 'err');
        return false;
      }
      // selection is keyed by phone — drop the old number or "Delete
      // selected" would later post a phone that no longer exists
      setSelected((prev) => {
        if (!prev.has(entry.phone_number)) return prev;
        const next = new Set(prev);
        next.delete(entry.phone_number);
        next.add(n);
        return next;
      });
      update.mutate({ phone: entry.phone_number, patch: { phone_number: n } });
      return true;
    }
    if (val !== (entry[field] ?? '')) {
      update.mutate({ phone: entry.phone_number, patch: { [field]: val } });
    }
    return true;
  }

  // ── export ────────────────────────────────────────────────────────────────────
  function asTable(): string[][] {
    return [CSV_COLS as string[]].concat(
      entries.map((b) => CSV_COLS.map((k) => (b[k] != null ? String(b[k]) : ''))),
    );
  }
  function exportCsv() {
    const csv = asTable()
      .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
      .join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'blacklist.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    flash('CSV downloaded');
  }
  function copyTable() {
    const tsv = asTable()
      .map((r) => r.join('\t'))
      .join('\n');
    navigator.clipboard
      ?.writeText(tsv)
      .then(() => flash(`Copied ${entries.length} rows`))
      .catch(() => flash('Copy failed', 'err'));
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 overflow-y-auto p-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800">
          Blacklist
          {entries.length > 0 && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
              {entries.length}
            </span>
          )}
        </h2>
        <p className="text-sm text-gray-500">
          Numbers here are never messaged — Compose &amp; bulk sends skip them automatically.
        </p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 p-3">
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="rounded-lg bg-wa px-4 py-2 text-sm font-semibold text-white hover:bg-wa-dark"
          >
            ＋ Add number
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            📋 Paste / Import
          </button>
          {selected.size > 0 && (
            <button
              onClick={() => void deleteSelected()}
              className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
            >
              🗑 Delete selected ({selected.size})
            </button>
          )}
          <div className="relative min-w-44 flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">
              🔎
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search number, name, or reason…"
              dir="auto"
              className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm"
            />
          </div>
          <span className="text-xs text-gray-500">
            {entries.length} {entries.length === 1 ? 'number' : 'numbers'}
          </span>
          <button
            onClick={exportCsv}
            title="Download CSV"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            ⬇ CSV
          </button>
          <button
            onClick={copyTable}
            title="Copy to clipboard"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            ⧉ Copy
          </button>
        </div>

        {showAdd && (
          <AddForm
            existing={entries}
            onClose={() => setShowAdd(false)}
            onAdd={(r) => {
              addOne.mutate(r);
              setShowAdd(false);
            }}
          />
        )}

        {/* table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="w-9 px-3 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => toggleAll(e.target.checked)}
                  />
                </th>
                <th className="w-12 px-3 py-2">id</th>
                <th className="w-40 px-3 py-2">phone_number</th>
                <th className="w-36 px-3 py-2">name</th>
                <th className="px-3 py-2">why_blacklisted</th>
                <th className="w-28 px-3 py-2">added_date</th>
                <th className="w-10 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {list.isLoading && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-gray-400">
                    Loading…
                  </td>
                </tr>
              )}
              {!list.isLoading && !rows.length && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-gray-400">
                    {entries.length === 0
                      ? 'Blacklist is empty — add a number or import a list.'
                      : 'No numbers match your search.'}
                  </td>
                </tr>
              )}
              {rows.map((e) => (
                <tr
                  key={e.id}
                  className={`border-t border-gray-100 ${
                    selected.has(e.phone_number) ? 'bg-green-50/50' : ''
                  }`}
                >
                  <td className="px-3 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={selected.has(e.phone_number)}
                      onChange={() => toggleSel(e.phone_number)}
                    />
                  </td>
                  <td className="px-3 py-2 text-gray-400">{e.id}</td>
                  <td className="px-3 py-2">
                    <EditableCell
                      value={e.phone_number}
                      mono
                      dir="ltr"
                      onCommit={(v) => commitEdit(e, 'phone_number', v)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <EditableCell
                      value={e.name}
                      placeholder="—"
                      onCommit={(v) => commitEdit(e, 'name', v)}
                    />
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    <EditableCell
                      value={e.why_blacklisted}
                      placeholder="—"
                      onCommit={(v) => commitEdit(e, 'why_blacklisted', v)}
                    />
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-400">{e.added_date}</td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => void deleteOne(e)}
                      title="Remove"
                      className="rounded px-2 py-0.5 text-base leading-none text-gray-400 hover:bg-red-50 hover:text-red-600"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-gray-50 px-3 py-2 text-[11px] text-gray-400">
          Tip: click any phone, name, or reason cell to edit it inline (Enter to save).
        </div>
      </div>

      <OptOutCard />
      <NotOnWhatsAppCard />

      {showImport && (
        <ImportModal
          existing={entries}
          onClose={() => setShowImport(false)}
          onImport={(rs) => {
            addMany.mutate(rs);
            setShowImport(false);
          }}
          onError={(m) => flash(m, 'err')}
        />
      )}

    </div>
  );
}

// ── auto opt-out management ───────────────────────────────────────────────────
// Lives here (not Settings) because its output lands on this page: matched
// senders become blacklist rows with reason "opt-out (auto)".
function OptOutCard() {
  const qc = useQueryClient();
  const flash = useToast();
  const isAdmin = useIsAdmin();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });

  const [enabled, setEnabled] = useState(false);
  const [keywords, setKeywords] = useState('');
  const [reply, setReply] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!settings.data || dirty) return;
    setEnabled(settings.data.optoutEnabled);
    setKeywords(settings.data.optoutKeywords);
    setReply(settings.data.optoutReply);
  }, [settings.data, dirty]);

  const save = useMutation({
    mutationFn: (patch: { optoutEnabled: boolean; optoutKeywords: string; optoutReply: string }) =>
      api.settings.save(patch),
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['settings'] });
      flash('Auto opt-out settings saved');
    },
    onError: (e) => flash(`Save failed — ${(e as Error).message}`, 'err'),
  });

  // Saving goes through admin-only PUT /api/settings — hide rather than 403.
  // After all hooks so the hook order never changes between renders.
  if (isAdmin === false) return null;

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-700">Auto opt-out</h3>
          <p className="text-xs text-gray-500">
            When someone replies with one of these exact words, they are added to the blacklist
            automatically (reason: “opt-out (auto)”). Group messages are ignored.
          </p>
        </div>
        <Switch
          on={enabled}
          onToggle={() => {
            setEnabled(!enabled);
            setDirty(true);
          }}
          label="Auto opt-out"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Keywords (comma-separated)</label>
        <input
          value={keywords}
          dir="auto"
          onChange={(e) => {
            setKeywords(e.target.value);
            setDirty(true);
          }}
          placeholder="STOP, הסר"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          Confirmation reply <span className="font-normal text-gray-400">(optional — empty sends nothing)</span>
        </label>
        <input
          value={reply}
          dir="auto"
          onChange={(e) => {
            setReply(e.target.value);
            setDirty(true);
          }}
          placeholder="הוסרת מרשימת התפוצה"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
      </div>
      <button
        onClick={() =>
          save.mutate({ optoutEnabled: enabled, optoutKeywords: keywords, optoutReply: reply })
        }
        disabled={!dirty || save.isPending}
        className="rounded-lg bg-wa px-4 py-2 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
      >
        {save.isPending ? 'Saving…' : 'Save auto opt-out'}
      </button>
    </div>
  );
}

// ── inline-editable cell ───────────────────────────────────────────────────────
function EditableCell({
  value,
  onCommit,
  mono,
  dir,
  placeholder,
}: {
  value: string;
  onCommit: (next: string) => boolean;
  mono?: boolean;
  dir?: 'ltr' | 'auto';
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function start() {
    setDraft(value);
    setEditing(true);
  }
  function commit() {
    setEditing(false);
    if (draft.trim() !== (value ?? '')) onCommit(draft);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        dir={dir ?? 'auto'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        className={`w-full rounded border border-wa px-1.5 py-0.5 text-sm outline-none ${
          mono ? 'font-mono' : ''
        }`}
      />
    );
  }
  return (
    <span
      onClick={start}
      dir={dir ?? 'auto'}
      className={`-mx-1 block cursor-text rounded px-1 py-0.5 hover:bg-gray-50 ${
        mono ? 'font-mono' : ''
      } ${!value ? 'text-gray-300' : ''}`}
    >
      {value || placeholder || ''}
    </span>
  );
}

// ── inline add form ──────────────────────────────────────────────────────────
function AddForm({
  existing,
  onAdd,
  onClose,
}: {
  existing: BlacklistEntry[];
  onAdd: (r: ParsedRow) => void;
  onClose: () => void;
}) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [why, setWhy] = useState('');
  const [err, setErr] = useState('');

  function submit() {
    const n = normalizePhone(phone);
    if (!n) {
      setErr('Enter a valid phone (Israeli 05X or international).');
      return;
    }
    if (existing.some((b) => b.phone_number === n)) {
      setErr('That number is already on the blacklist.');
      return;
    }
    onAdd({ phone: n, name: name.trim(), why: why.trim() });
  }

  return (
    <div className="flex flex-wrap items-end gap-2 border-b border-gray-100 bg-green-50/50 p-3">
      <label className="min-w-44 flex-1 text-[11px] font-medium text-gray-600">
        Phone <span className="text-red-400">*</span>
        <input
          autoFocus
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="0543970120 or 972500000009"
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="min-w-32 flex-1 text-[11px] font-medium text-gray-600">
        Name
        <input
          value={name}
          dir="auto"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="min-w-40 flex-[2] text-[11px] font-medium text-gray-600">
        Why blacklisted
        <input
          value={why}
          dir="auto"
          onChange={(e) => setWhy(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </label>
      <button
        onClick={submit}
        className="rounded-lg bg-wa px-4 py-2 text-sm font-semibold text-white hover:bg-wa-dark"
      >
        Add
      </button>
      <button
        onClick={onClose}
        className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
      >
        Cancel
      </button>
      {err && <span className="w-full text-xs text-red-600">{err}</span>}
    </div>
  );
}

// ── paste / import modal ───────────────────────────────────────────────────────
function ImportModal({
  existing,
  onImport,
  onClose,
  onError,
}: {
  existing: BlacklistEntry[];
  onImport: (rows: ParsedRow[]) => void;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const [text, setText] = useState('');

  const { parsed, errors } = (() => {
    const out: ParsedRow[] = [];
    const errs: string[] = [];
    const seen = new Set<string>();
    for (const ln of text.split('\n')) {
      if (!ln.trim()) continue;
      const r = parseLine(ln);
      if (r && 'phone' in r) {
        if (!seen.has(r.phone) && !existing.some((b) => b.phone_number === r.phone)) {
          seen.add(r.phone);
          out.push(r);
        }
      } else if (r && 'error' in r) {
        errs.push(r.error);
      }
    }
    return { parsed: out, errors: errs };
  })();

  async function handleFile(input: HTMLInputElement) {
    const f = input.files?.[0];
    if (!f) return;
    const ext = (f.name.split('.').pop() ?? '').toLowerCase();
    try {
      if (ext === 'csv' || ext === 'txt') {
        setText(await f.text());
      } else {
        const XLSX = await loadSheetJS();
        const wb = XLSX.read(await f.arrayBuffer());
        const ws = wb.Sheets[wb.SheetNames[0]];
        const arr = (XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][]).filter(
          (r) => r && r.length,
        );
        setText(arr.map((r) => r.join(', ')).join('\n'));
      }
    } catch {
      onError('Could not read file');
    }
    input.value = '';
  }

  const cell = 'border border-gray-200 px-2 py-1 text-left';

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Paste / Import numbers"
        className="animate-pop flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <span className="font-semibold text-gray-800">Paste / Import numbers</span>
          <button onClick={onClose} className="text-xl leading-none text-gray-400 hover:text-gray-700">
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-2 text-xs text-gray-500">
            One per line — <code>phone</code>, or <code>phone, name, reason</code> (comma / tab /
            pipe separated). Paste straight from Excel.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'0521234567, ישראל ישראלי, ביקש להסיר\n972529876543, דוגמה לקוח\n0501234567'}
            className="h-32 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
          />
          <div className="mt-2 flex items-center gap-2">
            <label className="cursor-pointer rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50">
              📑 Upload Excel / CSV
              <input
                type="file"
                accept=".csv,.xlsx,.xls,.txt"
                className="hidden"
                onChange={(e) => void handleFile(e.target)}
              />
            </label>
            <span className="text-[11px] text-gray-400">
              .xlsx · .xls · .csv — columns: phone · name · reason
            </span>
          </div>

          {parsed.length > 0 && (
            <table className="mt-3 w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className={cell}>phone</th>
                  <th className={cell}>name</th>
                  <th className={cell}>reason</th>
                </tr>
              </thead>
              <tbody>
                {parsed.map((r) => (
                  <tr key={r.phone} className="bg-green-50">
                    <td className={`${cell} font-mono`} dir="ltr">
                      {r.phone}
                    </td>
                    <td className={cell} dir="auto">
                      {r.name || '—'}
                    </td>
                    <td className={cell} dir="auto">
                      {r.why || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-2 text-xs text-gray-500">
            <b>{parsed.length}</b> to add
            {errors.length > 0 && (
              <span className="text-red-600">
                {' '}
                · <b>{errors.length}</b> invalid (skipped)
              </span>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            disabled={!parsed.length}
            onClick={() => onImport(parsed)}
            className="rounded-lg bg-wa px-4 py-2 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
          >
            Add {parsed.length || ''}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The dead-number cache. Deliberately a SEPARATE card from the list above:
 * the blacklist is a policy a person authored, this is an observation WhatsApp
 * handed us that expires on its own. Mixing them would bury a handful of real
 * opt-outs under thousands of machine rows — and make a wrong machine row
 * indistinguishable from a deliberate one.
 */
function NotOnWhatsAppCard() {
  const qc = useQueryClient();
  const flash = useToast();
  const confirmDlg = useConfirm();
  const [status, setStatus] = useState<VerifyStatus>('invalid');
  const [search, setSearch] = useState('');

  const page = useQuery({
    queryKey: ['verification', status, search],
    queryFn: () => api.verification.list({ status, q: search.trim() || undefined, limit: 200 }),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['verification'] });

  const forget = useMutation({
    mutationFn: (phone: string) => api.verification.remove(phone),
    onSuccess: () => {
      invalidate();
      flash('Forgotten — it will be checked again next time');
    },
    onError: (e) => flash(`Could not forget — ${String((e as Error).message ?? e)}`, 'err'),
  });

  const clear = useMutation({
    mutationFn: (s: VerifyStatus) => api.verification.clear(s),
    onSuccess: (r) => {
      invalidate();
      flash(`${r.cleared} forgotten — those numbers get checked again`);
    },
    onError: (e) => flash(`Clear failed — ${String((e as Error).message ?? e)}`, 'err'),
  });

  const counts = page.data?.counts ?? { valid: 0, invalid: 0 };
  const rows = page.data?.rows ?? [];
  const fmt = (iso: string) => new Date(iso).toLocaleDateString();
  /** Past its date the answer is simply stale — see the column's title. */
  const isStale = (iso: string) => iso <= new Date().toISOString();
  // the tab counts are live answers only, so stale rows make the list look longer
  const staleShown = rows.filter((v) => isStale(v.expires_at)).length;

  async function clearAll() {
    const ok = await confirmDlg({
      title: `Forget ${counts.invalid} not-on-WhatsApp number${counts.invalid === 1 ? '' : 's'}?`,
      body: 'They go back in play and get checked against WhatsApp again on the next campaign. Your blacklist is not touched.',
      confirmLabel: 'Forget them',
    });
    if (ok) clear.mutate('invalid');
  }

  const tab = (s: VerifyStatus, label: string, n: number) => (
    <button
      onClick={() => setStatus(s)}
      className={`rounded-full px-3 py-1 text-xs font-medium ${
        status === s ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
      }`}
    >
      {label} ({n})
    </button>
  );

  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div>
        <h3 className="text-sm font-semibold text-gray-700">Checked against WhatsApp</h3>
        <p className="text-xs text-gray-500">
          Before a campaign sends, every recipient is checked against WhatsApp and the answer is
          remembered — so a number that isn’t registered is skipped instead of being retried. This
          is <strong>not</strong> the blacklist: nobody chose to put these here. Nothing re-checks
          in the background either — an answer just goes stale on its date, and the number is asked
          about again the next time it actually comes up in a send.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {tab('invalid', 'Not on WhatsApp', counts.invalid)}
        {tab('valid', 'Confirmed live', counts.valid)}
        <div className="min-w-40 flex-1">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a number…"
            className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
          />
        </div>
        {status === 'invalid' && counts.invalid > 0 && (
          <button
            onClick={() => void clearAll()}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            title="Put every not-on-WhatsApp number back in play — they get checked again"
          >
            Forget all
          </button>
        )}
      </div>

      {page.isLoading ? (
        <p className="py-4 text-center text-sm text-gray-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-gray-400">
          {status === 'invalid'
            ? 'No dead numbers cached — nothing has been rejected by WhatsApp yet.'
            : 'No confirmed numbers cached yet.'}
        </p>
      ) : (
        <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-100">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Number</th>
                <th className="px-3 py-2 font-medium">Checked</th>
                <th
                  className="px-3 py-2 font-medium"
                  title="How long this answer is trusted. Past it, nothing happens on its own — the number is only re-checked if it comes up in a later send."
                >
                  Good until
                </th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.phone_number} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 font-mono text-gray-700">{v.phone_number}</td>
                  <td className="px-3 py-1.5 text-gray-500">{fmt(v.checked_at)}</td>
                  <td className="px-3 py-1.5 text-gray-500">
                    {isStale(v.expires_at) ? (
                      <span
                        className="text-amber-600"
                        title="Stale — checked again the next time this number is in a send"
                      >
                        stale
                      </span>
                    ) : (
                      fmt(v.expires_at)
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button
                      onClick={() => forget.mutate(v.phone_number)}
                      className="text-xs font-medium text-gray-400 hover:text-gray-700"
                      title="Forget this answer — the number is checked again next time"
                    >
                      Forget
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page.data && page.data.total > rows.length && (
        <p className="text-xs text-gray-400">
          Showing {rows.length} of {page.data.total} — narrow it with the search box.
        </p>
      )}
      {staleShown > 0 && (
        <p className="text-xs text-gray-400">
          {staleShown === 1
            ? '1 listed answer is stale — past its date, so the tab count above (trusted answers only) leaves it out. Nothing re-checks it on its own: it is asked about again the next time that number is in a send.'
            : `${staleShown} listed answers are stale — past their dates, so the tab count above (trusted answers only) leaves them out. Nothing re-checks them on its own: each is asked about again the next time that number is in a send.`}
        </p>
      )}
    </div>
  );
}
