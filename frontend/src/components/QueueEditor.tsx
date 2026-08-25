import { useEffect, useRef, useState } from 'react';
import { fileToBase64 } from '../lib/voice';
import type { JobItem } from '../types';

export const QUEUE_TYPES = [
  { id: 'text', label: '💬 Text' },
  { id: 'media', label: '🖼 Media' },
  { id: 'voice', label: '🎤 Voice' },
  { id: 'poll', label: '📊 Poll' },
  { id: 'buttons', label: '⬜ Buttons' },
] as const;

const EMPTY_DATA: Record<string, () => Record<string, unknown>> = {
  text: () => ({ text: '' }),
  media: () => ({}),
  voice: () => ({ encoding: true }),
  poll: () => ({ question: '', options: ['', ''], selectable: 1 }),
  buttons: () => ({ title: '', buttons: [{ id: 'btn_1', label: '' }] }),
};

/** Validate one queue item; returns an error string or null when sendable. */
export function validateItem(item: JobItem): string | null {
  const d = item.data as Record<string, any>;
  switch (item.type) {
    case 'text':
      return d.text?.trim() ? null : 'Text is empty';
    case 'media':
      if (!d.base64 && !d.url) return 'Media: choose a file or enter a URL';
      if (!d.mimetype) return 'Media: MIME type missing';
      return null;
    case 'voice':
      return d.base64 || d.url ? null : 'Voice: choose a file or enter a URL';
    case 'poll': {
      if (!d.question?.trim()) return 'Poll: question required';
      const opts = (d.options ?? []).filter((o: string) => o.trim());
      return opts.length >= 2 ? null : 'Poll: at least 2 options';
    }
    case 'buttons': {
      if (!d.title?.trim()) return 'Buttons: title required';
      const btns = (d.buttons ?? []).filter((b: { label: string }) => b.label.trim());
      return btns.length ? null : 'Buttons: add at least one button';
    }
    default:
      return null;
  }
}

/** Strip empty poll options / button rows before sending. */
export function finalizeItems(items: JobItem[]): JobItem[] {
  return items.map((item) => {
    const d = { ...(item.data as Record<string, any>) };
    delete d._k; // editor-only list identity — never goes on the wire
    if (item.type === 'poll') {
      d.options = (d.options ?? []).filter((o: string) => o.trim());
      // WhatsApp's selectable-count is only ever 1 (single answer) or 0
      // (multiple answers). Anything else makes votes undecryptable on the
      // WhatsApp app too, so normalise non-single to 0 (also repairs legacy
      // items that stored the option count for "multiple answers").
      d.selectable = d.selectable === 1 ? 1 : 0;
    }
    if (item.type === 'buttons')
      d.buttons = (d.buttons ?? []).filter((b: { label: string }) => b.label.trim());
    return { type: item.type, data: d };
  });
}

const URL_MEDIA: Record<string, { mimetype: string; mediatype: string }> = {
  jpg: { mimetype: 'image/jpeg', mediatype: 'image' },
  jpeg: { mimetype: 'image/jpeg', mediatype: 'image' },
  png: { mimetype: 'image/png', mediatype: 'image' },
  gif: { mimetype: 'image/gif', mediatype: 'image' },
  webp: { mimetype: 'image/webp', mediatype: 'image' },
  mp4: { mimetype: 'video/mp4', mediatype: 'video' },
  mov: { mimetype: 'video/quicktime', mediatype: 'video' },
  webm: { mimetype: 'video/webm', mediatype: 'video' },
  mp3: { mimetype: 'audio/mpeg', mediatype: 'audio' },
  ogg: { mimetype: 'audio/ogg', mediatype: 'audio' },
  m4a: { mimetype: 'audio/mp4', mediatype: 'audio' },
  pdf: { mimetype: 'application/pdf', mediatype: 'document' },
  doc: { mimetype: 'application/msword', mediatype: 'document' },
  docx: {
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    mediatype: 'document',
  },
};

