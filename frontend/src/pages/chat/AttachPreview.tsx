import { useEffect, useMemo, useState } from 'react';

export interface AttachPreviewProps {
  /** A device file picked in the composer… */
  file?: File;
  /** …or media already resolved (e.g. a quick reply): name + mime + a ready URL. */
  media?: { name: string; mime: string; previewUrl: string };
  /** Prefill the caption (quick replies carry their text as the caption). */
  initialCaption?: string;
  sending: boolean;
  onCancel: () => void;
  /** caption is empty for audio (v1: audio goes out as a voice note, no caption) */
  onSend: (caption: string) => void;
}

/** v1-style full-screen attachment preview with a caption input. */
export default function AttachPreview({ file, media, initialCaption, sending, onCancel, onSend }: AttachPreviewProps) {
  const [caption, setCaption] = useState(initialCaption ?? '');
  const name = file?.name ?? media?.name ?? 'file';
  const mime = file?.type ?? media?.mime ?? '';
  // A device file needs an object URL (revoked on unmount); resolved media
  // already has a usable URL (data: or remote) owned by the caller.
  const url = useMemo(() => (file ? URL.createObjectURL(file) : (media?.previewUrl ?? '')), [file, media]);
  useEffect(() => () => { if (file) URL.revokeObjectURL(url); }, [url, file]);

  const kind = mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('audio/')
        ? 'audio'
        : 'file';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Attachment preview"
      className="fixed inset-0 z-50 flex flex-col bg-[#0b141a]/95"
    >
      <div className="flex items-center gap-3 px-4 py-3 text-white">
        <button
          onClick={onCancel}
          aria-label="Cancel attachment"
          className="rounded px-2 py-1 text-xl text-white/70 hover:bg-white/10"
        >
          ✕
        </button>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="text-xs text-white/50">
            {mime || 'file'}
            {file ? ` · ${(file.size / 1024).toFixed(0)} KB` : ''}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {kind === 'image' && <img src={url} alt="" className="max-h-full max-w-full object-contain" />}
        {kind === 'video' && <video src={url} controls className="max-h-full max-w-full" />}
        {kind === 'audio' && (
          <div className="flex flex-col items-center gap-4 text-white">
            <span className="text-5xl">🎵</span>
            <audio src={url} controls />
            <span className="text-xs text-white/50">Sends as a WhatsApp voice message</span>
          </div>
        )}
        {kind === 'file' && (
          <div className="flex flex-col items-center gap-3 text-white">
            <span className="text-6xl">📄</span>
            <span className="max-w-xs truncate text-sm">{name}</span>
          </div>
        )}
      </div>

      <form
        className="flex items-center gap-2 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSend(kind === 'audio' ? '' : caption.trim());
        }}
      >
        {kind !== 'audio' && (
          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Add a caption…"
            dir="auto"
            autoFocus
            className="min-w-0 flex-1 rounded-full bg-[#2a3942] px-4 py-2.5 text-sm text-white placeholder-gray-400 outline-none"
          />
        )}
        <button
          type="submit"
          disabled={sending}
          className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-wa text-lg text-white hover:bg-wa-dark disabled:opacity-50"
          title="Send"
        >
          {sending ? '…' : '➤'}
        </button>
      </form>
    </div>
  );
}
