#!/usr/bin/env node
/*
 * Real OS fixture used by the runner recovery-hardening tests.
 *
 * It writes a marker JSON as soon as it starts, optionally spawns a grandchild
 * that stays alive, and then waits until it is killed (or exits after a
 * requested delay). Nothing about this fixture is mocked: the supervisor must
 * terminate the real process tree.
 *
 * Usage: real-cli.cjs <marker> <out-path> <with-grandchild> [guard-path] [exit-after-ms]
 */
'use strict';

const { existsSync, renameSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');

const marker = process.argv[2];
const outPath = process.argv[3];
const withGrandchild = process.argv[4] === '1';
const guardPath = process.argv[5] && process.argv[5] !== 'none' ? process.argv[5] : null;
const exitAfterMs = Number(process.argv[6] ?? '0');

if (!marker || !outPath) {
  console.error('usage: real-cli.cjs <marker> <out-path> <with-grandchild> [guard-path]');
  process.exit(64);
}

const state = {
  marker,
  pid: process.pid,
  ppid: process.ppid,
  guardPath,
  guardPresent: guardPath ? existsSync(guardPath) : null,
  grandchildPid: null,
  startedAt: new Date().toISOString(),
};

function persist() {
  const temporary = `${outPath}.${process.pid}.tmp`;
  const payload = JSON.stringify(state);
  // Windows can transiently refuse to replace a file that an observer has just
  // opened. Retry briefly so a reader never turns into a fixture crash.
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      writeFileSync(temporary, payload, 'utf8');
      renameSync(temporary, outPath);
      return;
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw lastError;
}

persist();
process.stdout.write(`CLI_READY ${marker}\n`);

if (withGrandchild) {
  const grandchild = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', `${marker}-grandchild`],
    { stdio: 'ignore' },
  );
  state.grandchildPid = grandchild.pid ?? null;
  persist();
}

// Keep the process alive and consume stdin so a large prompt does not block.
process.stdin.resume();
process.stdin.on('data', () => undefined);

if (Number.isFinite(exitAfterMs) && exitAfterMs > 0) {
  setTimeout(() => process.exit(0), exitAfterMs);
} else {
  setInterval(() => undefined, 1000);
}
