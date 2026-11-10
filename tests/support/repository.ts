import { expect } from '@playwright/test';
import type { ProjectBindingDto } from '@raft-lite/contracts';
import type { RaftTestFactory } from '../fixtures/test-data-factory';

export const E2E_COMPUTER_ID = 'computer_local';
export const E2E_PROJECT_ID = 'project_demo';

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
 * Ensure a project/computer pair has a `ready` binding for success-path tests.
 *
 * P2-01 creates every binding as `unverified` and never writes `ready`; the
 * P2-02 runner validation protocol does not exist yet. This helper therefore
 * uses the test-only `__test__` fixture, which is mounted only when
 * `E2E_TEST_MODE=true`. It is not part of the product API.
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
  const path = options.path ?? process.cwd();

  const project = await factory.getProject(projectId);
  const existing = project.bindings.find((binding) => binding.computerId === computerId);
  const binding =
    existing ??
    (await factory.createProjectBinding(projectId, {
      computerId,
      path,
    }));

  if (binding.status === 'ready' && binding.validatedBindingVersion === binding.bindingVersion) {
    return binding;
  }

  return factory.markProjectBindingReady(projectId, binding.id);
}
