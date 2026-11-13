import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { guardPathFor, type ProcessGuardRecord } from '../src/process-guard';
import {
  assertGuardPathAvailable,
  readValidatedStartingGuard,
} from '../src/process-supervisor-guard';
import {
  spawnSupervisedProcess,
  type SupervisedProcess,
  type SupervisorLaunchSpec,
} from '../src/supervised-process';

const roots: string[] = [];
const managedProcesses: SupervisedProcess[] = [];
const cliFixture = join(__dirname, 'fixtures', 'real-cli.cjs');

function unique(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'haft-posix-guard-'));
  roots.push(root);
  return root;
}

function guardRecord(overrides: Partial<ProcessGuardRecord> = {}): ProcessGuardRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    executionId: 'execution_guard_validation',
    launchToken: 'token-guard-validation',
    parentPid: process.pid,
    supervisorPid: 4321,
    supervisorStartTime: 'start-supervisor',
    processGroupId: 4321,
    cgroupPath: null,
    cliPid: null,
    cliStartTime: null,
    isolation: 'posix-group',
    state: 'starting',
    jobCreated: true,
    treeConfirmedGone: false,
    exitCode: null,
    signal: null,
    detail: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function writeGuard(path: string, guard: ProcessGuardRecord): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(guard, null, 2)}\n`, 'utf8');
}

function makeSpec(root: string, executionId: string, launchToken: string): SupervisorLaunchSpec {
  return {
    command: process.execPath,
    args: [],
    cwd: process.cwd(),
    env: { ...process.env },
    executionId,
    launchToken,
    recoveryRoot: root,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  for (const managed of managedProcesses.splice(0)) {
    await managed.terminate(true, 200).catch(() => undefined);
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('POSIX starting-guard validation (N-1 unit)', () => {
  it('accepts only the exact regular starting guard written by this supervisor', async () => {
    const root = await makeRoot();
    const guard = guardRecord();
    const path = join(root, 'guards', 'valid.guard.json');
    await writeGuard(path, guard);

    const result = readValidatedStartingGuard(path, guard);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.guard.launchToken).toBe(guard.launchToken);
  });

  it('rejects a directory', async () => {
    const root = await makeRoot();
    const path = join(root, 'guards', 'directory.guard.json');
    await mkdir(path, { recursive: true });

    const result = readValidatedStartingGuard(path, guardRecord());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not a regular file');
  });

  it.skipIf(process.platform === 'win32')('rejects a symbolic link', async () => {
    const root = await makeRoot();
    const target = join(root, 'guards', 'target.json');
    const path = join(root, 'guards', 'link.guard.json');
    await writeGuard(target, guardRecord());
    await symlink(target, path);

    const result = readValidatedStartingGuard(path, guardRecord());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('symbolic link');
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without blocking', async () => {
    const root = await makeRoot();
    const path = join(root, 'guards', 'fifo.guard.json');
    await mkdir(join(path, '..'), { recursive: true });
    execFileSync('mkfifo', [path]);

    const startedAt = Date.now();
    const result = readValidatedStartingGuard(path, guardRecord());

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not a regular file');
  });

  it('rejects an empty guard file', async () => {
    const root = await makeRoot();
    const path = join(root, 'guards', 'empty.guard.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '', 'utf8');

    const result = readValidatedStartingGuard(path, guardRecord());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not valid JSON');
  });

  it('rejects damaged guard JSON', async () => {
    const root = await makeRoot();
    const path = join(root, 'guards', 'damaged.guard.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '{"version":1', 'utf8');

    const result = readValidatedStartingGuard(path, guardRecord());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not valid JSON');
  });

  it('rejects valid JSON that is not a structurally valid guard', async () => {
    const root = await makeRoot();
    const path = join(root, 'guards', 'structure.guard.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ version: 1, executionId: 'execution_guard_validation' }),
      'utf8',
    );

    const result = readValidatedStartingGuard(path, guardRecord());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('structural validation');
  });

  it.each([
    ['executionId', { executionId: 'execution_other' }],
    ['launchToken', { launchToken: 'token-other' }],
    ['supervisorPid', { supervisorPid: 9999 }],
    ['state', { state: 'running' as const }],
  ])('rejects a mismatched %s', async (_field, override) => {
    const root = await makeRoot();
    const expected = guardRecord();
    const path = join(root, 'guards', 'mismatch.guard.json');
    await writeGuard(path, guardRecord(override));

    const result = readValidatedStartingGuard(path, expected);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('does not belong to this supervisor launch');
  });

  it('validates the opened descriptor even if the path is replaced during validation', async () => {
    const root = await makeRoot();
    const expected = guardRecord();
    const path = join(root, 'guards', 'replace.guard.json');
    await writeGuard(path, expected);
    const replacement = guardRecord({
      launchToken: 'token-replacement',
      supervisorPid: 7777,
    });

    const result = readValidatedStartingGuard(path, expected, {
      afterOpen: () => {
        unlinkSync(path);
        writeFileSync(path, `${JSON.stringify(replacement, null, 2)}\n`, 'utf8');
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.guard.launchToken).toBe(expected.launchToken);
  });

  it('refuses pre-existing regular-file and directory guard paths before startup', async () => {
    const root = await makeRoot();
    const file = join(root, 'file.guard.json');
    const directory = join(root, 'directory.guard.json');
    await writeFile(file, 'stale', 'utf8');
    await mkdir(directory, { recursive: true });

    expect(() => assertGuardPathAvailable(file)).toThrow(/already exists/);
    expect(() => assertGuardPathAvailable(directory)).toThrow(/already exists/);
    expect(() => assertGuardPathAvailable(join(root, 'missing.guard.json'))).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses pre-existing symbolic-link and FIFO guard paths before startup',
    async () => {
      const root = await makeRoot();
      const link = join(root, 'link.guard.json');
      const fifo = join(root, 'fifo.guard.json');
      await writeFile(join(root, 'target.json'), '{}', 'utf8');
      symlinkSync(join(root, 'target.json'), link);
      execFileSync('mkfifo', [fifo]);

      expect(() => assertGuardPathAvailable(link)).toThrow(/already exists/);
      expect(() => assertGuardPathAvailable(fifo)).toThrow(/already exists/);
    },
  );
});

describe.skipIf(process.platform === 'win32')('POSIX supervisor launch guard (N-1)', () => {
  const blockedKinds = ['directory', 'symbolic link', 'FIFO', 'empty file'] as const;
  for (const kind of blockedKinds) {
    it(`IR7: a ${kind} at the guard path blocks the CLI spawn`, async () => {
      const root = await makeRoot();
      const executionId = unique('execution');
      const launchToken = unique('token');
      const marker = unique('marker');
      const cliOut = join(root, 'artifacts', `cli-${marker}.json`);
      await mkdir(join(root, 'artifacts'), { recursive: true });
      const guardPath = guardPathFor(root, executionId, launchToken);
      await mkdir(join(guardPath, '..'), { recursive: true });
      if (kind === 'directory') {
        await mkdir(guardPath, { recursive: true });
      } else if (kind === 'symbolic link') {
        const target = join(root, 'guard-target.json');
        await writeFile(target, '{}\n', 'utf8');
        await symlink(target, guardPath);
      } else if (kind === 'FIFO') {
        execFileSync('mkfifo', [guardPath]);
      } else {
        await writeFile(guardPath, '', 'utf8');
      }

      const managed = await spawnSupervisedProcess({
        ...makeSpec(root, executionId, launchToken),
        command: process.execPath,
        args: [cliFixture, marker, cliOut, '0', 'none', '500'],
        env: { ...process.env, HAFT_TEST_MARKER: marker },
      });
      managedProcesses.push(managed);

      await expect(managed.ready).rejects.toThrow(/PROCESS_SUPERVISOR_(EXITED|FAILED)/);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(existsSync(cliOut)).toBe(false);
      expect(existsSync(join(guardPath, '..', 'artifacts', `cli-${marker}.json`))).toBe(false);
    });
  }

  it('leaves a normal POSIX launch unaffected', async () => {
    const root = await makeRoot();
    const executionId = unique('execution');
    const launchToken = unique('token');
    const marker = unique('marker');
    const cliOut = join(root, 'artifacts', `cli-${marker}.json`);
    await mkdir(join(root, 'artifacts'), { recursive: true });
    const guardPath = guardPathFor(root, executionId, launchToken);

    const managed = await spawnSupervisedProcess({
      ...makeSpec(root, executionId, launchToken),
      command: process.execPath,
      args: [cliFixture, marker, cliOut, '0', guardPath, '0'],
      env: { ...process.env, HAFT_TEST_MARKER: marker },
    });
    managedProcesses.push(managed);

    const guard = await managed.ready;
    expect(guard.state).toBe('running');
    expect(guard.executionId).toBe(executionId);
    expect(guard.launchToken).toBe(launchToken);
    expect(guard.supervisorPid).toBe(managed.child.pid);
    expect(guard.cliPid).toEqual(expect.any(Number));

    await waitFor(() => existsSync(cliOut));
    const cliState = JSON.parse(await readFile(cliOut, 'utf8')) as {
      marker: string;
      guardPresent: boolean | null;
    };
    expect(cliState.marker).toBe(marker);
    expect(cliState.guardPresent).toBe(true);

    const termination = await managed.terminate(true, 5000);
    expect(termination.requested).toBe(true);
  }, 30_000);
});
