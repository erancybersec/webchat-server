import { useMemo, useState } from 'react';
import { displayNumber, isGroupJid } from '../../lib/chatModel';
import { normalizeRecipientId } from '../../lib/phone';

export interface NewChatModalProps {
  /** raw /api/contacts records */
  contacts: Array<Record<string, any>>;
  onOpen: (jid: string) => void;
  onClose: () => void;
}

/**
 * v1's "New Chat": type any phone number (even one with no conversation yet)
 * or pick from the contact book.
 */
export default function NewChatModal({ contacts, onOpen, onClose }: NewChatModalProps) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const list = useMemo(() => {
    const q = input.trim().toLowerCase();
    const seen = new Set<string>();
    const out: Array<{ jid: string; name: string; phone: string }> = [];
    for (const c of contacts ?? []) {
      const jid: string = c.remoteJid ?? c.id ?? '';
      if (!jid || isGroupJid(jid) || jid === 'status@broadcast' || seen.has(jid)) continue;
      const name: string = c.savedName || c.displayName || c.pushName || '';
      const phone = displayNumber(jid);
      if (q && !name.toLowerCase().includes(q) && !phone.includes(q)) continue;
      seen.add(jid);
      out.push({ jid, name: name || phone, phone });
      if (out.length >= 50) break;
    }
    return out;
  }, [contacts, input]);

  function startByNumber() {
    const normalized = normalizeRecipientId(input);
    if (!normalized) {
      setError('Enter a valid phone number, e.g. 972501234567 or 0501234567');
      return;
    }
    onOpen(normalized.includes('@') ? normalized : `${normalized}@s.whatsapp.net`);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New chat"
        className="animate-pop flex max-h-[80vh] w-full max-w-md flex-col rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h3 className="font-semibold text-gray-800">New chat</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2 py-0.5 text-gray-400 hover:bg-gray-100"
          >
            ✕
          </button>
        </div>

        <div className="space-y-2 p-4">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  startByNumber();
                }
              }}
              placeholder="Phone number or contact search…"
              dir="auto"
              autoFocus
              className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
            <button
              onClick={startByNumber}
              className="shrink-0 rounded-md bg-wa px-3 py-2 text-sm font-medium text-white hover:bg-wa-dark"
            >
              Start chat
            </button>
          </div>
          {error && (
            <div role="alert" className="text-xs text-red-600">
              {error}
            </div>
          )}
          <p className="text-xs text-gray-400">
            Works with numbers that have no existing conversation — e.g. 972501234567.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-gray-100">
          {!list.length && <div className="p-4 text-center text-sm text-gray-400">No matching contacts</div>}
          {list.map((c) => (
            <button
              key={c.jid}
              onClick={() => onOpen(c.jid)}
              className="flex w-full items-baseline gap-2 border-b border-gray-50 px-4 py-2 text-left hover:bg-gray-50"
            >
              <span className="min-w-0 truncate text-sm font-medium" dir="auto">
                {c.name}
              </span>
              <span className="ml-auto shrink-0 text-xs text-gray-400">{c.phone}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
