import { test, expect } from '../../fixtures';
import { expectSuccessToast, gotoPath, taskCard, waitForBoard } from '../../support/app';
import { E2E_COMPUTER_ID, E2E_REPOSITORY_PATH, waitForFakeRunner } from '../../support/repository';
import { bySelector, byTestId } from '../../support/ui-contract';

test.describe('Project repository bindings', () => {
  test('creates a project, validates a binding, and runs a Fake Runner task end to end', async ({
    page,
    factory,
  }) => {
    await waitForFakeRunner(factory);
    const agent = await factory.createAgent({
      name: factory.uniqueName('Binding Runner Agent'),
      runtime: 'codex',
      computerId: E2E_COMPUTER_ID,
    });
    const projectName = factory.uniqueName('Bound Project');
    const taskTitle = factory.uniqueName('Bound repository execution');

    // 1. Open Haft and create the project through the UI with its metadata.
    await gotoPath(page, '/');
    await bySelector(page, 'shell.navProjects').click();
    await expect(byTestId(page, 'projects.page')).toBeVisible();
    await byTestId(page, 'projects.create').click();
    await expect(byTestId(page, 'projectForm.dialog')).toBeVisible();
    await byTestId(page, 'projectForm.key').fill('BIND');
    await byTestId(page, 'projectForm.name').fill(projectName);
    await byTestId(page, 'projectForm.description').fill(
      'Proves the project to repository binding to Fake Runner execution loop.',
    );
    await byTestId(page, 'projectForm.repoUrl').fill('git@github.com:org/e2e-binding.git');
    await byTestId(page, 'projectForm.defaultBranch').fill('main');
    await byTestId(page, 'projectForm.submit').click();

    await expectSuccessToast(page, 'Project created');
    await expect(byTestId(page, 'projectForm.dialog')).toHaveCount(0);
    await expect(byTestId(page, 'projectDetail.panel')).toBeVisible();
    await expect(byTestId(page, 'projectDetail.panel')).toContainText(
      'git@github.com:org/e2e-binding.git',
    );
    await expect(byTestId(page, 'projectDetail.panel')).toContainText('main');

    const project = (await factory.listProjects()).items.find((item) => item.name === projectName);
    expect(project, 'The UI must persist the project').toBeDefined();
    if (!project) return;
    expect(project.key).toBe('BIND');
    expect(project.repoUrl).toBe('git@github.com:org/e2e-binding.git');
    expect(project.defaultBranch).toBe('main');
    expect(project.archivedAt).toBeNull();

    // 2. Bind the computer path and let the real Fake Runner validate it.
    await expect(byTestId(page, 'projectBindings.empty')).toBeVisible();
    await byTestId(page, 'projectBindings.create').click();
    await expect(byTestId(page, 'bindingForm.dialog')).toBeVisible();
    await byTestId(page, 'bindingForm.computer').selectOption(E2E_COMPUTER_ID);
    await byTestId(page, 'bindingForm.path').fill(E2E_REPOSITORY_PATH);
    await byTestId(page, 'bindingForm.submit').click();
    await expectSuccessToast(page, 'Repository binding created');

    const bindingRow = byTestId(page, 'projectBindings.row');
    await expect(bindingRow).toHaveAttribute('data-binding-status', 'unverified');
    await expect(bindingRow).toContainText(E2E_REPOSITORY_PATH);

    await byTestId(page, 'projectBindings.validate').click();
    await expectSuccessToast(page, 'Repository validated');
    await expect(bindingRow).toHaveAttribute('data-binding-status', 'ready', { timeout: 30_000 });
    await expect(bindingRow).toContainText('Last checked');
    await expect(bindingRow).toContainText('HEAD');
    await expect(byTestId(page, 'projectBindings.validationError')).toHaveCount(0);

    const validated = await factory.getProject(project.id);
    const binding = validated.bindings.find((item) => item.computerId === E2E_COMPUTER_ID);
    expect(binding).toBeDefined();
    if (!binding) return;
    expect(binding.status).toBe('ready');
    expect(binding.bindingVersion).toBe(1);
    expect(binding.validatedBindingVersion).toBe(1);
    expect(binding.canonicalPath).toBeTruthy();
    expect(binding.headCommit).toMatch(/^[0-9a-f]{7,64}$/);
    expect(binding.policyVersion).toBeTruthy();
    expect(binding.lastValidatedAt).not.toBeNull();
    expect(binding.validationErrorCode).toBeNull();

    await byTestId(page, 'dialog.close').click();

    // 3. Create a task against the new project through the UI.
    await bySelector(page, 'shell.navTasks').click();
    await waitForBoard(page);
    await byTestId(page, 'tasks.create').click();
    await byTestId(page, 'taskForm.title').fill(taskTitle);
    await byTestId(page, 'taskForm.description').fill(
      'Run the deterministic Fake Runner inside the validated repository binding.',
    );
    await byTestId(page, 'taskForm.project').selectOption(project.id);
    await byTestId(page, 'taskForm.assignee').selectOption(agent.id);
    await byTestId(page, 'taskForm.priority').selectOption('high');
    await byTestId(page, 'taskForm.submit').click();

    await expectSuccessToast(page, 'Task created');
    await expect(taskCard(page, taskTitle)).toHaveAttribute('data-status', 'claimed');
    const createdTask = (await factory.listTasks()).items.find((item) => item.title === taskTitle);
    expect(createdTask?.projectId).toBe(project.id);

    // 4. Execute through the Fake Runner and observe live logs to completion.
    await taskCard(page, taskTitle).click();
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();
    await expect(byTestId(page, 'taskDetail.startHint')).toHaveCount(0);
    await expect(byTestId(page, 'taskDetail.start')).toBeEnabled();
    await byTestId(page, 'taskDetail.start').click();

    await page.waitForURL(/\/executions\/[^/?]+$/);
    const executionId = page.url().split('/').pop() as string;
    const banner = byTestId(page, 'execution.statusBanner');
    await expect(banner).toHaveAttribute('data-status', 'running');
    await expect(
      byTestId(page, 'execution.logEntry').filter({
        hasText: 'Fake runner accepted codex execution.',
      }),
    ).toHaveCount(1);
    await expect(banner).toHaveAttribute('data-status', 'completed', { timeout: 20_000 });
    await expect(byTestId(page, 'execution.progress')).toHaveAttribute('aria-valuenow', '100');

    const execution = await factory.getExecution(executionId);
    expect(execution.status).toBe('completed');
    expect(execution.repositoryProjectId).toBe(project.id);
    expect(execution.repositoryBindingId).toBe(binding.id);
    expect(execution.repositoryBindingVersion).toBe(binding.bindingVersion);
    expect(execution.repositoryDefaultBranch).toBe('main');
    const logs = await factory.getExecutionLogs(executionId);
    expect(
      logs.items.some((entry) =>
        entry.message.includes('Fake runner completed all simulated steps.'),
      ),
    ).toBe(true);

    // 5. Reload the execution and prove persistence across navigation.
    await page.reload();
    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'completed',
    );
    expect((await factory.getTask(createdTask?.id ?? '')).status).toBe('done');

    await gotoPath(page, `/projects?project=${project.id}`);
    await expect(byTestId(page, 'projectDetail.panel')).toBeVisible();
    await expect(byTestId(page, 'projectBindings.row')).toHaveAttribute(
      'data-binding-status',
      'ready',
    );
    await expect(byTestId(page, 'projectBindings.row')).toContainText('Last checked');
    await byTestId(page, 'dialog.close').click();

    const refreshed = await factory.getProject(project.id);
    expect(refreshed.taskCount).toBe(1);
    expect(refreshed.executionCount).toBe(1);
    expect(refreshed.defaultBranch).toBe('main');
    const projectCard = bySelector(page, 'projects.card', { name: projectName });
    await expect(byTestId(projectCard, 'projects.taskCount')).toHaveText('1 tasks');
    await expect(byTestId(projectCard, 'projects.executionCount')).toHaveText('1 runs');

    await gotoPath(page, `/tasks?task=${createdTask?.id}`);
    await expect(byTestId(page, 'taskDetail.panel')).toContainText(projectName);
    await expect(byTestId(page, 'taskDetail.start')).toBeDisabled();
  });
});
