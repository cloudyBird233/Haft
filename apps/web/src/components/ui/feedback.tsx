import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react';
import { Button } from './button';
import { cn } from '../../lib/utils';

export function Spinner({ className }: { className?: string }): JSX.Element {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block size-4 animate-spin rounded-full border-[1.5px] border-current border-r-transparent',
        className,
      )}
    />
  );
}

export function InlineAlert({
  children,
  variant = 'error',
  testId,
}: {
  children: ReactNode;
  variant?: 'error' | 'warning' | 'info' | 'success';
  testId?: string;
}): JSX.Element {
  const styles = {
    error: 'border-danger/20 bg-[#fbf1ee] text-[#873d2f]',
    warning: 'border-warning/20 bg-[#faf4e8] text-[#795617]',
    info: 'border-info/20 bg-[#eef3f6] text-[#405d78]',
    success: 'border-success/20 bg-[#edf5f0] text-[#356a4e]',
  } as const;
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      data-testid={testId}
      className={cn('flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[12px] leading-5', styles[variant])}
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

export function ErrorState({
  title = 'Unable to load data',
  description = 'The request could not be completed. Check the connection and try again.',
  onRetry,
  retryLabel = 'Try again',
  testId = 'error-state',
  retryTestId,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  testId?: string;
  retryTestId?: string;
}): JSX.Element {
  return (
    <div
      className="flex min-h-[280px] flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong bg-[#fbfaf7] px-6 py-12 text-center"
      data-testid={testId}
      role="alert"
    >
      <span className="mb-4 flex size-10 items-center justify-center rounded-xl border border-[#ecd8d2] bg-[#fbf1ee] text-danger">
        <AlertTriangle size={18} aria-hidden="true" />
      </span>
      <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-md text-[12.5px] leading-5 text-muted">{description}</p>
      {onRetry ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-4"
          onClick={onRetry}
          data-testid={retryTestId}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  testId = 'empty-state',
  className,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  testId?: string;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong bg-[#fbfaf7] px-6 py-12 text-center',
        className,
      )}
      data-testid={testId}
    >
      <span className="mb-3.5 flex size-10 items-center justify-center rounded-xl border border-line bg-panel text-faint shadow-sm">
        {icon ?? <Inbox size={18} aria-hidden="true" />}
      </span>
      <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-md text-[12.5px] leading-5 text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }): JSX.Element {
  return <div className={cn('skeleton rounded-md', className)} aria-hidden="true" />;
}

export function PageLoadingState({
  label = 'Loading workspace data',
  rows = 4,
  testId = 'page-loading',
}: {
  label?: string;
  rows?: number;
  testId?: string;
}): JSX.Element {
  return (
    <div role="status" aria-label={label} data-testid={testId} className="space-y-4">
      <span className="sr-only">{label}</span>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-[112px] rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,0.9fr)]">
        <div className="panel p-5">
          <Skeleton className="mb-5 h-5 w-40" />
          <div className="space-y-3">
            {Array.from({ length: rows }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        </div>
        <div className="panel p-5">
          <Skeleton className="mb-5 h-5 w-32" />
          <div className="space-y-3">
            {Array.from({ length: rows }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
