import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api, type ToolbarPrefs } from '../lib/api';
import { applyOrder, DEFAULT_ORDER, useVisibleTabs, type Tab } from '../lib/tabs';
import { useToast } from './Toast';

/**
 * Per-person nav tab order. Self-contained like NotificationPrefsCard, and
 * mounted the same way — on the everyone-visible Profile tab, since this is a
 * personal/cosmetic preference, not an admin control. The order decides both
 * which tabs sit in the main bar (the first few — fewer on narrow screens,
 * see lib/tabs#useToolbarSlotCount) and the sequence of the "More" menu.
 *
 * Dragging is Pointer Events, not the native HTML5 Drag-and-Drop API — that
 * API has no touch support at all (silently does nothing on a phone), and on
 * desktop it competes with text selection over the label (dragging from
 * anywhere but the exact handle glyph can start a text-selection drag
 * instead of an element drag). Pointer Events unify mouse/touch/pen and never
 * hand control to the browser's native drag session, so neither problem
 * applies. The ↑/↓ buttons stay as the keyboard/no-pointer-precision path.
 */
export function ToolbarPrefsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const { tabs } = useVisibleTabs();
  const orderable = tabs.filter((t) => t.id !== 'settings');

  const prefsQ = useQuery({ queryKey: ['toolbarPrefs'], queryFn: api.toolbarPrefs.get });
  const order = prefsQ.data?.order ?? DEFAULT_ORDER;
  const ordered = applyOrder(orderable, order);

  const listRef = useRef<HTMLUListElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const dragFrom = useRef<number | null>(null);

  const save = useMutation({
    mutationFn: (nextOrder: string[]) => api.toolbarPrefs.save(nextOrder),
    onMutate: async (nextOrder) => {
      await qc.cancelQueries({ queryKey: ['toolbarPrefs'] });
      const prev = qc.getQueryData<ToolbarPrefs>(['toolbarPrefs']);
      qc.setQueryData<ToolbarPrefs>(['toolbarPrefs'], { order: nextOrder });
      return { prev };
    },
    onError: (e, _order, ctx) => {
      if (ctx?.prev) qc.setQueryData(['toolbarPrefs'], ctx.prev);
      toast(String((e as Error).message), 'err');
    },
    onSuccess: (data) => qc.setQueryData(['toolbarPrefs'], data),
  });

  function reorder(from: number, to: number) {
    if (from === to) return;
    const next = ordered.map((t) => t.id) as string[];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    save.mutate(next);
  }

  function move(id: string, delta: 1 | -1) {
    const from = ordered.findIndex((t) => t.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    reorder(from, to);
  }

  /** Which row index the pointer is currently over, by comparing Y against
   * each row's own midpoint — works for a pointer captured well outside the
   * list bounds too (a fast drag off the top/bottom clamps to the first/last row). */
  function indexAtY(y: number): number {
    const rows = Array.from(listRef.current?.children ?? []) as HTMLElement[];
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i]!.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return i;
    }
    return rows.length - 1;
  }

  function onHandlePointerDown(e: ReactPointerEvent<HTMLSpanElement>, id: string, index: number) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragFrom.current = index;
    setDragId(id);
    setOverIndex(index);
  }
  function onHandlePointerMove(e: ReactPointerEvent<HTMLSpanElement>) {
    if (dragFrom.current === null) return;
    setOverIndex(indexAtY(e.clientY));
  }
  function endDrag() {
    const from = dragFrom.current;
    dragFrom.current = null;
    setDragId(null);
    if (from !== null && overIndex !== null) reorder(from, overIndex);
    setOverIndex(null);
  }

  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div>
        <h3 className="text-sm font-semibold text-gray-700">Toolbar order</h3>
        <p className="text-xs text-gray-500">
          Drag the ⠿ handle to reorder, or use the arrows. The first few tabs show in the main bar
          — fewer on narrow screens — the rest live under “More”, in this same order.
        </p>
      </div>
      <ul ref={listRef} className="divide-y divide-gray-100">
        {ordered.map((t: Tab, i) => (
          <li
            key={t.id}
            className={`flex items-center gap-2 py-2 select-none ${dragId === t.id ? 'opacity-40' : ''} ${
              overIndex === i && dragId && dragId !== t.id ? 'border-t-2 border-wa' : ''
            }`}
          >
            <span
              onPointerDown={(e) => onHandlePointerDown(e, t.id, i)}
              onPointerMove={onHandlePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              aria-hidden="true"
              className="flex h-6 w-6 shrink-0 cursor-grab items-center justify-center text-gray-300 select-none touch-none pointer-coarse:h-9 pointer-coarse:w-9"
            >
              ⠿
            </span>
            <svg className="h-4 w-4 shrink-0 text-gray-500" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d={t.icon} />
            </svg>
            <span className="flex-1 text-sm text-gray-700">{t.label}</span>
            <button
              onClick={() => move(t.id, -1)}
              disabled={i === 0 || save.isPending}
              aria-label={`Move ${t.label} up`}
              className="rounded-md px-1.5 py-0.5 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
            >
              ↑
            </button>
            <button
              onClick={() => move(t.id, 1)}
              disabled={i === ordered.length - 1 || save.isPending}
              aria-label={`Move ${t.label} down`}
              className="rounded-md px-1.5 py-0.5 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
            >
              ↓
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
