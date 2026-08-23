import { createContext, useCallback, useContext, useRef, useState } from 'react';

export type ToastKind = 'ok' | 'err';

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

type PushToast = (text: string, kind?: ToastKind) => void;

const ToastCtx = createContext<PushToast>(() => {});

/** App-wide toast notifications: `const toast = useToast(); toast('Saved')`. */
export const useToast = (): PushToast => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback<PushToast>((text, kind = 'ok') => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2500);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`animate-rise flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-white shadow-lg ${
              t.kind === 'err' ? 'bg-red-600/95' : 'bg-black/85'
            }`}
          >
            <span aria-hidden="true">{t.kind === 'err' ? '✗' : '✓'}</span>
            <span dir="auto">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
