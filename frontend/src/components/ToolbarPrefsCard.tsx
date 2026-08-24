import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type ToolbarPrefs } from '../lib/api';
import { applyOrder, DEFAULT_ORDER, useVisibleTabs, type Tab } from '../lib/tabs';
import { useToast } from './Toast';

/**
 * Per-person nav tab order. Self-contained like NotificationPrefsCard, and
 * mounted the same way — on the everyone-visible Profile tab, since this is a
 * personal/cosmetic preference, not an admin control. The order decides both
 * which tabs sit in the main bar (the first few — fewer on narrow screens,
 * see lib/tabs#useToolbarSlotCount) and the sequence of the "More" menu.
 */
export function ToolbarPrefsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const { tabs } = useVisibleTabs();
  const orderable = tabs.filter((t) => t.id !== 'settings');

  const prefsQ = useQuery({ queryKey: ['toolbarPrefs'], queryFn: api.toolbarPrefs.get });
  const order = prefsQ.data?.order ?? DEFAULT_ORDER;
  const ordered = applyOrder(orderable, order);

  const [dragId, setDragId] = useState<string | null>(null);

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

  function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      return;
    }
    const from = ordered.findIndex((t) => t.id === dragId);
    const to = ordered.findIndex((t) => t.id === targetId);
    setDragId(null);
    if (from >= 0 && to >= 0) reorder(from, to);
  }

  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div>
        <h3 className="text-sm font-semibold text-gray-700">Toolbar order</h3>
        <p className="text-xs text-gray-500">
          Drag to reorder, or use the arrows. The first few tabs show in the main bar — fewer on
          narrow screens — the rest live under “More”, in this same order.
        </p>
      </div>
      <ul className="divide-y divide-gray-100">
        {ordered.map((t: Tab, i) => (
          <li
            key={t.id}
            draggable
            onDragStart={() => setDragId(t.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(t.id)}
            onDragEnd={() => setDragId(null)}
            className={`flex items-center gap-2 py-2 ${dragId === t.id ? 'opacity-40' : ''}`}
          >
            <span className="cursor-grab select-none text-gray-300" aria-hidden="true">
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
