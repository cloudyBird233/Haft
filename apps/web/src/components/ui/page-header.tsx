import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/utils';

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  testId,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  testId?: string;
  className?: string;
}): JSX.Element {
  return (
    <header
      className={cn('mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between', className)}
      data-testid={testId}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.035em] text-ink">
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-[12.5px] leading-5 text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function SectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div>
        <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-[11.5px] text-faint">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function TextLink({
  to,
  children,
  testId,
}: {
  to: string;
  children: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      data-testid={testId}
      className="rounded text-[11.5px] font-semibold text-muted transition-colors hover:text-ink focus-ring"
    >
      {children}
    </Link>
  );
}
