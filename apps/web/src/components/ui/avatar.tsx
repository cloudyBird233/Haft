import { cn, initials } from '../../lib/utils';

const palettes = [
  'bg-[#e9e5dc] text-[#625d52]',
  'bg-[#e4ebe6] text-[#456455]',
  'bg-[#e6e9ee] text-[#52677e]',
  'bg-[#efe7de] text-[#7a6147]',
];

function hashCode(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}): JSX.Element {
  const palette = palettes[hashCode(name) % palettes.length];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full border border-black/[0.04] font-semibold tracking-[-0.02em]',
        size === 'sm' && 'size-6 text-[9px]',
        size === 'md' && 'size-8 text-[10.5px]',
        size === 'lg' && 'size-11 text-[13px]',
        palette,
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
