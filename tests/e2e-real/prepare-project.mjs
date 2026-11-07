/**
 * Prepares a disposable Git repository for the opt-in real CLI E2E suite.
 * The runner is configured with this repository as project_demo and creates
 * one worktree per execution under test-results/real-e2e/worktrees.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'test-results', 'real-e2e');
const workspace = join(root, 'workspace');
const worktrees = join(root, 'worktrees');

rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
rmSync(worktrees, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'README.md'), '# Haft real CLI E2E fixture\n', 'utf8');

const env = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Haft E2E',
  GIT_AUTHOR_EMAIL: 'haft-e2e@example.com',
  GIT_COMMITTER_NAME: 'Haft E2E',
  GIT_COMMITTER_EMAIL: 'haft-e2e@example.com',
};

const git = (args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'inherit', env });
git(['init']);
git(['add', 'README.md']);
git(['commit', '-m', 'initial']);

console.log(
  JSON.stringify({
    eventType: 'real_e2e.project_prepared',
    workspace,
    worktrees,
  }),
);
