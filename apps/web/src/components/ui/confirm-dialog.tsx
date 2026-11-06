import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { type ReactNode } from 'react';
import { Button } from './button';

export const AlertDialog = AlertDialogPrimitive.Root;

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  pending = false,
  danger = false,
  testId = 'confirm-dialog',
  confirmTestId = 'confirm-dialog-confirm-button',
  cancelTestId = 'confirm-dialog-cancel-button',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  pending?: boolean;
  danger?: boolean;
  testId?: string;
  confirmTestId?: string;
  cancelTestId?: string;
}): JSX.Element {
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-[60] animate-fade-in bg-[#1c1a16]/25 backdrop-blur-[1.5px]" />
        <AlertDialogPrimitive.Content
          data-testid={testId}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(430px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 animate-scale-in rounded-2xl border border-line bg-panel p-5 shadow-float focus:outline-none"
        >
          <AlertDialogPrimitive.Title className="pr-6 text-[15px] font-semibold tracking-[-0.01em] text-ink">
            {title}
          </AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description className="mt-2 text-[13px] leading-5 text-muted">
            {description}
          </AlertDialogPrimitive.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="secondary" data-testid={cancelTestId} disabled={pending}>
                {cancelLabel}
              </Button>
            </AlertDialogPrimitive.Cancel>
            <Button
              variant={danger ? 'danger' : 'primary'}
              onClick={onConfirm}
              loading={pending}
              data-testid={confirmTestId}
            >
              {pending ? 'Working…' : confirmLabel}
            </Button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
