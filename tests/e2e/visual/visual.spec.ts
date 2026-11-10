import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { RaftTestFactory } from '../../fixtures/test-data-factory';
import {
  gotoPath,
  gotoRoute,
  openAgent,
  openTask,
  waitForAgentList,
  waitForBoard,
} from '../../support/app';
import { waitForFakeRunner } from '../../support/repository';
import { byTestId } from '../../support/ui-contract';

const SCREENSHOT_DIR = join(process.cwd(), 'docs', 'screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function resetDefault(request: APIRequestContext): Promise<RaftTestFactory> {
  const factory = new RaftTestFactory(request, {
    apiBaseUrl: process.env.E2E_API_URL ?? 'http://127.0.0.1:3101',
  });
  await factory.reset('default');
  return factory;
}

async function capture(page: Page, name: string): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({
    path: join(SCREENSHOT_DIR, name),
    animations: 'disabled',
    caret: 'hide',
  });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('visual layout and screenshot gallery', () => {
  test('dashboard layout is stable at all required viewports with visual baseline', async ({
    page,
    request,
  }) => {
    await resetDefault(request);
    await gotoRoute(page, 'dashboard');
    await expect(byTestId(page, 'dashboard.statAgents')).toBeVisible();
    await expect(byTestId(page, 'shell.socketStatus')).toHaveAttribute('data-status', 'connected');

    await page.setViewportSize({ width: 1440, height: 900 });
    await expectNoPageOverflow(page);
    await capture(page, 'dashboard-1440x900.png');
    await expect(page).toHaveScreenshot('dashboard-1440x900.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.02,
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await expectNoPageOverflow(page);
    await expect(byTestId(page, 'dashboard.statCompleted')).toBeVisible();
    await capture(page, 'dashboard-1280x800.png');

    await page.setViewportSize({ width: 1920, height: 1080 });
    await expectNoPageOverflow(page);
    await expect(byTestId(page, 'dashboard.activityFeed')).toBeVisible();
    await capture(page, 'dashboard-1920x1080.png');
  });

  test('agents, tasks, details, and forms render without page overflow and are captured', async ({
    page,
    request,
  }) => {
    await resetDefault(request);

    await gotoRoute(page, 'agents');
    await waitForAgentList(page);
    await expectNoPageOverflow(page);
    await capture(page, 'agents-1440x900.png');

    await openAgent(page, 'Developer');
    await expect(byTestId(page, 'agentDetail.executionHistory')).toBeVisible();
    await capture(page, 'agent-detail-1440x900.png');
    await page.keyboard.press('Escape');

    await gotoRoute(page, 'tasks');
    await waitForBoard(page);
    await expectNoPageOverflow(page);
    const laneBoxes = await Promise.all(
      ['todo', 'active', 'review', 'done', 'stopped'].map(async (laneId) => {
        const box = await byTestId(page, 'taskBoard.lane', { lane: laneId }).boundingBox();
        return { laneId, box };
      }),
    );
    const laneTops = laneBoxes.map(({ box }) => box?.y ?? 0);
    expect(Math.max(...laneTops) - Math.min(...laneTops)).toBeLessThanOrEqual(1);
    await capture(page, 'tasks-1440x900.png');

    await openTask(page, 'Review runtime adapter boundaries');
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();
    await capture(page, 'task-detail-1440x900.png');
    await page.keyboard.press('Escape');

    await byTestId(page, 'tasks.create').click();
    await expect(byTestId(page, 'taskForm.dialog')).toBeVisible();
    await capture(page, 'create-task-dialog-1440x900.png');
    await page.keyboard.press('Escape');

    await gotoRoute(page, 'agents');
    await waitForAgentList(page);
    await byTestId(page, 'agents.create').click();
    await expect(byTestId(page, 'agentForm.dialog')).toBeVisible();
    await capture(page, 'create-agent-dialog-1440x900.png');
  });

  test('execution running and completed states are captured with live logs', async ({
    page,
    request,
  }) => {
    const factory = await resetDefault(request);
    await factory.setRuntimeMode('manual');
    const { execution } = await factory.createRunningExecution({
      task: { title: 'Capture the execution gallery' },
    });

    await gotoPath(page, `/executions/${execution.id}`);
    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'running',
    );
    await expect(byTestId(page, 'execution.logEntry')).toHaveCount(1);
    await factory.advanceExecution(execution.id, 2);
    await expect(byTestId(page, 'execution.progress')).toHaveAttribute('aria-valuenow', '40');
    await expect(byTestId(page, 'execution.logEntry')).toHaveCount(3);
    await expectNoPageOverflow(page);
    await capture(page, 'execution-running-1440x900.png');

    await factory.finishExecution(execution.id, 'success');
    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'completed',
    );
    await expect(byTestId(page, 'execution.logLiveStatus')).toContainText('Stream complete');
    await expectNoPageOverflow(page);
    await capture(page, 'execution-completed-1440x900.png');
  });

  test('project list, unverified binding, and project form are captured', async ({
    page,
    request,
  }) => {
    const factory = await resetDefault(request);
    await waitForFakeRunner(factory);

    const project = await factory.createProject({
      key: 'VIS',
      name: 'Visual Repository Project',
      description: 'A project with one unverified repository binding.',
      defaultBranch: 'main',
    });
    await factory.createProjectBinding(project.id, {
      computerId: 'computer_local',
      path: process.cwd(),
    });

    await gotoRoute(page, 'projects');
    await expect(byTestId(page, 'projects.page')).toBeVisible();
    await expect(byTestId(page, 'projects.card')).toHaveCount(2);
    await expectNoPageOverflow(page);
    await capture(page, 'projects-1440x900.png');

    await gotoPath(page, `/projects?project=${project.id}`);
    await expect(byTestId(page, 'projectDetail.panel')).toBeVisible();
    await expect(byTestId(page, 'projectBindings.row')).toHaveAttribute(
      'data-binding-status',
      'unverified',
    );
    await expect(byTestId(page, 'projectBindings.row')).toContainText('Never validated');
    await expectNoPageOverflow(page);
    await capture(page, 'project-detail-1440x900.png');

    await page.keyboard.press('Escape');
    await byTestId(page, 'projects.create').click();
    await expect(byTestId(page, 'projectForm.dialog')).toBeVisible();
    await capture(page, 'create-project-dialog-1440x900.png');
  });
});
