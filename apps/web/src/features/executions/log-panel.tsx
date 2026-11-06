import { useEffect, useRef, type RefObject } from 'react';
import type { ExecutionLogDto } from '@raft-lite/contracts';
import { cn, formatLogTime } from '../../lib/utils';
import type { SocketStatus } from '../../providers/socket-provider';

const levelColor: Record<string, string> = {
  info: 'text-[#aeb8a9]',
  success: 'text-[#83b98e]',
  warning: 'text-[#d3aa63]',
  error: 'text-[#e0907e]',
};

function useAutoScroll(ref: RefObject<HTMLDivElement | null>, trigger: number): void {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [ref, trigger]);
}

export function LogPanel({
  logs,
  loading,
  live,
  socketStatus,
  error,
  onRetry,
}: {
  logs: ExecutionLogDto[];
  loading: boolean;
  live: boolean;
  socketStatus: SocketStatus;
  error?: boolean;
  onRetry?: () => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  useAutoScroll(scrollRef, logs.length);

  return (
    <section
      className="overflow-hidden rounded-2xl border border-[#30302b] bg-terminal shadow-soft"
      data-testid="execution-log-panel"
      aria-labelledby="execution-log-title"
    >
      <header className="flex items-center gap-3 border-b border-white/[0.09] px-4 py-3">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="size-2 rounded-full bg-[#685f57]" />
          <span className="size-2 rounded-full bg-[#685f57]" />
          <span className="size-2 rounded-full bg-[#685f57]" />
        </div>
        <h2 id="execution-log-title" className="text-[11px] font-semibold text-[#d8d5cb]">
          Execution log
        </h2>
        <span className="numeric rounded-full border border-white/10 px-1.5 py-0.5 text-[9px] text-[#8c897f]">
          {logs.length}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {error ? (
            <button
              type="button"
              onClick={onRetry}
              className="rounded text-[10px] font-medium text-[#e0907e] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d8d5cb]"
            >
              Retry log stream
            </button>
          ) : (
            <span
              className="flex items-center gap-1.5 text-[9.5px] text-[#8c897f]"
              data-testid="execution-log-live-status"
              data-live={live ? 'true' : 'false'}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  live && socketStatus === 'connected' ? 'animate-pulse bg-[#7fb28a]' : 'bg-[#736f66]',
                )}
                aria-hidden="true"
              />
              {live
                ? socketStatus === 'connected'
                  ? 'Streaming live'
                  : 'Polling fallback'
                : 'Stream complete'}
            </span>
          )}
        </div>
      </header>

      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Execution logs"
        data-testid="execution-log"
        className="scroll-area h-[300px] overflow-y-auto bg-terminal px-4 py-3 font-mono text-[11px] leading-[1.75]"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-[#8c897f]" role="status">
            Connecting to log stream…
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-[#e0907e]" role="alert" data-testid="execution-log-error">
            The log stream could not be loaded.
          </div>
        ) : logs.length === 0 ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 text-[#86837a]"
            data-testid="execution-log-empty"
          >
            <span className="font-sans text-[11.5px] font-medium text-[#a5a197]">
              Waiting for execution output
            </span>
            <span className="font-sans text-[10.5px] text-[#726f66]">
              Runtime events will appear here as they arrive.
            </span>
          </div>
        ) : (
          <ol className="space-y-0.5">
            {logs.map((log) => (
              <li
                key={log.id}
                data-testid="execution-log-entry"
                data-seq={log.seq}
                data-level={log.level}
                className="grid grid-cols-[62px_16px_58px_minmax(0,1fr)] items-start gap-2 rounded py-0.5 hover:bg-white/[0.035]"
              >
                <time
                  className="numeric text-[#6e6b63]"
                  dateTime={log.timestamp}
                  title={log.timestamp}
                >
                  {formatLogTime(log.timestamp)}
                </time>
                <span className={cn('mt-[7px] size-1.5 rounded-full bg-current', levelColor[log.level])} aria-hidden="true" />
                <span className={cn('text-[9px] font-semibold uppercase tracking-[0.08em]', levelColor[log.level])}>
                  {log.level}
                </span>
                <span className="whitespace-pre-wrap break-words text-[#cdc9bf]">{log.message}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
