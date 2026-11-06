import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '../lib/utils';

type ToastVariant = 'success' | 'error' | 'info';

interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
}

interface ToastRecord extends ToastInput {
  id: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
const MAX_TOASTS = 4;

function newToastId(): string {
  return `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    const id = newToastId();
    setToasts((current) => [
      ...current.slice(-(MAX_TOASTS - 1)),
      { ...input, id, variant: input.variant ?? 'info' },
    ]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 4500);
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
          aria-live="polite"
          aria-label="Notifications"
        >
          {toasts.map((item) => {
            const Icon =
              item.variant === 'success'
                ? CheckCircle2
                : item.variant === 'error'
                  ? AlertCircle
                  : Info;
            return (
              <div
                key={item.id}
                role={item.variant === 'error' ? 'alert' : 'status'}
                data-testid="toast"
                data-variant={item.variant}
                data-state="visible"
                className={cn(
                  'pointer-events-auto flex animate-scale-in items-start gap-3 rounded-xl border bg-panel p-3.5 shadow-float',
                  item.variant === 'error' ? 'border-danger/25' : 'border-line',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
                    item.variant === 'success' && 'bg-success/10 text-success',
                    item.variant === 'error' && 'bg-danger/10 text-danger',
                    item.variant === 'info' && 'bg-info/10 text-info',
                  )}
                >
                  <Icon size={15} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-ink">{item.title}</p>
                  {item.description ? (
                    <p className="mt-0.5 text-[12px] leading-5 text-muted">{item.description}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  aria-label="Dismiss notification"
                  onClick={() => dismiss(item.id)}
                  className="rounded-md p-1 text-faint transition-colors hover:bg-surface hover:text-ink focus-ring"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside ToastProvider');
  }
  return context;
}

export function useToastTimer(active: boolean, callback: () => void, delay = 4500): void {
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(callback, delay);
    return () => window.clearTimeout(timer);
  }, [active, callback, delay]);
}
