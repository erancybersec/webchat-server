import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useToast } from './Toast';
import { api } from '../lib/api';
import { normalizePhone } from '../lib/phone';
import type { BlacklistEntry } from '../types';

export interface BlacklistAddDialogProps {
  /** number as shown in the chat ("+9725…"); may be empty for an unresolved @lid */
  phone: string;
  /** contact name, prefilled so the blacklist row is recognizable later */
  name?: string;
  onClose: () => void;
}

/**
 * Blacklist a contact without leaving the conversation: the reason is the whole
 * point of the panel's form, so it is asked for here too rather than being left
 * blank by a one-click action. A number already on the list opens in edit mode,
 * since that is the other thing you want from a chat — fix or lift the entry.
 */
export default function BlacklistAddDialog({ phone, name, onClose }: BlacklistAddDialogProps) {
  const qc = useQueryClient();
  const flash = useToast();
  const [num, setNum] = useState(phone.replace(/^\+/, ''));
  const [who, setWho] = useState(name ?? '');
  const [why, setWhy] = useState('');
  const [err, setErr] = useState('');
  const whyRef = useRef<HTMLInputElement>(null);

  const list = useQuery({ queryKey: ['blacklist'], queryFn: api.blacklist.list, staleTime: 60_000 });
  const key = normalizePhone(num);
  const existing: BlacklistEntry | undefined = key
    ? (list.data ?? []).find((e) => e.phone_number === key)
    : undefined;

  // reason first: the number and name arrive prefilled from the chat
  useEffect(() => whyRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // an entry found for the typed number fills the form once, so "Update" edits
  // the real reason instead of blanking it
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!existing || loadedFor.current === existing.phone_number) return;
    loadedFor.current = existing.phone_number;
    setWho(existing.name || (name ?? ''));
    setWhy(existing.why_blacklisted || '');
  }, [existing, name]);

  const done = (msg: string) => {
    void qc.invalidateQueries({ queryKey: ['blacklist'] });
    flash(msg);
    onClose();
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!key) throw new Error('that is not a phone number we can normalize');
      if (existing)
        return api.blacklist
          .update(existing.phone_number, { name: who.trim(), why_blacklisted: why.trim() })
          .then(() => 'updated' as const);
      const r = await api.blacklist.add({
        phone_number: num.trim(),
        name: who.trim(),
        why_blacklisted: why.trim(),
      });
      if (!r.added) throw new Error(r.invalid?.length ? `rejected: ${r.invalid.join(', ')}` : 'not added');
      return 'added' as const;
    },
    onSuccess: (what) =>
      done(what === 'added' ? 'Blacklisted — campaigns skip this number' : 'Blacklist entry updated'),
    onError: (e) => setErr(String((e as Error).message ?? e)),
  });

  const lift = useMutation({
    mutationFn: () => api.blacklist.remove(existing!.phone_number),
    onSuccess: () => done('Removed from the blacklist'),
    onError: (e) => setErr(String((e as Error).message ?? e)),
  });

  const busy = save.isPending || lift.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={existing ? 'Edit blacklist entry' : 'Add to blacklist'}
        className="animate-pop w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-gray-800">
          {existing ? 'Already blacklisted' : 'Add to blacklist'}
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          {existing
            ? `On the list since ${new Date(existing.added_date).toLocaleDateString()}. Edit the reason, or lift it.`
            : 'Campaigns and scheduled jobs skip this number. Replies in this chat still work — blacklisting is not blocking.'}
        </p>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Phone *</span>
            <input
              value={num}
              onChange={(e) => {
                setNum(e.target.value);
                setErr('');
              }}
              dir="ltr"
              placeholder="0543970120 or 972500000009"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
            />
            {!key && num.trim() && (
              <span className="mt-1 block text-xs text-red-500">
                Not a number we can normalize — check it against the chat header.
              </span>
            )}
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Name</span>
            <input
              value={who}
              onChange={(e) => setWho(e.target.value)}
              dir="auto"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Why blacklisted</span>
            <input
              ref={whyRef}
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && key && !busy && save.mutate()}
              dir="auto"
              placeholder="asked to stop / wrong number / complained…"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>

        {err && <p className="mt-2 text-xs text-red-500">{err}</p>}

        <div className="mt-4 flex items-center gap-2">
          {existing && (
            <button
              onClick={() => lift.mutate()}
              disabled={busy}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:border-red-300 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            >
              Remove from blacklist
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={() => save.mutate()}
              disabled={!key || busy}
              className="rounded-lg bg-wa px-4 py-2 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
            >
              {busy ? '…' : existing ? 'Save reason' : 'Add to blacklist'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