function mediaFromUrl(url: string): { mimetype: string; mediatype: string } {
  const ext = (url.split('?')[0] ?? '').split('.').pop()?.toLowerCase() ?? '';
  return URL_MEDIA[ext] ?? { mimetype: 'image/jpeg', mediatype: 'image' };
}

interface ItemEditorProps {
  item: JobItem;
  onChange: (data: Record<string, unknown>) => void;
}

function FilePicker({
  accept,
  onPicked,
  current,
}: {
  accept: string;
  onPicked: (base64: string, file: File) => void;
  current: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="file"
        accept={accept}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) onPicked(await fileToBase64(f), f);
        }}
        className="block w-full text-xs text-gray-500 file:mr-2 file:rounded-md file:border-0 file:bg-gray-100 file:px-2 file:py-1 file:text-xs"
      />
      {current && <span className="shrink-0 text-xs text-wa-dark">✓ {current}</span>}
    </div>
  );
}

/**
 * One name source's three slices as insert buttons. The label carries the
 * source so the tags themselves can stay bare — six `{{…}}` chips in a row
 * read as noise without it. Each inserts with the `|` pre-typed, ready for a
 * fallback (an empty one resolves to nothing, same as omitting it).
 */
function TagRow({
  label,
  hint,
  tags,
  onInsert,
}: {
  label: string;
  hint: string;
  tags: readonly string[];
  onInsert: (tag: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span title={hint} className="text-gray-500">
        {label}:
      </span>
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          onClick={() => onInsert(tag)}
          title={`${hint} — inserts {{${tag}}}`}
          className="rounded border border-gray-200 px-1.5 py-0.5 font-mono hover:border-wa hover:text-wa-dark"
        >
          + {`{{${tag}}}`}
        </button>
      ))}
    </div>
  );
}

