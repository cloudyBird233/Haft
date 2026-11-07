import { useMemo } from 'react';
import { AlertTriangle, Binary, FileDiff, GitBranch, RefreshCw } from 'lucide-react';
import type { ExecutionDiffDto } from '@raft-lite/contracts';
import { Button } from '../../components/ui/button';
import { ErrorState, Skeleton } from '../../components/ui/feedback';
import { parseUnifiedDiff, type DiffFileStatus } from './diff-parser';

const STATUS_STYLES: Record<DiffFileStatus, string> = {
  added: 'border-success/25 bg-[#eef5f0] text-[#356a4e]',
  modified: 'border-[#d6e0e8] bg-[#eef3f6] text-[#4f6f8f]',
  deleted: 'border-danger/20 bg-[#fbf1ee] text-[#873d2f]',
  renamed: 'border-[#e5ddc9] bg-[#f8f4e9] text-[#7a6941]',
};

const STATUS_LABELS: Record<DiffFileStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
};

export function ChangesPanel({
  diff,
  loading,
  error,
  onRetry,
}: {
  diff: ExecutionDiffDto | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}): JSX.Element {
  const files = useMemo(() => parseUnifiedDiff(diff?.diff ?? ''), [diff?.diff]);

  if (loading && !diff) {
    return (
      <section className="panel p-5" data-testid="execution-diff-panel" aria-busy="true">
        <Skeleton className="h-5 w-28" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-14 rounded-xl" />
        </div>
        <Skeleton className="mt-4 h-[220px] rounded-xl" />
      </section>
    );
  }

  if (error || !diff) {
    return (
      <section className="panel p-5" data-testid="execution-diff-panel">
        <ErrorState
          title="Git diff could not be loaded"
          description="The stored patch is unavailable right now. Retry the request."
          onRetry={onRetry}
          testId="execution-diff-error"
          retryTestId="execution-diff-retry-button"
        />
      </section>
    );
  }

  return (
    <section className="panel p-5" data-testid="execution-diff-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
            Git changes
          </p>
          <h2 className="mt-1.5 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em] text-ink">
            <FileDiff size={15} aria-hidden="true" />
            Unified diff
          </h2>
        </div>
        <span
          className="rounded-full border border-line bg-surface px-2.5 py-1 text-[10px] font-medium text-muted"
          data-testid="execution-changed-files-count"
        >
          {diff.changedFiles} changed {diff.changedFiles === 1 ? 'file' : 'files'}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 text-[11px] sm:grid-cols-3" data-testid="execution-git-metadata">
        <div className="rounded-xl border border-line bg-[#faf8f3] px-3 py-2.5">
          <dt className="text-faint">Branch</dt>
          <dd
            className="mt-1 flex items-center gap-1.5 break-all font-mono text-[10.5px] text-ink"
            data-testid="execution-diff-branch"
          >
            <GitBranch size={11} aria-hidden="true" />
            {diff.branchName ?? 'Not reported'}
          </dd>
        </div>
        <div className="rounded-xl border border-line bg-[#faf8f3] px-3 py-2.5">
          <dt className="text-faint">Base commit</dt>
          <dd
            className="mt-1 break-all font-mono text-[10.5px] text-ink"
            data-testid="execution-diff-base"
          >
            {diff.baseCommit ?? 'Not reported'}
          </dd>
        </div>
        <div className="rounded-xl border border-line bg-[#faf8f3] px-3 py-2.5">
          <dt className="text-faint">Head commit</dt>
          <dd
            className="mt-1 break-all font-mono text-[10.5px] text-ink"
            data-testid="execution-diff-head"
          >
            {diff.headCommit ?? 'Not reported'}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
            diff.diffTruncated
              ? 'border-[#e5ddc9] bg-[#f8f4e9] text-[#7a6941]'
              : 'border-line bg-surface text-muted'
          }`}
          data-testid="execution-diff-truncated"
          data-truncated={diff.diffTruncated ? 'true' : 'false'}
        >
          {diff.diffTruncated ? <AlertTriangle size={10} aria-hidden="true" /> : null}
          {diff.diffTruncated ? 'Diff truncated at the size limit' : 'Complete diff'}
        </span>
      </div>

      {diff.diffStat ? (
        <pre className="mt-3 overflow-x-auto rounded-xl border border-line bg-[#faf8f3] p-3 font-mono text-[10.5px] leading-5 text-muted">
          {diff.diffStat}
        </pre>
      ) : null}

      <div className="mt-4" data-testid="execution-changed-files">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
          Changed files
        </p>
        {files.length === 0 ? (
          <p
            className="rounded-xl border border-dashed border-line px-3 py-5 text-center text-[11.5px] text-muted"
            data-testid="execution-diff-empty"
          >
            {diff.available
              ? 'This execution produced no file changes.'
              : 'No Git diff was reported for this execution.'}
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {files.map((file) => (
              <li
                key={`${file.status}:${file.path}`}
                className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11px]"
                data-testid="execution-changed-file"
                data-status={file.status}
              >
                <span
                  className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] ${STATUS_STYLES[file.status]}`}
                >
                  {file.status === 'added'
                    ? 'A'
                    : file.status === 'deleted'
                      ? 'D'
                      : file.status === 'renamed'
                        ? 'R'
                        : 'M'}
                </span>
                <span className="break-all font-mono text-[10.5px] text-ink">{file.path}</span>
                {file.oldPath ? (
                  <span className="font-mono text-[9.5px] text-faint">from {file.oldPath}</span>
                ) : null}
                {file.binary ? (
                  <span
                    className="ml-auto inline-flex items-center gap-1 rounded-full border border-line px-1.5 py-0.5 text-[9px] text-muted"
                    data-testid="execution-diff-binary"
                  >
                    <Binary size={9} aria-hidden="true" />
                    Binary
                  </span>
                ) : (
                  <span className="ml-auto font-mono text-[9.5px] text-faint">
                    +{file.additions} −{file.deletions}
                  </span>
                )}
                <span className="sr-only">{STATUS_LABELS[file.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {files.length > 0 ? (
        <div className="mt-4 space-y-3">
          {files.map((file) => (
            <article
              key={`content:${file.status}:${file.path}`}
              className="overflow-hidden rounded-xl border border-line"
              data-testid="execution-diff-file"
              data-status={file.status}
              data-path={file.path}
              data-binary={file.binary ? 'true' : 'false'}
            >
              <header className="flex flex-wrap items-center gap-2 border-b border-line bg-[#f8f6f1] px-3 py-2">
                <span
                  className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] ${STATUS_STYLES[file.status]}`}
                >
                  {STATUS_LABELS[file.status]}
                </span>
                <span className="break-all font-mono text-[10.5px] font-medium text-ink">
                  {file.path}
                </span>
                {file.binary ? (
                  <span className="ml-auto inline-flex items-center gap-1 text-[9.5px] text-muted">
                    <Binary size={10} aria-hidden="true" />
                    Binary file — diff content not rendered
                  </span>
                ) : null}
              </header>
              <pre
                className="max-h-[420px] overflow-auto bg-[#fdfcf9] p-3 font-mono text-[10.5px] leading-[1.6] text-ink"
                data-testid="execution-diff-content"
              >
                {file.content}
              </pre>
            </article>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onRetry} data-testid="execution-diff-refresh-button">
          <RefreshCw size={12} aria-hidden="true" />
          Refresh diff
        </Button>
      </div>
    </section>
  );
}
