import { test as base, expect } from '@playwright/test';
import { RaftTestFactory } from './test-data-factory';

export type RaftFixtures = {
  factory: RaftTestFactory;
  resetSeed: void;
};

/**
 * Shared Playwright fixtures.
 *
 * `resetSeed` is auto-used so every test starts from the deterministic default
 * seed. Tests that need the empty preset (or extra factory data) can do so
 * after the automatic reset.
 */
export const test = base.extend<RaftFixtures>({
  factory: async ({ request }, use) => {
    const factory = new RaftTestFactory(request, {
      apiBaseUrl: process.env.E2E_API_URL ?? 'http://127.0.0.1:3101',
    });
    await use(factory);
  },
  resetSeed: [
    async ({ factory }, use) => {
      await factory.reset('default');
      await use();
    },
    { auto: true },
  ],
});

export { expect };
