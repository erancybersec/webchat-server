import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export interface ConfirmOptions {
  title: string;
  body?: string;
  /** label of the confirming button, e.g. "Delete" */
  confirmLabel?: string;
  /** red styling for destructive actions */
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmCtx = createContext<ConfirmFn>(() => Promise.resolve(false));

/** Styled replacement for window.confirm: `if (await confirm({ title: '…' })) …`. */
export const useConfirm = (): ConfirmFn => useContext(ConfirmCtx);

interface Pending {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);

  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise<boolean>((resolve) => setPending({ opts, resolve })),
    [],
  );

  function close(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
  }

  useEffect(() => {
    if (!pending) return;
    // destructive dialogs focus Cancel so a stray Enter can't delete anything
    (pending.opts.danger ? cancelBtn : confirmBtn).current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => close(false)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label={pending.opts.title}
            className="animate-pop w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold text-gray-800" dir="auto">
              {pending.opts.title}
            </h3>
            {pending.opts.body && (
              <p className="mt-1.5 text-sm text-gray-500" dir="auto">
                {pending.opts.body}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                ref={cancelBtn}
                onClick={() => close(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                ref={confirmBtn}
                onClick={() => close(true)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${
                  pending.opts.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-wa hover:bg-wa-dark'
                }`}
              >
                {pending.opts.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}
