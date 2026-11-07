import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GitExecutionResult } from '@raft-lite/contracts';
import type { RunnerConfig } from './config';
import {
  buildCliEnvironment,
  errorMessage,
  runProcess,
  type ProcessRunResult,
} from './process-utils';

export interface WorktreeInfo {
  path: string;
  branchName: string;
  baseCommit: string;
}

export interface WorktreeCleanupResult {
  path: string;
  removed: boolean;
}

export class GitWorktreeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'GitWorktreeError';
  }
}

/**
 * Creates one Git worktree per execution so a CLI can never run in the user's
 * checked-out tree. The runner never commits, pushes, merges or fetches; it
 * only adds a worktree branch at the current HEAD and reports the diff.
 */
export class GitWorktreeManager {
  constructor(
    private readonly config: Pick<
      RunnerConfig,
      'gitBinary' | 'worktreeRoot' | 'keepWorktrees'
    >,
  ) {}

  async prepare(
    projectPath: string,
    projectId: string,
    executionId: string,
  ): Promise<WorktreeInfo> {
    const project = resolve(projectPath);
    let info;
    try {
      info = await stat(project);
    } catch {
      throw new GitWorktreeError('PROJECT_PATH_MISSING', `${project} does not exist`);
    }
    if (!info.isDirectory()) {
      throw new GitWorktreeError('PROJECT_PATH_INVALID', `${project} is not a directory`);
    }

    const topLevel = await this.git(project, ['rev-parse', '--show-toplevel']);
    const top = topLevel.stdout.trim();
    if (!top || comparablePath(top) !== comparablePath(project)) {
      throw new GitWorktreeError(
        'PROJECT_NOT_GIT_ROOT',
        `${project} is not the root of a Git repository`,
      );
    }

    const base = await this.git(project, ['rev-parse', 'HEAD']);
    const baseCommit = base.stdout.trim();
    if (!baseCommit) {
      throw new GitWorktreeError('PROJECT_HAS_NO_COMMITS', `${project} has no commits to branch from`);
    }

    const branchName = `haft/${sanitizeSegment(executionId)}`;
    const branch = await this.git(
      project,
      ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
      true,
    );
    if (branch.code === 0) {
      throw new GitWorktreeError(
        'BRANCH_EXISTS',
        `Branch ${branchName} already exists; refusing to reuse an old execution branch`,
      );
    }
    if (branch.code !== 1) {
      throw new GitWorktreeError(
        'GIT_BRANCH_CHECK_FAILED',
        summarizeGitFailure(branch),
      );
    }

    const root = resolve(this.config.worktreeRoot);
    const worktreePath = join(
      root,
      sanitizeSegment(projectId),
      sanitizeSegment(executionId),
    );
    assertInside(root, worktreePath);

    try {
      const existing = await stat(worktreePath);
      if (existing) {
        throw new GitWorktreeError(
          'WORKTREE_EXISTS',
          `${worktreePath} already exists; refusing to reuse it`,
        );
      }
    } catch (error) {
      if (error instanceof GitWorktreeError) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== 'ENOENT') {
        throw new GitWorktreeError(
          'WORKTREE_PATH_INVALID',
          `Could not inspect ${worktreePath}: ${errorMessage(error)}`,
        );
      }
    }

    await mkdir(join(root, sanitizeSegment(projectId)), { recursive: true });
    await this.git(project, [
      'worktree',
      'add',
      '-b',
      branchName,
      worktreePath,
      baseCommit,
    ]);

    return { path: worktreePath, branchName, baseCommit };
  }

  async collect(info: WorktreeInfo): Promise<GitExecutionResult | null> {
    try {
      const head = await this.git(info.path, ['rev-parse', 'HEAD'], true);
      const status = await this.git(
        info.path,
        ['status', '--porcelain=v1', '--untracked-files=all'],
        true,
      );
      const diffNames = await this.git(
        info.path,
        ['diff', '--name-only', info.baseCommit, '--'],
        true,
      );
      const diffStat = await this.git(
        info.path,
        ['diff', '--stat', '--no-color', info.baseCommit, '--'],
        true,
      );

      const statusLines = status.stdout
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean);
      const untracked = statusLines
        .filter((line) => line.startsWith('?? '))
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
      const changedNames = new Set(
        diffNames.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      );
      for (const path of untracked) changedNames.add(path);

      const untrackedStat =
        untracked.length > 0
          ? ['Untracked files:', ...untracked.map((path) => ` ${path}`)].join('\n')
          : '';
      const diff = [diffStat.stdout.trim(), untrackedStat].filter(Boolean).join('\n');

      return {
        branchName: info.branchName,
        baseCommit: info.baseCommit,
        headCommit: head.code === 0 && head.stdout.trim() ? head.stdout.trim() : null,
        changedFiles: changedNames.size,
        diffStat: diff.slice(0, 20_000),
        gitStatus: statusLines.join('\n').slice(0, 20_000),
      };
    } catch {
      return null;
    }
  }

  async cleanup(info: WorktreeInfo | null, projectPath: string): Promise<WorktreeCleanupResult> {
    if (!info) {
      return { path: '', removed: false };
    }
    if (this.config.keepWorktrees) {
      return { path: info.path, removed: false };
    }
    const removed = await this.git(
      resolve(projectPath),
      ['worktree', 'remove', '--force', info.path],
      true,
    );
    if (removed.code !== 0) {
      return { path: info.path, removed: false };
    }
    await this.git(
      resolve(projectPath),
      ['worktree', 'prune'],
      true,
    );
    return { path: info.path, removed: true };
  }

  private async git(
    cwd: string,
    args: string[],
    allowFailure = false,
  ): Promise<ProcessRunResult> {
    let result: ProcessRunResult;
    try {
      result = await runProcess(this.config.gitBinary, ['-C', cwd, ...args], {
        timeoutMs: 120_000,
        env: buildCliEnvironment(),
        maxOutputBytes: 2 * 1024 * 1024,
      });
    } catch (error) {
      throw new GitWorktreeError('GIT_NOT_AVAILABLE', errorMessage(error));
    }
    if (!allowFailure && result.code !== 0) {
      throw new GitWorktreeError(
        'GIT_COMMAND_FAILED',
        `${args.join(' ')} failed: ${summarizeGitFailure(result)}`,
      );
    }
    return result;
  }
}

function summarizeGitFailure(result: ProcessRunResult): string {
  const output = (result.stderr || result.stdout).trim();
  const hint =
    result.code === null
      ? result.signal
        ? `terminated by ${result.signal}`
        : 'did not start'
      : `exit code ${result.code}`;
  return output ? `${output.slice(0, 500)} (${hint})` : hint;
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80);
  return sanitized || 'execution';
}

function comparablePath(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertInside(root: string, target: string): void {
  const relativePath = relative(resolve(root), resolve(target));
  if (
    !relativePath ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath) ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new GitWorktreeError(
      'WORKTREE_PATH_INVALID',
      `${target} is outside the configured worktree root ${root}`,
    );
  }
}