function ItemEditor({ item, onChange }: ItemEditorProps) {
  const d = item.data as Record<string, any>;
  const set = (patch: Record<string, unknown>) => onChange({ ...d, ...patch });

  switch (item.type) {
    case 'text':
      return (
        <div>
          <textarea
            value={d.text ?? ''}
            onChange={(e) => set({ text: e.target.value })}
            rows={3}
            dir="auto"
            placeholder="Message text…"
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
          <div className="mt-1 space-y-1 text-[11px] text-gray-400">
            <TagRow
              label="Your name for them"
              hint="The name you supplied in the recipients table / saved list"
              tags={['first_name', 'last_name', 'full_name']}
              onInsert={(tag) => set({ text: `${d.text ?? ''}{{${tag}|}}` })}
            />
            <TagRow
              label="Their WhatsApp name"
              hint="The recipient's WhatsApp profile name, fetched automatically when the job runs"
              tags={['wa_first_name', 'wa_last_name', 'wa_full_name']}
              onInsert={(tag) => set({ text: `${d.text ?? ''}{{${tag}|}}` })}
            />
            <p>
              "דנה כהן" sends as <span className="font-mono text-gray-500">דנה</span> /{' '}
              <span className="font-mono text-gray-500">כהן</span> /{' '}
              <span className="font-mono text-gray-500">דנה כהן</span>. The stored name keeps its
              full form — only the message is sliced.
            </p>
            <p>
              The <span className="font-mono text-gray-500">|</span> is where an optional fallback
              goes, used when that recipient has no name —{' '}
              <span className="font-mono text-gray-500">{'{{first_name|friend}}'}</span> sends
              "friend" instead. Leave it empty (or delete the{' '}
              <span className="font-mono text-gray-500">|</span>) and nothing is sent in its place.
            </p>
          </div>
        </div>
      );
    case 'media':
      return (
        <div className="space-y-2">
          <FilePicker
            accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx"
            current={d.filename ?? ''}
            onPicked={(base64, f) =>
              set({
                base64,
                url: undefined,
                mimetype: f.type || 'application/octet-stream',
                filename: f.name,
                mediatype: f.type.startsWith('video/')
                  ? 'video'
                  : f.type.startsWith('audio/')
                    ? 'audio'
                    : f.type.startsWith('image/')
                      ? 'image'
                      : 'document',
              })
            }
          />
          <input
            value={d.url ?? ''}
            onChange={(e) =>
              // a URL replaces any picked file — derive type info from the
              // URL itself, never keep the previous file's mime/mediatype
              set({ url: e.target.value, base64: undefined, filename: undefined, ...mediaFromUrl(e.target.value) })
            }
            placeholder="…or media URL"
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
          <textarea
            value={d.caption ?? ''}
            onChange={(e) => set({ caption: e.target.value })}
            rows={2}
            placeholder="Caption (optional)"
            dir="auto"
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
      );
    case 'voice':
      return (
        <div className="space-y-2">
          <FilePicker
            accept="audio/*"
            current={d.filename ?? (d.base64 ? 'audio ready' : '')}
            onPicked={(base64, f) => set({ base64, url: undefined, filename: f.name })}
          />
          <input
            value={d.url ?? ''}
            onChange={(e) => set({ url: e.target.value, base64: undefined })}
            placeholder="…or audio URL"
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={d.encoding !== false}
              onChange={(e) => set({ encoding: e.target.checked })}
              className="h-3.5 w-3.5 accent-(--color-wa)"
            />
            Auto-encode to WhatsApp voice format
          </label>
        </div>
      );
    case 'poll': {
      const options: string[] = d.options ?? ['', ''];
      return (
        <div className="space-y-2">
          <input
            value={d.question ?? ''}
            onChange={(e) => set({ question: e.target.value })}
            placeholder="Poll question"
            dir="auto"
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
          {options.map((opt, i) => (
            <div key={i} className="flex gap-1">
              <input
                value={opt}
                onChange={(e) =>
                  set({ options: options.map((o, j) => (j === i ? e.target.value : o)) })
                }
                placeholder={`Option ${i + 1}`}
                dir="auto"
                className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm"
              />
              {options.length > 2 && (
                <button
                  type="button"
                  onClick={() => set({ options: options.filter((_, j) => j !== i) })}
                  className="px-1 text-gray-400 hover:text-red-500"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => set({ options: [...options, ''] })}
              className="text-xs font-medium text-wa-dark hover:underline"
            >
              + Add option
            </button>
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={(d.selectable ?? 1) !== 1}
                onChange={(e) => set({ selectable: e.target.checked ? 0 : 1 })}
                className="h-3.5 w-3.5 accent-(--color-wa)"
              />
              multiple answers
            </label>
          </div>
        </div>
      );
    }
    case 'buttons': {
      const buttons: Array<{ id: string; label: string }> = d.buttons ?? [];
      return (
        <div className="space-y-2">
          <input
            value={d.title ?? ''}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Title"
            dir="auto"
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
          <input
            value={d.description ?? ''}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="Description (optional)"
            dir="auto"
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
          {buttons.map((b, i) => (
            <div key={i} className="flex gap-1">
              <input
                value={b.label}
                onChange={(e) =>
                  set({
                    buttons: buttons.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                  })
                }
                placeholder={`Button ${i + 1} label`}
                dir="auto"
                className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm"
              />
              {buttons.length > 1 && (
                <button
                  type="button"
                  onClick={() => set({ buttons: buttons.filter((_, j) => j !== i) })}
                  className="px-1 text-gray-400 hover:text-red-500"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              set({ buttons: [...buttons, { id: `btn_${buttons.length + 1}`, label: '' }] })
            }
            className="text-xs font-medium text-wa-dark hover:underline"
          >
            + Add button
          </button>
        </div>
      );
    }
    default:
      return null;
  }
}

export interface QueueEditorProps {
  items: JobItem[];
  onChange: (items: JobItem[]) => void;
}

/** v1-style "Message Sequence": an ordered multi-item queue of mixed types. */
export default function QueueEditor({ items, onChange }: QueueEditorProps) {
  const [, setBump] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  /** insertion slot 0..items.length while dragging, null otherwise */
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  // v1 quirk worth keeping: only a grab that started on the ⠿ handle may drag,
  // so text selection inside the editors keeps working.
  const dragFromHandle = useRef(false);

  // An abandoned grab (mousedown on the handle, release elsewhere) must not
  // leave the flag armed — any mouseup clears it. During a real drag the
  // browser suppresses mouseup until after dragstart has already consumed it.
  useEffect(() => {
    const reset = () => {
      dragFromHandle.current = false;
    };
    window.addEventListener('mouseup', reset);
    return () => window.removeEventListener('mouseup', reset);
  }, []);

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
    setBump((b) => b + 1);
  }

  function endDrag() {
    setDragIndex(null);
    setDropSlot(null);
    dragFromHandle.current = false;
  }

  function drop() {
    if (dragIndex == null || dropSlot == null) return endDrag();
    let to = dropSlot;
    if (to !== dragIndex && to !== dragIndex + 1) {
      const next = [...items];
      const [moved] = next.splice(dragIndex, 1);
      if (to > dragIndex) to--;
      next.splice(to, 0, moved!);
      onChange(next);
    }
    endDrag();
  }

  return (
    <div className="space-y-3">
      {items.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-gray-200 py-6 text-center text-sm text-gray-400">
          No messages yet — add one below
        </div>
      )}
      {items.map((item, i) => {
        const error = validateItem(item);
        return (
          <div
            key={String((item.data as Record<string, unknown>)._k ?? i)}
            draggable
            onDragStart={(e) => {
              if (!dragFromHandle.current) {
                e.preventDefault();
                return;
              }
              e.dataTransfer.effectAllowed = 'move';
              setDragIndex(i);
            }}
            onDragOver={(e) => {
              if (dragIndex == null) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setDropSlot(e.clientY < r.top + r.height / 2 ? i : i + 1);
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop();
            }}
            onDragEnd={endDrag}
            className={`rounded-lg border bg-white p-3 shadow-sm ${
              dragIndex === i ? 'border-wa opacity-40' : 'border-gray-200'
            } ${
              dropSlot === i && dragIndex != null
                ? 'border-t-2 border-t-wa'
                : dropSlot === i + 1 && dragIndex != null
                  ? 'border-b-2 border-b-wa'
                  : ''
            }`}
          >
            <div className="mb-2 flex items-center gap-2">
              <span
                title="Drag to reorder"
                onMouseDown={() => (dragFromHandle.current = true)}
                className="cursor-grab select-none text-gray-300 hover:text-gray-500 active:cursor-grabbing"
              >
                ⠿
              </span>
              <span className="text-xs font-semibold text-gray-500">
                #{i + 1} · {QUEUE_TYPES.find((t) => t.id === item.type)?.label ?? item.type}
              </span>
              {error && <span className="text-xs text-amber-600">{error}</span>}
              <div className="ml-auto flex gap-1 text-xs">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="rounded px-1.5 py-0.5 text-gray-400 hover:bg-gray-100 disabled:opacity-30">↑</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1} className="rounded px-1.5 py-0.5 text-gray-400 hover:bg-gray-100 disabled:opacity-30">↓</button>
                <button
                  type="button"
                  onClick={() => onChange(items.filter((_, j) => j !== i))}
                  className="rounded px-1.5 py-0.5 text-red-400 hover:bg-red-50"
                >
                  ✕
                </button>
              </div>
            </div>
            <ItemEditor
              item={item}
              onChange={(data) => onChange(items.map((x, j) => (j === i ? { ...x, data } : x)))}
            />
          </div>
        );
      })}
      <div>
        <p className="mb-1.5 text-xs font-medium text-gray-500">Add to sequence:</p>
        <div className="flex flex-wrap gap-2">
          {QUEUE_TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() =>
                // _k: stable identity for the list key — index keys desync the
                // uncontrolled file inputs on drag-reorder/delete
                onChange([...items, { type: t.id, data: { ...EMPTY_DATA[t.id]!(), _k: crypto.randomUUID() } }])
              }
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:border-wa hover:bg-green-50 hover:text-wa-dark"
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
