import { expect, type Locator, type Page } from '@playwright/test';
import { byTestId, route } from './ui-contract';

/**
 * Small, readable wrappers shared by the functional, business-loop and visual
 * suites. They deliberately prefer the machine-readable contract over ad-hoc
 * selectors so a rename only has to happen in one place.
 */
export async function gotoRoute(
  page: Page,
  routeKey: string,
  values: Record<string, string> = {},
): Promise<void> {
  await page.goto(route(routeKey, values), { waitUntil: 'domcontentloaded' });
  await expect(byTestId(page, 'shell.root')).toBeVisible();
}

export async function gotoPath(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(byTestId(page, 'shell.root')).toBeVisible();
}

export function toast(page: Page, title: string): Locator {
  return byTestId(page, 'toast').filter({ hasText: title });
}

export async function expectSuccessToast(page: Page, title: string): Promise<void> {
  const notification = toast(page, title);
  await expect(notification).toBeVisible();
  await expect(notification).toHaveAttribute('data-variant', 'success');
}

export async function expectErrorToast(page: Page, title: string): Promise<void> {
  const notification = toast(page, title);
  await expect(notification).toBeVisible();
  await expect(notification).toHaveAttribute('data-variant', 'error');
}

export function agentCard(page: Page, name: string): Locator {
  return byTestId(page, 'agents.card').filter({ hasText: name });
}

export function taskCard(page: Page, title: string): Locator {
  return byTestId(page, 'taskBoard.card').filter({ hasText: title });
}

export function lane(page: Page, laneId: string): Locator {
  return byTestId(page, 'taskBoard.lane', { lane: laneId });
}

export function laneCount(page: Page, laneId: string): Locator {
  return byTestId(page, 'taskBoard.laneCount', { lane: laneId });
}

export async function openAgent(page: Page, name: string): Promise<Locator> {
  await agentCard(page, name).click();
  const panel = byTestId(page, 'agentDetail.panel');
  await expect(panel).toBeVisible();
  return panel;
}

export async function openTask(page: Page, title: string): Promise<Locator> {
  await taskCard(page, title).click();
  const panel = byTestId(page, 'taskDetail.panel');
  await expect(panel).toBeVisible();
  return panel;
}

export async function waitForBoard(page: Page): Promise<void> {
  await expect(byTestId(page, 'tasks.page')).toBeVisible();
  await expect(byTestId(page, 'taskBoard.root')).toBeVisible();
}

export async function waitForAgentList(page: Page): Promise<void> {
  await expect(byTestId(page, 'agents.page')).toBeVisible();
  await expect(byTestId(page, 'agents.list')).toBeVisible();
}

export async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('dialog-close-button')).toHaveCount(0);
}

/** Intercept one or more requests, freeing them after the route handler flips the flag. */
export async function failRequestsUntilRetry(
  page: Page,
  pattern: string | RegExp,
  method = 'GET',
): Promise<{ stopFailing: () => void }> {
  let failing = true;
  await page.route(pattern, async (routeHandler) => {
    if (!failing && routeHandler.request().method() === method) {
      await routeHandler.continue();
      return;
    }
    if (routeHandler.request().method() === method) {
      await routeHandler.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'E2E_INDUCED_FAILURE',
            message: 'Induced failure for the error-state E2E test',
          },
          requestId: 'e2e-induced',
        }),
      });
      return;
    }
    await routeHandler.continue();
  });
  return {
    stopFailing: () => {
      failing = false;
    },
  };
}
