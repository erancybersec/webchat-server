import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from './Toast';

const STATE_POLL_MS = 2_500;
const QR_REFRESH_MS = 25_000; // WhatsApp QR codes expire well before this

/** data:image/... already, or a bare base64 payload Evolution sent unwrapped. */
function qrSrc(base64: string): string {
  return base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
}

/**
 * Reconnect flow for a disconnected WhatsApp line: fetch a QR from Evolution,
 * show it, and poll the live connection state until the phone links it.
 */
export default function ConnectLineModal({ name, onClose }: { name: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [qr, setQr] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const closedRef = useRef(false);

  async function fetchQr() {
    try {
      const r = await api.instances.qr(name);
      if (closedRef.current) return;
      setError('');
      if (r.connected) {
        setConnected(true);
        return;
      }
      setQr(r.base64);
      setPairingCode(r.pairingCode);
    } catch (e) {
      if (!closedRef.current) setError((e as Error).message || 'Failed to load QR code');
    }
  }

  useEffect(() => {
    closedRef.current = false;
    fetchQr();
    const qrTimer = setInterval(fetchQr, QR_REFRESH_MS);
    const stateTimer = setInterval(async () => {
      try {
        const r = await api.instances.state(name);
        if (closedRef.current) return;
        if (r.state === 'open') {
          setConnected(true);
          qc.invalidateQueries({ queryKey: ['instances'] });
          toast(`“${name}” is connected`, 'ok');
        }
      } catch {
        /* transient — the next tick retries */
      }
    }, STATE_POLL_MS);
    return () => {
      closedRef.current = true;
      clearInterval(qrTimer);
      clearInterval(stateTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    if (!connected) return;
    const t = setTimeout(onClose, 1_500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Reconnect ${name}`}
        className="animate-pop flex w-full max-w-sm flex-col rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h3 className="truncate font-semibold text-gray-800" dir="auto">
            Reconnect “{name}”
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded px-2 py-0.5 text-gray-400 hover:bg-gray-100"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col items-center gap-3 p-5">
          {connected ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-wa/10 text-wa-dark">
                <svg className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </span>
              <p className="text-sm font-medium text-gray-700">Connected</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <p className="text-sm text-red-600">{error}</p>
              <button
                onClick={fetchQr}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                Retry
              </button>
            </div>
          ) : qr ? (
            <>
              <img src={qrSrc(qr)} alt="WhatsApp QR code" className="h-56 w-56 rounded-lg border border-gray-100" />
              <p className="text-center text-xs text-gray-500">
                In WhatsApp: Settings → Linked devices → Link a device, then scan this code.
              </p>
              {pairingCode && (
                <p className="text-xs text-gray-400">
                  Pairing code: <span className="font-mono font-medium text-gray-600">{pairingCode}</span>
                </p>
              )}
            </>
          ) : (
            <div className="flex h-56 w-56 items-center justify-center text-sm text-gray-400">Loading QR code…</div>
          )}
        </div>
      </div>
    </div>
  );
}
