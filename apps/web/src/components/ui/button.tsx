import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';
type ButtonSize = 'sm' | 'md' | 'icon';

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-ink text-white border border-ink hover:bg-[#39362f] active:bg-[#151411] shadow-[0_1px_1px_rgba(0,0,0,0.08)]',
  secondary:
    'bg-panel text-ink border border-line-strong hover:bg-surface active:bg-[#f2f0eb] shadow-[0_1px_1px_rgba(0,0,0,0.03)]',
  ghost: 'bg-transparent text-muted border border-transparent hover:bg-black/[0.04] hover:text-ink',
  danger:
    'bg-danger text-white border border-danger hover:bg-[#913d2e] active:bg-[#7f3427]',
  quiet: 'bg-surface text-ink border border-line hover:bg-[#f2f0eb]',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 rounded-lg px-2.5 text-[12px] gap-1.5',
  md: 'h-9 rounded-[10px] px-3.5 text-[13px] gap-2',
  icon: 'size-9 rounded-[10px] p-0',
};

export function buttonStyles(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  return cn(
    'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,border-color,color,box-shadow] duration-150 focus-ring disabled:opacity-45',
    variants[variant],
    sizes[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', loading = false, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={buttonStyles(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-loading={loading ? 'true' : undefined}
      {...props}
    >
      {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
});
