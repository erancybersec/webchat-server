import { useEffect, useState } from 'react';
import { useMe } from '../../lib/agents';
import { navigateTab } from '../../lib/nav';
import type { QuickRepliesApi } from '../../lib/quickReplies';
import QuickReplyForm from './QuickReplyForm';

export interface QuickRepliesModalProps {
  store: QuickRepliesApi;
  onClose: () => void;
  /** Pre-fill the new-reply form (e.g. the picker query that had no match). */
  initialShortcut?: string;
}

/** Manage saved quick replies: add, edit, delete, search (server-side store). */
export default function QuickRepliesModal({ store, onClose, initialShortcut }: QuickRepliesModalProps) {
  const { replies } = store;
  const [query, setQuery] = useState('');
  // null = list view, -1 = adding, >=0 = editing the reply with that id
  const [editIdx, setEditIdx] = useState<number | null>(initialShortcut !== undefined ? -1 : null);
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null);
  // personal replies exist only with an identity to own them
  const me = useMe();
  const canPersonal = !!(me.data?.enabled && me.data.email);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const visible = replies.filter(
    (r) => !q || r.shortcut.toLowerCase().includes(q) || r.text.toLowerCase().includes(q),
  );

  const editing = editIdx !== null && editIdx >= 0 ? replies.find((r) => r.id === editIdx) : undefined;

  /** A shortcut clashes when another reply already owns it (case-insensitive). */
  const isTaken = (s: string) =>
    replies.some((r) => r.shortcut.toLowerCase() === s.toLowerCase() && r.id !== editIdx);

  function openManager() {
    onClose();
    navigateTab('quickreplies');
  }

  function remove(id: number) {
    store.remove(id);
    setConfirmIdx(null);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Manage quick replies"
        className="animate-pop flex max-h-[80vh] w-full max-w-md flex-col rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h3 className="font-semibold text-gray-800">Quick replies</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2 py-0.5 text-gray-400 hover:bg-gray-100"
          >
            ✕
          </button>
        </div>

        {editIdx !== null ? (
          <QuickReplyForm
            mode={editIdx >= 0 ? 'edit' : 'add'}
            initial={
              editing
                ? { shortcut: editing.shortcut, text: editing.text, personal: !!editing.agentEmail, media: editing.media }
                : { shortcut: initialShortcut ?? '' }
            }
            canPersonal={canPersonal}
            isTaken={isTaken}
            onCancel={() => setEditIdx(null)}
            onSubmit={({ shortcut, text, personal, media }) => {
              if (editIdx >= 0) store.edit(editIdx, shortcut, text, media);
              else store.add(shortcut, text, personal, media);
              setEditIdx(null);
            }}
          />
        ) : (
          <>
            <div className="flex items-center gap-2 p-4 pb-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search quick replies…"
                dir="auto"
                autoFocus
                className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
              <button
                onClick={() => {
                  setConfirmIdx(null);
                  setEditIdx(-1);
                }}
                className="shrink-0 rounded-md bg-wa px-3 py-2 text-sm font-medium text-white hover:bg-wa-dark"
              >
                + New
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto border-t border-gray-100">
              {!visible.length && (
                <div className="p-6 text-center text-sm text-gray-400">
                  {replies.length
                    ? 'No matches.'
                    : 'No quick replies yet. Save snippets you send often, then type “/” in the composer to use them.'}
                </div>
              )}
              {visible.map((r) => (
                <div
                  key={r.id}
                  className="group flex items-start gap-2 border-b border-gray-50 px-4 py-2.5 hover:bg-gray-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs font-medium text-wa-dark">
                      /{r.shortcut}
                      {r.media && (
                        <span className="ml-1.5 font-sans text-[10px] text-gray-400" title={`${r.media.mediatype} attached`}>
                          📎 {r.media.mediatype}
                        </span>
                      )}
                      {r.agentEmail && (
                        <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-px font-sans text-[10px] font-medium text-amber-700">
                          personal
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-sm text-gray-600" dir="auto">
                      {r.text || <span className="text-gray-400">(no caption)</span>}
                    </div>
                  </div>
                  {confirmIdx === r.id ? (
                    <div className="flex shrink-0 items-center gap-1 text-xs">
                      <button
                        onClick={() => remove(r.id)}
                        className="rounded-md bg-red-500 px-2 py-1 font-medium text-white hover:bg-red-600"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirmIdx(null)}
                        className="rounded-md border border-gray-300 px-2 py-1 text-gray-600 hover:bg-gray-100"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        onClick={() => {
                          setConfirmIdx(null);
                          setEditIdx(r.id);
                        }}
                        title="Edit"
                        aria-label={`Edit /${r.shortcut}`}
                        className="rounded p-1.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z"/></svg>
                      </button>
                      <button
                        onClick={() => setConfirmIdx(r.id)}
                        title="Delete"
                        aria-label={`Delete /${r.shortcut}`}
                        className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="border-t border-gray-100 px-4 py-2 text-right">
              <button
                onClick={openManager}
                className="text-xs font-medium text-wa-dark hover:underline"
              >
                Manage all quick replies →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
