import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionDiffDto } from '@raft-lite/contracts';
import { ChangesPanel } from '../features/executions/changes-panel';

function diff(overrides: Partial<ExecutionDiffDto> = {}): ExecutionDiffDto {
  return {
    executionId: 'execution_test',
    available: true,
    branchName: 'haft/execution_test',
    baseCommit: '1'.repeat(40),
    headCommit: '2'.repeat(40),
    changedFiles: 1,
    diffStat: ' src/index.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)',
    gitStatus: ' M src/index.ts',
    diff: [
      'diff --git a/src/index.ts b/src/index.ts',
      'index 1111111..2222222 100644',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n'),
    diffTruncated: false,
    createdAt: '2026-11-07T10:00:00.000Z',
    ...overrides,
  };
}

describe('ChangesPanel', () => {
  it('renders Git metadata, the changed file and the unified diff', () => {
    render(<ChangesPanel diff={diff()} loading={false} error={false} onRetry={vi.fn()} />);

    expect(screen.getByTestId('execution-diff-panel')).toBeVisible();
    expect(screen.getByTestId('execution-diff-branch')).toHaveTextContent(
      'haft/execution_test',
    );
    expect(screen.getByTestId('execution-diff-base')).toHaveTextContent('1'.repeat(40));
    expect(screen.getByTestId('execution-diff-head')).toHaveTextContent('2'.repeat(40));
    expect(screen.getByTestId('execution-changed-files')).toBeVisible();
    expect(screen.getAllByTestId('execution-changed-file')).toHaveLength(1);
    expect(screen.getByTestId('execution-diff-file')).toHaveAttribute(
      'data-status',
      'modified',
    );
    expect(screen.getByTestId('execution-diff-content')).toHaveTextContent(
      '+export const value = 2;',
    );
    expect(screen.getByTestId('execution-diff-truncated')).toHaveAttribute(
      'data-truncated',
      'false',
    );
  });

  it('marks a truncated diff and never claims it is complete', () => {
    render(
      <ChangesPanel
        diff={diff({ diffTruncated: true })}
        loading={false}
        error={false}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByTestId('execution-diff-truncated')).toHaveAttribute(
      'data-truncated',
      'true',
    );
    expect(screen.getByTestId('execution-diff-truncated')).toHaveTextContent('truncated');
  });

  it('shows a binary hint instead of pretending to render binary content', () => {
    render(
      <ChangesPanel
        diff={diff({
          diff: [
            'diff --git a/image.bin b/image.bin',
            'index e0d84f4..9a529b9 100644',
            'Binary files a/image.bin and b/image.bin differ',
          ].join('\n'),
        })}
        loading={false}
        error={false}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByTestId('execution-diff-binary')).toBeInTheDocument();
    expect(screen.getByTestId('execution-diff-file')).toHaveAttribute('data-binary', 'true');
    expect(screen.getByTestId('execution-diff-file')).toHaveTextContent(
      'Binary file — diff content not rendered',
    );
  });

  it('renders an explicit empty state when no diff artifact exists', () => {
    render(
      <ChangesPanel
        diff={diff({ available: false, changedFiles: 0, diff: '', diffStat: '' })}
        loading={false}
        error={false}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByTestId('execution-diff-empty')).toBeVisible();
    expect(screen.queryByTestId('execution-diff-file')).not.toBeInTheDocument();
  });
});
