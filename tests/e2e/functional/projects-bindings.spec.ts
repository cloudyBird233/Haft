import { test, expect } from '../../fixtures';
import { expectSuccessToast, gotoPath, taskCard, waitForBoard } from '../../support/app';
import { E2E_COMPUTER_ID, waitForFakeRunner } from '../../support/repository';
import { bySelector, byTestId } from '../../support/ui-contract';

test.describe('Project repository bindings', () => {
  test('creates an unverified binding and blocks real execution explicitly', async ({
    page,
    factory,
  }) => {
    await waitForFakeRunner(factory);
    const agent = await factory.createAgent({
      name: factory.uniqueName('Unverified Binding Agent'),
      runtime: 'codex',
      computerId: E2E_COMPUTER_ID,
    });
    const projectName = factory.uniqueName('Unverified Project');
    const taskTitle = factory.uniqueName('Blocked repository execution');
    const bindingPath = 'C:\\work\\haft-unverified-e2e';

    // 1. Create a P2-01 project through the UI. Project metadata is limited to
    // key/name/description/defaultBranch/color; repoUrl is outside P2-01 scope.
    await gotoPath(page, '/');
    await bySelector(page, 'shell.navProjects').click();
    await expect(byTestId(page, 'projects.page')).toBeVisible();
    await byTestId(page, 'projects.create').click();
    await expect(byTestId(page, 'projectForm.dialog')).toBeVisible();
    await expect(page.getByTestId('project-repo-url-input')).toHaveCount(0);
    await byTestId(page, 'projectForm.key').fill('UNV');
    await byTestId(page, 'projectForm.name').fill(projectName);
    await byTestId(page, 'projectForm.description').fill(
      'Proves that P2-01 stops at an unverified repository binding.',
    );
    await byTestId(page, 'projectForm.defaultBranch').fill('main');
    await byTestId(page, 'projectForm.submit').click();

    await expectSuccessToast(page, 'Project created');
    await expect(byTestId(page, 'projectForm.dialog')).toHaveCount(0);
    await expect(byTestId(page, 'projectDetail.panel')).toBeVisible();
    await expect(byTestId(page, 'projectDetail.panel')).toContainText('main');

    const project = (await factory.listProjects()).items.find((item) => item.name === projectName);
    expect(project, 'The UI must persist the project').toBeDefined();
    if (!project) return;
    expect(project.key).toBe('UNV');
    expect(project.defaultBranch).toBe('main');
    expect(project.archivedAt).toBeNull();
    expect(project).not.toHaveProperty('repoUrl');

    // 2. Create the binding. P2-01 always starts at `unverified`, exposes no
    // Validate action, and never calls the Runner itself.
    await expect(byTestId(page, 'projectBindings.empty')).toBeVisible();
    await byTestId(page, 'projectBindings.create').click();
    await expect(byTestId(page, 'bindingForm.dialog')).toBeVisible();
    await byTestId(page, 'bindingForm.computer').selectOption(E2E_COMPUTER_ID);
    await byTestId(page, 'bindingForm.path').fill(bindingPath);
    await byTestId(page, 'bindingForm.submit').click();
    await expectSuccessToast(page, 'Repository binding created');

    const bindingRow = byTestId(page, 'projectBindings.row');
    await expect(bindingRow).toHaveAttribute('data-binding-status', 'unverified');
    await expect(bindingRow).toContainText(bindingPath);
    await expect(bindingRow).toContainText('Never validated');
    await expect(byTestId(page, 'projectBindings.validationError')).toHaveCount(0);
    await expect(page.getByTestId('binding-validate-button')).toHaveCount(0);

    const validated = await factory.getProject(project.id);
    const binding = validated.bindings.find((item) => item.computerId === E2E_COMPUTER_ID);
    expect(binding).toBeDefined();
    if (!binding) return;
    expect(binding.status).toBe('unverified');
    expect(binding.bindingVersion).toBe(1);
    expect(binding.validatedBindingVersion).toBeNull();
    expect(binding.canonicalPath).toBeNull();
    expect(binding.lastValidatedAt).toBeNull();

    await byTestId(page, 'dialog.close').click();

    // 3. Create a task against the project and assign the Codex agent.
    await bySelector(page, 'shell.navTasks').click();
    await waitForBoard(page);
    await byTestId(page, 'tasks.create').click();
    await byTestId(page, 'taskForm.title').fill(taskTitle);
    await byTestId(page, 'taskForm.description').fill(
      'The API must reject this real execution while the binding is unverified.',
    );
    await byTestId(page, 'taskForm.project').selectOption(project.id);
    await byTestId(page, 'taskForm.assignee').selectOption(agent.id);
    await byTestId(page, 'taskForm.priority').selectOption('high');
    await byTestId(page, 'taskForm.submit').click();

    await expectSuccessToast(page, 'Task created');
    await expect(taskCard(page, taskTitle)).toHaveAttribute('data-status', 'claimed');
    const createdTask = (await factory.listTasks()).items.find((item) => item.title === taskTitle);
    expect(createdTask?.projectId).toBe(project.id);

    // 4. The task detail must explain the block instead of offering execution.
    await taskCard(page, taskTitle).click();
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();
    await expect(byTestId(page, 'taskDetail.start')).toBeDisabled();
    await expect(byTestId(page, 'taskDetail.startHint')).toContainText(
      'Repository binding: Unverified',
    );
    await expect(byTestId(page, 'taskDetail.startHint')).toContainText(
      'P2-02 repository validation is required',
    );
    await expect(bySelector(page, 'taskDetail.projectBindingLink')).toHaveAttribute(
      'href',
      `/projects?project=${project.id}`,
    );

    const untouched = await factory.getTask(createdTask.id);
    expect(untouched.status).toBe('claimed');
    expect(untouched.executions).toHaveLength(0);
    expect(untouched.latestExecution).toBeNull();

    // 5. The project list reflects the task but no execution.
    await byTestId(page, 'dialog.close').click();
    await gotoPath(page, `/projects?project=${project.id}`);
    await expect(byTestId(page, 'projectDetail.panel')).toBeVisible();
    await expect(byTestId(page, 'projectBindings.row')).toHaveAttribute(
      'data-binding-status',
      'unverified',
    );
    await byTestId(page, 'dialog.close').click();

    const refreshed = await factory.getProject(project.id);
    expect(refreshed.taskCount).toBe(1);
    expect(refreshed.executionCount).toBe(0);
    expect(refreshed.defaultBranch).toBe('main');
    const projectCard = bySelector(page, 'projects.card', { name: projectName });
    await expect(byTestId(projectCard, 'projects.taskCount')).toHaveText('1 tasks');
    await expect(byTestId(projectCard, 'projects.executionCount')).toHaveText('0 runs');
  });
});
