import { NavLink } from 'react-router-dom';
import {
  Bot,
  ExternalLink,
  LayoutDashboard,
  ListChecks,
  Radio,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useDashboard } from '../../hooks/use-raft-data';
import { useSocketStatus } from '../../providers/socket-provider';
import { cn } from '../../lib/utils';

const navItems = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true, testId: 'nav-overview' },
  { to: '/agents', label: 'Agents', icon: Bot, end: false, testId: 'nav-agents' },
  { to: '/tasks', label: 'Tasks', icon: ListChecks, end: false, testId: 'nav-tasks' },
] as const;

function LogoMark(): JSX.Element {
  return (
    <svg viewBox="0 0 28 28" className="size-7" aria-hidden="true">
      <rect width="28" height="28" rx="8" fill="#24221e" />
      <path d="M7 17.5h14M8.5 20.5h11" stroke="#f4f1e9" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M14 8v7" stroke="#f4f1e9" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M10.5 10.5 14 8l3.5 2.5" fill="none" stroke="#f4f1e9" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SocketIndicator(): JSX.Element {
  const status = useSocketStatus();
  const isLive = status === 'connected';
  return (
    <div
      data-testid="socket-status"
      data-status={status}
      className="flex items-center gap-2 text-[11px] text-muted"
      role="status"
      aria-label={`Realtime connection: ${isLive ? 'live' : status}`}
    >
      {isLive ? (
        <Wifi size={12} className="text-success" aria-hidden="true" />
      ) : (
        <WifiOff size={12} className="text-faint" aria-hidden="true" />
      )}
      <span>{isLive ? 'Live updates' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>
    </div>
  );
}

export function Sidebar(): JSX.Element {
  const dashboard = useDashboard();
  const agents = dashboard.data?.metrics.agentsTotal;
  const tasks = dashboard.data?.metrics.tasksTotal;

  return (
    <aside
      className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-[#e0ddd4] bg-sidebar px-3 py-4 lg:flex"
      data-testid="sidebar"
      aria-label="Primary navigation"
    >
      <div className="flex items-center gap-2.5 px-2">
        <LogoMark />
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold leading-tight tracking-[-0.02em] text-ink">
            Raft Lite
          </p>
          <p className="text-[10px] leading-tight text-faint">Agent workbench</p>
        </div>
      </div>

      <div className="mx-1 mt-5 rounded-xl border border-[#dfdcd3] bg-[#f8f7f3]/80 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded-md border border-line bg-panel text-[9px] font-bold text-ink">
            R
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11.5px] font-semibold text-ink">Raft Lite</p>
            <p className="truncate text-[9.5px] text-faint">Personal workspace</p>
          </div>
        </div>
      </div>

      <nav className="mt-5 flex flex-col gap-0.5" data-testid="sidebar-navigation">
        <p className="mb-1.5 px-2 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint">
          Workspace
        </p>
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              data-testid={item.testId}
              className={({ isActive }) =>
                cn(
                  'group flex h-9 items-center gap-2.5 rounded-[9px] border border-transparent px-2.5 text-[12.5px] font-medium transition-colors focus-ring',
                  isActive
                    ? 'border-[#dfdcd3] bg-[#fbfaf7] text-ink shadow-[0_1px_2px_rgba(26,24,20,0.04)]'
                    : 'text-[#65625a] hover:bg-black/[0.035] hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={15} strokeWidth={isActive ? 2 : 1.7} aria-hidden="true" />
                  <span className="flex-1">{item.label}</span>
                  {item.to === '/agents' && agents !== undefined ? (
                    <span className="numeric text-[10px] text-faint">{agents}</span>
                  ) : null}
                  {item.to === '/tasks' && tasks !== undefined ? (
                    <span className="numeric text-[10px] text-faint">{tasks}</span>
                  ) : null}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-7 px-2">
        <p className="mb-2 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint">
          Runtime
        </p>
        <div className="rounded-xl border border-[#dfdcd3] bg-[#f8f7f3]/75 p-3">
          <div className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-md bg-[#e6ebe5] text-[#4b6b58]">
              <Radio size={12} aria-hidden="true" />
            </span>
            <div>
              <p className="text-[11px] font-semibold text-ink">Mock runtime</p>
              <p className="text-[9.5px] text-faint">Deterministic execution</p>
            </div>
          </div>
          <div className="mt-2.5 border-t border-[#e3e0d8] pt-2">
            <SocketIndicator />
          </div>
        </div>
      </div>

      <div className="mt-auto px-2 pb-1">
        <a
          href="/api/docs"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-[11px] text-faint transition-colors hover:text-ink focus-ring"
          data-testid="api-docs-link"
        >
          <ExternalLink size={12} aria-hidden="true" />
          API reference
        </a>
        <div className="mt-1 flex items-center gap-1.5 px-1.5 text-[10px] text-faint">
          <span className="size-1.5 rounded-full bg-[#b9b4aa]" aria-hidden="true" />
          Phase 1 · Local demo
        </div>
      </div>
    </aside>
  );
}

export function MobileNav(): JSX.Element {
  return (
    <div className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-[#f8f7f3]/95 px-4 py-3 backdrop-blur lg:hidden">
      <div className="flex items-center gap-2">
        <LogoMark />
        <span className="text-[13px] font-semibold text-ink">Raft Lite</span>
      </div>
      <nav className="flex items-center gap-1" aria-label="Mobile navigation">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              aria-label={item.label}
              className={({ isActive }) =>
                cn(
                  'rounded-lg p-2 focus-ring',
                  isActive ? 'bg-ink text-white' : 'text-muted hover:bg-white',
                )
              }
            >
              <Icon size={16} aria-hidden="true" />
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
