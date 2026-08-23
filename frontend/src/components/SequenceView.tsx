import { useState } from 'react';
import { recipientLabel, recipientName } from '../lib/useRecipientNames';
import type { JobItem, Recipient } from '../types';

const SHOW_RECIPIENTS = 12;

/** Preview source for stored media: a URL as-is, raw base64 as a data URL. */
function mediaSrc(d: Record<string, any>): string | null {
  if (typeof d.url === 'string' && d.url) return d.url;
  if (typeof d.base64 === 'string' && d.base64)
    return `data:${d.mimetype || 'application/octet-stream'};base64,${d.base64}`;
  return null;
}

function ItemBubble({ item }: { item: JobItem }) {
  const d = item.data as Record<string, any>;
  switch (item.type) {
    case 'text':
      return (
        <p className="text-sm whitespace-pre-wrap" dir="auto">
          {d.text}
        </p>
      );
    case 'media': {
      const src = mediaSrc(d);
      return (
        <div className="space-y-1.5">
          {d.mediatype === 'image' && src ? (
            <img src={src} alt={d.filename ?? 'image'} className="max-h-48 rounded-md object-contain" />
          ) : d.mediatype === 'video' && src ? (
            <video src={src} controls className="max-h-48 rounded-md" />
          ) : (
            <div className="text-sm text-gray-600">
              {d.mediatype === 'video' ? '🎞' : d.mediatype === 'audio' ? '🎵' : '📄'}{' '}
              {d.filename ?? d.url ?? d.mediatype ?? 'media'}
            </div>
          )}
          {d.caption && (
            <p className="text-sm whitespace-pre-wrap" dir="auto">
              {d.caption}
            </p>
          )}
        </div>
      );
    }
    case 'voice':
      return (
        <div className="text-sm text-gray-600">
          🎤 Voice message
          {d.filename ? ` — ${d.filename}` : d.url ? ` — ${d.url}` : ''}
        </div>
      );
    case 'poll':
      return (
        <div className="space-y-1">
          <p className="text-sm font-medium" dir="auto">
            📊 {d.question}
          </p>
          {((d.options ?? []) as string[]).map((o, i) => (
            <div key={i} className="flex items-center gap-1.5 text-sm text-gray-700" dir="auto">
              <span className="text-gray-400">{(d.selectable ?? 1) === 1 ? '◯' : '▢'}</span>
              {o}
            </div>
          ))}
        </div>
      );
    case 'buttons':
      return (
        <div className="space-y-1.5">
          <p className="text-sm font-medium" dir="auto">
            {d.title}
          </p>
          {d.description && (
            <p className="text-sm text-gray-600" dir="auto">
              {d.description}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {((d.buttons ?? []) as Array<{ id: string; label: string }>).map((b) => (
              <span key={b.id} className="rounded-full border border-wa px-3 py-0.5 text-xs font-medium text-wa-dark">
                {b.label}
              </span>
            ))}
          </div>
        </div>
      );
    default:
      // unknown item types (e.g. 'status') still get a readable fallback
      return (
        <div className="text-sm text-gray-600" dir="auto">
          ({item.type}) {String(d.text ?? d.caption ?? '')}
        </div>
      );
  }
}

/** What a job sends, rendered like the messages it becomes — plus recipients. */
export default function SequenceView({
  items,
  recipients,
  names = new Map(),
}: {
  items: JobItem[];
  recipients: Recipient[];
  names?: Map<string, string>;
}) {
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  // search wins over the collapsed view: typing always scans ALL recipients
  const matches = query
    ? recipients.filter((r) =>
        `${recipientLabel(r.id, names)} ${r.id}`.toLowerCase().includes(query),
      )
    : recipients;
  const shown = query || showAll ? matches : matches.slice(0, SHOW_RECIPIENTS);
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <p className="text-xs font-semibold text-gray-500">
            To {recipients.length} recipient{recipients.length === 1 ? '' : 's'}
            {query && ` — ${matches.length} match${matches.length === 1 ? '' : 'es'}`}
          </p>
          {recipients.length > SHOW_RECIPIENTS && (
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find name or number…"
              dir="auto"
              className="rounded-md border border-gray-300 px-2 py-0.5 text-xs"
            />
          )}
        </div>
        {/* big blasts scroll inside a capped box instead of flooding the page */}
        <div className={`flex flex-wrap gap-1 ${showAll || query ? 'max-h-40 overflow-y-auto' : ''}`}>
          {shown.map((r) => (
            <span key={r.id} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600" dir="auto">
              {r.isGroup ? '👥 ' : ''}
              {recipientLabel(r.id, names)}
              {/* a named person keeps the number visible, muted */}
              {!r.isGroup && recipientName(r.id, names) && (
                <span className="ml-1 font-mono text-[10px] text-gray-400">{r.id.split('@')[0]}</span>
              )}
            </span>
          ))}
          {!query && recipients.length > SHOW_RECIPIENTS && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-300"
            >
              {showAll ? 'show less' : `+${recipients.length - SHOW_RECIPIENTS} more`}
            </button>
          )}
        </div>
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold text-gray-500">
          Message sequence ({items.length})
        </p>
        <div className="space-y-2">
          {items.map((item, i) => (
            <div
              key={i}
              className="max-w-md rounded-lg rounded-tl-none border border-green-100 bg-green-50 px-3 py-2 shadow-sm"
            >
              {items.length > 1 && (
                <p className="mb-1 text-[10px] font-semibold tracking-wide text-gray-400 uppercase">
                  #{i + 1} · {item.type}
                </p>
              )}
              <ItemBubble item={item} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
