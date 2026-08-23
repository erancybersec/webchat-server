import { useMemo, useState } from 'react';
import type { Conv } from '../../lib/chatModel';

export interface QuickSwitcherProps {
  convs: Conv[];
  onPick: (jid: string) => void;
  onClose: () => void;
}

/** Ctrl+K command-palette-style chat switcher. */
export default function QuickSwitcher({ convs, onPick, onClose }: QuickSwitcherProps) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return convs
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.includes(q))
      .slice(0, 12);
  }, [convs, query]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') return onClose();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(list.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter' && list[sel]) {
      onPick(list[sel].id);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Jump to chat"
        className="animate-pop flex max-h-[60vh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKey}
          placeholder="Jump to chat…"
          dir="auto"
          autoFocus
          className="border-b border-gray-100 px-4 py-3 text-sm outline-none"
        />
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {!list.length && <div className="px-4 py-3 text-sm text-gray-400">No matching chats</div>}
          {list.map((c, i) => (
            <button
              key={c.id}
              onClick={() => onPick(c.id)}
              onMouseEnter={() => setSel(i)}
              className={`flex w-full items-center gap-2 px-4 py-2 text-left ${
                i === sel ? 'bg-green-50' : ''
              }`}
            >
              <span className="min-w-0 truncate text-sm font-medium" dir="auto">
                {c.isGroup ? '👥 ' : ''}
                {c.name}
              </span>
              {c.unreadCount > 0 && (
                <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-wa px-1 text-xs font-bold text-white">
                  {c.unreadCount > 99 ? '99+' : c.unreadCount}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="border-t border-gray-100 px-4 py-1.5 text-[10px] text-gray-400">
          ↑↓ navigate · Enter open · Esc close
        </div>
      </div>
    </div>
  );
}
