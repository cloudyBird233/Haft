import { Outlet } from 'react-router-dom';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../../providers/socket-provider';
import { MobileNav, Sidebar } from './sidebar';

function ConnectionBanner(): JSX.Element | null {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div
      role="alert"
      data-testid="app-offline-banner"
      className="fixed left-1/2 top-3 z-[90] flex -translate-x-1/2 items-center gap-2 rounded-full border border-[#ecd8d2] bg-[#fbf1ee] px-3.5 py-2 text-[11.5px] font-medium text-[#873d2f] shadow-soft"
    >
      <WifiOff size={13} aria-hidden="true" />
      You are offline. Changes will fail until the connection returns.
    </div>
  );
}

export function AppShell(): JSX.Element {
  return (
    <div className="min-h-screen bg-canvas text-ink" data-testid="app-shell">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-lg bg-ink px-3 py-2 text-[12px] font-medium text-white focus:translate-y-0"
      >
        Skip to main content
      </a>
      <Sidebar />
      <div className="min-h-screen lg:pl-[248px]">
        <MobileNav />
        <main id="main-content" tabIndex={-1}>
          <div className="mx-auto w-full max-w-[1560px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7 xl:px-9">
            <Outlet />
          </div>
        </main>
      </div>
      <ConnectionBanner />
    </div>
  );
}
