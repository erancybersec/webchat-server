import { useEffect, useRef, useState } from 'react';
import { fileToBase64 } from '../../lib/voice';
import type { QuickReplyMedia, QuickReplyMediaInput } from '../../types';

export interface QuickReplyDraft {
  shortcut: string;
  text: string;
  personal: boolean;
  /** undefined = leave media as-is, null = clear it, value = set/replace it. */
  media?: QuickReplyMediaInput | null;
}

export interface QuickReplyFormProps {
  mode: 'add' | 'edit';
  initial?: { shortcut?: string; text?: string; personal?: boolean; media?: QuickReplyMedia | null };
  /** Offer the personal toggle (identity present); only meaningful when adding. */
  canPersonal: boolean;
  /** True when `shortcut` already exists in the relevant scope (clash). */
  isTaken: (shortcut: string) => boolean;
  onSubmit: (draft: QuickReplyDraft) => void;
  onCancel: () => void;
}

type Mediatype = QuickReplyMedia['mediatype'];

// Working media in the form: the existing descriptor (no bytes, edit mode), a
// freshly uploaded file (carries base64), or a hosted URL.
type Working =
  | { kind: 'existing'; d: QuickReplyMedia }
  | { kind: 'file'; mediatype: Mediatype; mimetype: string; filename: string; base64: string; previewUrl: string }
  | { kind: 'url'; mediatype: Mediatype; mimetype: string; filename?: string; url: string };

const URL_MEDIA: Record<string, { mimetype: string; mediatype: Mediatype }> = {
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
};

function mediaFromUrl(url: string): { mimetype: string; mediatype: Mediatype } {
  const ext = (url.split('?')[0] ?? '').split('.').pop()?.toLowerCase() ?? '';
  return URL_MEDIA[ext] ?? { mimetype: 'image/jpeg', mediatype: 'image' };
}

function mediatypeOfFile(f: File): Mediatype {
  if (f.type.startsWith('image/')) return 'image';
  if (f.type.startsWith('video/')) return 'video';
  if (f.type.startsWith('audio/')) return 'audio';
  return 'document';
}

const ICON: Record<Mediatype, string> = { image: '🖼', video: '🎬', audio: '🎵', document: '📄' };

/** Label + (for displayable kinds) a preview URL for the working media. */
function mediaView(w: Working): { mediatype: Mediatype; label: string; previewUrl?: string } {
  if (w.kind === 'existing')
    return { mediatype: w.d.mediatype, label: w.d.filename || w.d.mediatype, previewUrl: w.d.url };
  if (w.kind === 'file')
    return { mediatype: w.mediatype, label: w.filename, previewUrl: w.mediatype === 'image' ? w.previewUrl : undefined };
  return { mediatype: w.mediatype, label: w.filename || w.url, previewUrl: w.mediatype === 'image' ? w.url : undefined };
}

/**
 * The add/edit form for a quick reply — validation lives here so the composer
 * modal and the dedicated manage page stay in lockstep. A reply may carry one
 * media attachment (uploaded file or hosted URL), sent with the text as caption.
 */
