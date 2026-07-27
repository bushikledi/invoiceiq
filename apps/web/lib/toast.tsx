'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Transient confirmation for actions whose result is otherwise invisible.
 *
 * Approving a document already changes the badge, so a toast there is noise.
 * Requeueing does not: the row goes from "Failed" to "Queued" somewhere below
 * the fold, and without a toast the honest reading of a click that appears to
 * do nothing is that it did nothing — so the operator clicks again.
 *
 * Toasts are for *feedback*, never for information the user must act on. A
 * message that disappears after five seconds cannot carry a decision, so
 * anything requiring one belongs in the page (see `ErrorState`).
 */
export type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  notify: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DISMISS_AFTER_MS = 5_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, message }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/*
        `role="status"` with `aria-live="polite"` so a screen reader announces
        the result without interrupting whatever it is currently reading. An
        `assertive` region here would cut off mid-sentence to say "Requeued",
        which is not important enough to interrupt anyone.

        `pointer-events-none` on the container with it re-enabled per toast:
        the region spans a corner of the viewport, and without this it would
        swallow clicks on whatever sits underneath even when empty.
      */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const TONE_CLASSES: Record<ToastTone, string> = {
  success: 'border-positive-line bg-positive-soft text-positive-ink',
  error: 'border-critical-line bg-critical-soft text-critical-ink',
  info: 'border-line bg-surface-raised text-ink',
};

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div
      className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg ${TONE_CLASSES[toast.tone]}`}
    >
      <span className="flex-1">{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 opacity-60 transition hover:opacity-100"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  // A no-op fallback rather than a throw: a missing provider should not take
  // down a page whose actual work succeeded. Losing the confirmation message is
  // a far smaller failure than losing the screen.
  return context ?? { notify: () => undefined };
}
