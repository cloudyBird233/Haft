import { test, expect } from '../../fixtures';
import {
  agentCard,
  expectSuccessToast,
  gotoRoute,
  openAgent,
  taskCard,
  waitForAgentList,
  waitForBoard,
} from '../../support/app';
import { bySelector, byTestId } from '../../support/ui-contract';

test.describe('agents functional flows', () => {
  test('creates an agent through the keyboard-accessible dialog and persists it', async ({
    page,
    factory,
  }) => {
    await gotoRoute(page, 'agents');
    await waitForAgentList(page);
    await expect(byTestId(page, 'agents.card')).toHaveCount(3);

    const createButton = bySelector(page, 'agents.create');
    await createButton.click();
    const dialog = byTestId(page, 'agentForm.dialog');
    await expect(dialog).toBeVisible();
    await expect(byTestId(page, 'agentForm.name')).toBeFocused();

    const name = factory.uniqueName('Nova');
    await byTestId(page, 'agentForm.name').fill(name);
    await byTestId(page, 'agentForm.role').fill('Release Steward');
    await byTestId(page, 'agentForm.description').fill(
      'Owns release readiness, rollout checks, and post-deploy verification.',
    );
    await byTestId(page, 'agentForm.runtime').selectOption('mock');
    await byTestId(page, 'agentForm.computer').selectOption('computer_local');
    await byTestId(page, 'agentForm.submit').click();

    await expect(dialog).toHaveCount(0);
    await expectSuccessToast(page, 'Agent created');
    const card = agentCard(page, name);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-status', 'idle');

    const stored = (await factory.listAgents()).items.find((agent) => agent.name === name);
    expect(stored).toBeDefined();
    expect(stored).toMatchObject({
      name,
      role: 'Release Steward',
      runtime: 'mock',
      status: 'idle',
      computerId: 'computer_local',
    });

    await createButton.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('filters agents by search and status, including the empty filter state', async ({
    page,
    factory,
  }) => {
    await factory.setAgentStatus('agent_qa', 'offline');
    await gotoRoute(page, 'agents');
    await waitForAgentList(page);

    const search = byTestId(page, 'agents.search');
    await search.fill('Architect');
    await expect(byTestId(page, 'agents.card')).toHaveCount(1);
    await expect(agentCard(page, 'Architect')).toBeVisible();

    await search.fill('');
    await byTestId(page, 'agents.statusFilter').selectOption('offline');
    await expect(byTestId(page, 'agents.card')).toHaveCount(1);
    await expect(agentCard(page, 'QA Engineer')).toBeVisible();
    await expect(agentCard(page, 'QA Engineer')).toHaveAttribute('data-status', 'offline');

    await search.fill('does-not-exist');
    await expect(byTestId(page, 'agents.filterEmpty')).toBeVisible();
    await byTestId(page, 'agents.clearFilters').click();
    await expect(byTestId(page, 'agents.card')).toHaveCount(3);
    await expect(byTestId(page, 'agents.count')).toHaveText('3 total');
  });

  test('shows agent profile, current task, and execution history', async ({ page }) => {
    await gotoRoute(page, 'agents');
    await waitForAgentList(page);

    const developerPanel = await openAgent(page, 'Developer');
    await expect(developerPanel).toContainText('Full-stack Engineer');
    await expect(byTestId(page, 'agentDetail.executionHistory')).toBeVisible();
    await expect(byTestId(page, 'agentDetail.executionRow').first()).toContainText(
      'Scaffold the Raft Lite workspace shell',
    );

    await page.keyboard.press('Escape');
    await expect(developerPanel).toHaveCount(0);

    const architectPanel = await openAgent(page, 'Architect');
    await expect(byTestId(page, 'agentDetail.currentTask')).toContainText(
      'Review runtime adapter boundaries',
    );
    await expect(architectPanel).toContainText('System Architect');
  });

  test('edits an agent and persists the new role and status', async ({ page, factory }) => {
    await gotoRoute(page, 'agents');
    await waitForAgentList(page);
    await openAgent(page, 'QA Engineer');

    await byTestId(page, 'agentDetail.edit').click();
    const dialog = byTestId(page, 'agentForm.dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Edit agent');
    await expect(byTestId(page, 'agentForm.name')).toHaveValue('QA Engineer');

    await byTestId(page, 'agentForm.role').fill('Quality Lead');
    await byTestId(page, 'agentForm.status').selectOption('offline');
    await byTestId(page, 'agentForm.submit').click();

    await expectSuccessToast(page, 'Agent updated');
    await expect(byTestId(page, 'agentDetail.panel')).toBeVisible();
    await expect(agentCard(page, 'QA Engineer')).toHaveAttribute('data-status', 'offline');

    const stored = await factory.getAgent('agent_qa');
    expect(stored.role).toBe('Quality Lead');
    expect(stored.status).toBe('offline');
  });

  test('deletes an agent through the confirmation dialog and removes it from the list', async ({
    page,
    factory,
  }) => {
    await gotoRoute(page, 'agents');
    await waitForAgentList(page);
    await openAgent(page, 'Architect');

    await byTestId(page, 'agentDetail.delete').click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Delete Architect?');
    await byTestId(page, 'agentDelete.confirm').click();

    await expectSuccessToast(page, 'Agent deleted');
    await expect(agentCard(page, 'Architect')).toHaveCount(0);
    await expect(byTestId(page, 'agentDetail.panel')).toHaveCount(0);
    await expect
      .poll(async () => (await factory.listAgents()).items.map((agent) => agent.id))
      .not.toContain('agent_architect');

    const resetTask = await factory.getTask('task_arch_review');
    expect(resetTask).toMatchObject({ status: 'todo', assignee: null });

    await byTestId(page, 'shell.navTasks').click();
    await waitForBoard(page);
    await expect(taskCard(page, 'Review runtime adapter boundaries')).toHaveAttribute(
      'data-status',
      'todo',
    );
    let notFound: unknown;
    try {
      await factory.getAgent('agent_architect');
    } catch (error) {
      notFound = error;
    }
    expect(String(notFound)).toContain('AGENT_NOT_FOUND');
  });

  test('unassigns a deleted agent active tasks and closes the detail drawer', async ({
    page,
    factory,
  }) => {
    const agent = await factory.createAgent({ name: factory.uniqueName('Removable Agent') });
    const task = await factory.createTask({
      title: factory.uniqueName('Task owned by a removable agent'),
      assigneeAgentId: agent.id,
    });

    await gotoRoute(page, 'agents');
    await waitForAgentList(page);
    await openAgent(page, agent.name);
    await byTestId(page, 'agentDetail.delete').click();
    await byTestId(page, 'agentDelete.confirm').click();

    await expectSuccessToast(page, 'Agent deleted');
    await expect(byTestId(page, 'agentDetail.panel')).toHaveCount(0);
    await expect.poll(async () => (await factory.getTask(task.id)).status).toBe('todo');
    const stored = await factory.getTask(task.id);
    expect(stored.assignee).toBeNull();

    await byTestId(page, 'shell.navTasks').click();
    await waitForBoard(page);
    await expect(taskCard(page, task.title)).toHaveAttribute('data-status', 'todo');
  });

  test('shows the roster empty state when no agents exist and opens the create dialog', async ({
    page,
    factory,
  }) => {
    const agents = (await factory.listAgents()).items;
    for (const agent of agents) {
      await factory.deleteAgent(agent.id);
    }

    await gotoRoute(page, 'agents');
    await expect(byTestId(page, 'agents.empty')).toBeVisible();
    await byTestId(page, 'agents.emptyCreate').click();
    await expect(byTestId(page, 'agentForm.dialog')).toBeVisible();
    await byTestId(page, 'agentForm.cancel').click();
    await expect(byTestId(page, 'agentForm.dialog')).toHaveCount(0);
    await expect(byTestId(page, 'agents.empty')).toBeVisible();
  });
});