export default function QuickReplyForm({
  mode,
  initial,
  canPersonal,
  isTaken,
  onSubmit,
  onCancel,
}: QuickReplyFormProps) {
  const [shortcut, setShortcut] = useState(initial?.shortcut ?? '');
  const [text, setText] = useState(initial?.text ?? '');
  const [personal, setPersonal] = useState(!!initial?.personal);
  const [media, setMedia] = useState<Working | null>(initial?.media ? { kind: 'existing', d: initial.media } : null);
  const [mediaTouched, setMediaTouched] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [error, setError] = useState('');
  const shortcutRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    shortcutRef.current?.focus();
  }, []);

  async function pickFile(f: File) {
    setError('');
    try {
      const base64 = await fileToBase64(f);
      setMedia({
        kind: 'file',
        mediatype: mediatypeOfFile(f),
        mimetype: f.type || 'application/octet-stream',
        filename: f.name,
        base64,
        previewUrl: `data:${f.type || 'application/octet-stream'};base64,${base64}`,
      });
      setMediaTouched(true);
    } catch {
      setError('Could not read that file.');
    }
  }

  function applyUrl(raw: string) {
    const url = raw.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return setError('Media URL must start with http(s)://');
    const { mimetype, mediatype } = mediaFromUrl(url);
    const filename = (url.split('?')[0] ?? '').split('/').pop() || undefined;
    setMedia({ kind: 'url', mediatype, mimetype, filename, url });
    setMediaTouched(true);
    setUrlDraft('');
    setError('');
  }

  function clearMedia() {
    setMedia(null);
    setMediaTouched(true);
  }

  /** Map working media to the create/update payload (undefined = leave as-is). */
  function emitMedia(): QuickReplyMediaInput | null | undefined {
    if (!mediaTouched) return undefined;
    if (!media) return null;
    if (media.kind === 'file')
      return { kind: 'file', mediatype: media.mediatype, mimetype: media.mimetype, filename: media.filename, base64: media.base64 };
    if (media.kind === 'url')
      return { kind: 'url', mediatype: media.mediatype, mimetype: media.mimetype, filename: media.filename, url: media.url };
    return undefined;
  }

  function submit() {
    const s = shortcut.trim().replace(/^\/+/, '');
    const t = text.trim();
    if (!s) return setError('Shortcut is required.');
    if (/\s/.test(s)) return setError('Shortcut cannot contain spaces.');
    if (!t && !media) return setError('Add reply text or media.');
    if (isTaken(s)) return setError(`“/${s}” is already taken.`);
    onSubmit({ shortcut: s, text: t, personal: personal && canPersonal, media: emitMedia() });
  }

  const view = media ? mediaView(media) : null;

  return (
    <form
      className="space-y-2 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="block text-xs font-medium text-gray-500">
        Shortcut
        <div className="mt-1 flex items-center rounded-md border border-gray-300 focus-within:border-wa">
          <span className="pl-3 font-mono text-sm text-gray-400">/</span>
          <input
            ref={shortcutRef}
            value={shortcut}
            onChange={(e) => setShortcut(e.target.value)}
            placeholder="thanks"
            className="w-full rounded-md px-1 py-2 font-mono text-sm outline-none"
          />
        </div>
      </label>
      <label className="block text-xs font-medium text-gray-500">
        {media ? 'Caption' : 'Reply text'}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={media ? 'Optional caption…' : "Thanks for reaching out! We'll get back to you shortly."}
          dir="auto"
          rows={media ? 2 : 4}
          className="mt-1 w-full resize-y rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-wa focus:outline-none"
        />
      </label>

      {/* Media: a preview chip when set, otherwise upload / URL inputs. */}
      <div className="text-xs font-medium text-gray-500">
        Media
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pickFile(f);
            e.target.value = '';
          }}
        />
        {view ? (
          <div className="mt-1 flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5">
            {view.previewUrl ? (
              <img src={view.previewUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
            ) : (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-white text-lg">
                {ICON[view.mediatype]}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate font-sans text-xs text-gray-600" dir="auto" title={view.label}>
              {view.label}
              <span className="ml-1 text-gray-400">· {view.mediatype}</span>
            </span>
            <button
              type="button"
              onClick={clearMedia}
              className="shrink-0 rounded px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50"
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="shrink-0 rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              Upload file
            </button>
            <input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={(e) => applyUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyUrl(urlDraft);
                }
              }}
              placeholder="…or paste a media URL"
              className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 font-sans text-xs outline-none focus:border-wa"
            />
          </div>
        )}
      </div>

      {canPersonal && mode === 'add' && (
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={personal}
            onChange={(e) => setPersonal(e.target.checked)}
            className="h-3.5 w-3.5 accent-wa"
          />
          Personal — only I see this reply
        </label>
      )}
      {error && <div className="text-xs text-red-600">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-md bg-wa px-4 py-1.5 text-sm font-medium text-white hover:bg-wa-dark"
        >
          {mode === 'edit' ? 'Save' : 'Add'}
        </button>
      </div>
    </form>
  );
}
