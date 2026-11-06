import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  children,
  className,
  side = 'center',
  testId,
  ariaLabel,
  hideClose = false,
}: {
  children: ReactNode;
  className?: string;
  side?: 'center' | 'drawer';
  testId?: string;
  ariaLabel?: string;
  hideClose?: boolean;
}): JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 animate-fade-in bg-[#1c1a16]/20 backdrop-blur-[1.5px]" />
      <DialogPrimitive.Content
        data-testid={testId}
        aria-label={ariaLabel}
        className={cn(
          'fixed z-50 border border-line bg-panel shadow-float focus:outline-none',
          side === 'center' &&
            'left-1/2 top-1/2 max-h-[calc(100vh-2rem)] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 animate-scale-in overflow-y-auto rounded-2xl',
          side === 'drawer' &&
            'inset-y-0 right-0 flex h-full w-[min(500px,calc(100vw-1rem))] animate-slide-in flex-col overflow-hidden rounded-l-2xl',
          className,
        )}
      >
        {children}
        {!hideClose ? (
          <DialogPrimitive.Close
            aria-label="Close dialog"
            data-testid="dialog-close-button"
            className="absolute right-3.5 top-3.5 rounded-lg p-1.5 text-faint transition-colors hover:bg-surface hover:text-ink focus-ring"
          >
            <X size={16} aria-hidden="true" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export function DialogBody({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cn('px-5 py-5', className)}>{children}</div>;
}

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 border-t border-line bg-[#fcfbf8] px-5 py-3.5',
        className,
      )}
    >
      {children}
    </div>
  );
}
