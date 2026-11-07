import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectProcess,
  isProcessAlive,
  terminateProcessTree,
  waitForProcessExit,
} from '../src/process-identity';

const children: Array<ReturnType<typeof spawn>> = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && isProcessAlive(child.pid)) {
      await terminateProcessTree(child.pid);
    }
    child.removeAllListeners();
  }
});

describe('process identity', () => {
  it('captures a start marker and command line for a live process', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => undefined, 60000)'],
      {
        stdio: 'ignore',
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    children.push(child);
    expect(child.pid).toBeTruthy();
    await waitFor(() => isProcessAlive(child.pid as number), 5000);

    const identity = await inspectProcess(child.pid as number);
    expect(identity).toMatchObject({
      pid: child.pid,
      processGroupId: process.platform === 'win32' ? child.pid : child.pid,
    });
    expect(identity?.startTime).toBeTruthy();
    expect(identity?.commandLine ?? '').toContain(process.execPath.split(/[\\/]/).pop() as string);

    // A different start marker means the PID was reused and must not be trusted.
    expect(await inspectProcess(999_999_999)).toBeNull();
  }, 20_000);

  it('returns false when a process does not exit before the timeout', async () => {
    const exited = await waitForProcessExit(process.pid, 120, 20);
    expect(exited).toBe(false);
  });

  it('terminates a process tree and confirms the exit', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => undefined, 60000)'],
      {
        stdio: 'ignore',
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    children.push(child);
    await waitFor(() => isProcessAlive(child.pid as number), 5000);

    await terminateProcessTree(child.pid as number);
    expect(await waitForProcessExit(child.pid as number, 8000)).toBe(true);
  }, 20_000);
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  if (!condition()) throw new Error('condition not met before timeout');
}
