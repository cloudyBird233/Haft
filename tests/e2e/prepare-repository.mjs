import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Prepare a disposable main Git worktree for repository validation tests.
 * The path is deterministic so the Playwright runner configuration can allow
 * exactly this directory and nothing else.
 */
const root = join(process.cwd(), 'test-results', 'e2e-repository');

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const git = (args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Haft E2E',
      GIT_AUTHOR_EMAIL: 'e2e@haft.local',
      GIT_COMMITTER_NAME: 'Haft E2E',
      GIT_COMMITTER_EMAIL: 'e2e@haft.local',
    },
  }).trim();

git(['init', '--initial-branch=main']);
git(['commit', '--allow-empty', '-m', 'initial commit']);
process.stdout.write(`Prepared E2E repository at ${root}\n`);
