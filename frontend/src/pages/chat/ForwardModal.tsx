import { useState } from 'react';
import type { ChatMsg, Conv } from '../../lib/chatModel';

export interface ForwardModalProps {
  msg: ChatMsg;
  convs: Conv[];
  /** resolves when the send finished; the modal shows a busy state meanwhile */
  onPick: (target: Conv) => Promise<void>;
  onClose: () => void;
}

/** Pick a conversation to forward a message to. */
export default function ForwardModal({ msg, convs, onPick, onClose }: ForwardModalProps) {
  const [query, setQuery] = useState('');
  const [busyJid, setBusyJid] = useState('');

  const q = query.trim().toLowerCase();
  const list = convs.filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.includes(q)).slice(0, 50);

  async function pick(c: Conv) {
    if (busyJid) return;
    setBusyJid(c.id);
    try {
      await onPick(c);
    } finally {
      setBusyJid('');
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Forward message"
        className="animate-pop flex max-h-[80vh] w-full max-w-md flex-col rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h3 className="font-semibold text-gray-800">Forward to…</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2 py-0.5 text-gray-400 hover:bg-gray-100"
          >
            ✕
          </button>
        </div>

        <div className="space-y-2 p-4 pb-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            dir="auto"
            autoFocus
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <div className="truncate rounded-md bg-gray-50 px-2 py-1.5 text-xs text-gray-500" dir="auto">
            <span className="text-gray-400">Forwarding: </span>
            {msg.text || msg.caption || `📎 ${msg.type}`}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-gray-100">
          {!list.length && <div className="p-4 text-center text-sm text-gray-400">No matching chats</div>}
          {list.map((c) => (
            <button
              key={c.id}
              onClick={() => void pick(c)}
              disabled={!!busyJid}
              className="flex w-full items-center gap-2 border-b border-gray-50 px-4 py-2 text-left hover:bg-gray-50 disabled:opacity-50"
            >
              <span className="min-w-0 truncate text-sm font-medium" dir="auto">
                {c.isGroup ? '👥 ' : ''}
                {c.name}
              </span>
              <span className="ml-auto shrink-0 text-xs text-gray-400">
                {busyJid === c.id ? 'Sending…' : ''}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
