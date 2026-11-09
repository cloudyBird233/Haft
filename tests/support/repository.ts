import { join } from 'node:path';
import { expect } from '@playwright/test';
import type { ProjectBindingDto } from '@raft-lite/contracts';
import type { RaftTestFactory } from '../fixtures/test-data-factory';

export const E2E_COMPUTER_ID = 'computer_local';
export const E2E_PROJECT_ID = 'project_demo';

/**
 * Disposable main Git worktree prepared by `tests/e2e/prepare-repository.mjs`.
 * It must not be a linked worktree: the runner path policy rejects those so a
 * real execution can never run in a developer checkout.
 */
export const E2E_REPOSITORY_PATH = join(process.cwd(), 'test-results', 'e2e-repository');

export async function waitForFakeRunner(
  factory: RaftTestFactory,
  projectId = E2E_PROJECT_ID,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { items } = await factory.getRuntimes({
          computerId: E2E_COMPUTER_ID,
          projectId,
        });
        return items.find((item) => item.runtime === 'codex')?.available ?? false;
      },
      {
        timeout: 45_000,
        message: `The Fake Runner did not register for ${E2E_COMPUTER_ID}/${projectId}. Start it with pnpm --filter @raft-lite/runner start.`,
      },
    )
    .toBe(true);
}

/**
 * Ensure the deterministic Fake Runner has validated the repository path for a
 * project/computer pair. Every test starts from a fresh seed, so bindings are
 * recreated and validated through the same public API used by the UI.
 */
export async function ensureReadyRepositoryBinding(
  factory: RaftTestFactory,
  options: {
    projectId?: string;
    computerId?: string;
    path?: string;
  } = {},
): Promise<ProjectBindingDto> {
  const projectId = options.projectId ?? E2E_PROJECT_ID;
  const computerId = options.computerId ?? E2E_COMPUTER_ID;
  const path = options.path ?? E2E_REPOSITORY_PATH;

  const project = await factory.getProject(projectId);
  const existing = project.bindings.find((binding) => binding.computerId === computerId);
  const binding =
    existing ??
    (await factory.createProjectBinding(projectId, {
      computerId,
      path,
    }));

  if (
    binding.status === 'ready' &&
    binding.validatedBindingVersion === binding.bindingVersion &&
    binding.path === path
  ) {
    return binding;
  }

  return factory.validateProjectBinding(projectId, binding.id);
}
