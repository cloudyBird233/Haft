import type { LabelHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Label({
  className,
  children,
  required,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }): JSX.Element {
  return (
    <label className={cn('field-label', className)} {...props}>
      {children}
      {required ? (
        <span className="ml-0.5 text-danger" aria-hidden="true">
          *
        </span>
      ) : null}
    </label>
  );
}

export function FieldError({
  id,
  children,
  className,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <p id={id} className={cn('mt-1.5 text-[11.5px] leading-4 text-danger', className)}>
      {children}
    </p>
  );
}

export function FieldHint({ id, children }: { id?: string; children: ReactNode }): JSX.Element {
  return (
    <p id={id} className="mt-1.5 text-[11.5px] leading-4 text-faint">
      {children}
    </p>
  );
}

export function Field({
  label,
  htmlFor,
  required,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  error?: string | null;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div>
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {children}
      {error ? <FieldError id={`${htmlFor}-error`}>{error}</FieldError> : null}
      {!error && hint ? <FieldHint id={`${htmlFor}-hint`}>{hint}</FieldHint> : null}
    </div>
  );
}
