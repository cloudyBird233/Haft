/**
 * Starts one real supervised CLI and then acts as the "previous runner" that
 * can be killed by a test. It writes the same durable journal shape as
 * RealExecutor: intent first (pid null), then the supervisor identity.
 *
 * Required environment:
 *   HAFT_TEST_RECOVERY_ROOT  recovery root
 *   HAFT_TEST_EXECUTION_ID   unique execution id
 *   HAFT_TEST_LAUNCH_TOKEN   unique launch token
 *   HAFT_TEST_MARKER         unique process marker
 *   HAFT_TEST_CLI_OUT        marker JSON written by the CLI fixture
 *   HAFT_TEST_RUNNER_OUT     marker JSON written by this fixture
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExecutionJournal } from '../../src/execution-journal';
import { inspectProcess } from '../../src/process-identity';
import { guardPathFor, type ProcessGuardRecord } from '../../src/process-guard';
import { spawnSupervisedProcess } from '../../src/supervised-process';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function holdOpen(): void {
  process.stdin.resume();
  process.stdin.on('data', () => undefined);
  setInterval(() => undefined, 1000);
}

async function main(): Promise<void> {
  const recoveryRoot = required('HAFT_TEST_RECOVERY_ROOT');
  const executionId = required('HAFT_TEST_EXECUTION_ID');
  const launchToken = required('HAFT_TEST_LAUNCH_TOKEN');
  const marker = required('HAFT_TEST_MARKER');
  const cliOut = required('HAFT_TEST_CLI_OUT');
  const runnerOut = required('HAFT_TEST_RUNNER_OUT');
  const cliFixture = join(__dirname, 'real-cli.cjs');
  const guardPath = guardPathFor(recoveryRoot, executionId, launchToken);

  const writeRunnerMarker = async (guard: ProcessGuardRecord): Promise<void> => {
    await writeFile(
      runnerOut,
      JSON.stringify({
        marker,
        runnerPid: process.pid,
        supervisorPid: guard.supervisorPid,
        cliPid: guard.cliPid,
        guardPath,
      }),
      'utf8',
    );
  };

  const skipIdentity = process.env.HAFT_TEST_SKIP_IDENTITY === '1';
  const withGrandchild = process.env.HAFT_TEST_WITH_GRANDCHILD !== '0';
  const journal = new ExecutionJournal(recoveryRoot);
  const now = new Date().toISOString();
  await journal.begin({
    version: 1,
    executionId,
    runtime: 'codex',
    projectId: 'project_fixture',
    pid: null,
    processStartTime: null,
    processGroupId: null,
    worktreePath: null,
    branchName: null,
    baseCommit: null,
    phase: 'preparing',
    status: 'active',
    lastSequence: 0,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    launchToken,
    guardPath,
    supervisorPid: null,
    supervisorStartTime: null,
    cliPid: null,
    cliStartTime: null,
    processKind: 'supervisor',
    spawnState: 'intent',
    recoveryBlockedReason: null,
    recoveryBlockedAt: null,
    recoveryNote: null,
  });

  const supervised = await spawnSupervisedProcess({
    command: process.execPath,
    args: [cliFixture, marker, cliOut, withGrandchild ? '1' : '0', guardPath],
    cwd: process.cwd(),
    env: { ...process.env, HAFT_TEST_MARKER: marker },
    executionId,
    launchToken,
    recoveryRoot,
  });
  const guard = await supervised.ready;
  if (skipIdentity) {
    // Simulates a runner crash after the supervisor created the CLI but before
    // it could persist any process identity. Recovery must rely on the guard.
    await writeRunnerMarker(guard);
    holdOpen();
    return;
  }
  const supervisorIdentity = await inspectProcess(guard.supervisorPid);
  if (!supervisorIdentity) {
    throw new Error(`supervisor PID ${guard.supervisorPid} has no identity`);
  }

  await journal.update(
    executionId,
    {
      pid: guard.supervisorPid,
      processStartTime: supervisorIdentity.startTime,
      processGroupId: guard.processGroupId,
      supervisorPid: guard.supervisorPid,
      supervisorStartTime: guard.supervisorStartTime,
      cliPid: guard.cliPid,
      cliStartTime: guard.cliStartTime,
      processKind: 'supervisor',
      spawnState: 'running',
      phase: 'running',
    },
    { immediate: true },
  );

  await writeRunnerMarker(guard);

  holdOpen();
}

main().catch((error: unknown) => {
  process.stderr.write(`supervised-runner fixture failed: ${String(error)}\n`);
  process.exit(1);
});
