import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { buttonStyles } from '../components/ui/button';

export function NotFoundPage(): JSX.Element {
  return (
    <div
      className="flex min-h-[70vh] flex-col items-center justify-center text-center"
      data-testid="not-found-page"
    >
      <span className="mb-4 flex size-11 items-center justify-center rounded-2xl border border-line bg-panel text-muted shadow-sm">
        <Compass size={20} aria-hidden="true" />
      </span>
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">404</p>
      <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.03em] text-ink">
        This page is not on the raft
      </h1>
      <p className="mt-2 max-w-sm text-[12.5px] leading-5 text-muted">
        The address may be outdated, or the resource may have moved.
      </p>
      <Link to="/" className={buttonStyles('primary') + ' mt-5'}>
        Back to overview
      </Link>
    </div>
  );
}
