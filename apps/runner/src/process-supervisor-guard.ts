import { lstatSync } from 'node:fs';
import type { ProcessGuardIsolation, ProcessGuardRecord, ProcessGuardState } from './process-guard';
import {
  EvidenceFileError,
  readRegularFileSnapshotSync,
  type EvidenceReadOptions,
} from './safe-file';

export type StartingGuardValidation =
  { ok: true; guard: ProcessGuardRecord } | { ok: false; error: string };

const KNOWN_STATES: ProcessGuardState[] = [
  'starting',
  'running',
  'terminating',
  'exited',
  'terminated',
  'failed',
  'unconfirmed',
];
const KNOWN_ISOLATIONS: ProcessGuardIsolation[] = ['windows-job', 'linux-cgroup', 'posix-group'];

/**
 * The POSIX supervisor may only create a CLI after proving that its own
 * starting guard is the exact regular file it just wrote. Existence, file name
 * or a path-only `stat` is not proof: directories, symlinks, FIFOs and stale or
 * tampered JSON must all block the launch.
 */
export function readValidatedStartingGuard(
  guardPath: string,
  expected: ProcessGuardRecord,
  options: EvidenceReadOptions = {},
): StartingGuardValidation {
  let snapshot;
  try {
    snapshot = readRegularFileSnapshotSync(guardPath, {
      ...options,
      maxBytes: 1024 * 1024,
    });
  } catch (error) {
    return { ok: false, error: describeReadError(error) };
  }

  let value: unknown;
  try {
    value = JSON.parse(snapshot.contents.toString('utf8'));
  } catch (error) {
    return {
      ok: false,
      error: `the process guard is not valid JSON: ${errorMessage(error)}`,
    };
  }
  if (!isProcessGuardRecord(value)) {
    return { ok: false, error: 'the process guard failed structural validation' };
  }
  if (!matchesStartingGuard(value, expected)) {
    return {
      ok: false,
      error: 'the process guard does not belong to this supervisor launch',
    };
  }
  return { ok: true, guard: value };
}

/**
 * Guard files are keyed by execution + launch token, so a pre-existing path is
 * always stale or hostile. Refusing it before writing also gives directories,
 * symlinks and FIFOs a deterministic failure instead of relying on rename
 * behavior that differs between filesystems.
 */
export function assertGuardPathAvailable(guardPath: string): void {
  let info;
  try {
    info = lstatSync(guardPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw new Error(`process guard path could not be inspected: ${errorMessage(error)}`);
  }
  const kind = info.isDirectory()
    ? 'directory'
    : info.isSymbolicLink()
      ? 'symbolic link'
      : info.isFIFO()
        ? 'FIFO'
        : info.isSocket()
          ? 'socket'
          : info.isFile()
            ? 'file'
            : 'special file';
  throw new Error(`process guard path already exists before startup (${kind})`);
}

export function isProcessGuardRecord(value: unknown): value is ProcessGuardRecord {
  if (!value || typeof value !== 'object') return false;
  const guard = value as Partial<ProcessGuardRecord>;
  return Boolean(
    guard.version === 1 &&
    nonEmptyString(guard.executionId) &&
    nonEmptyString(guard.launchToken) &&
    positiveSafeInteger(guard.parentPid) &&
    positiveSafeInteger(guard.supervisorPid) &&
    nonEmptyString(guard.supervisorStartTime) &&
    (guard.processGroupId === null || positiveSafeInteger(guard.processGroupId)) &&
    (guard.cgroupPath === null || typeof guard.cgroupPath === 'string') &&
    (guard.cliPid === null || positiveSafeInteger(guard.cliPid)) &&
    (guard.cliStartTime === null || nonEmptyString(guard.cliStartTime)) &&
    KNOWN_ISOLATIONS.includes(guard.isolation as ProcessGuardIsolation) &&
    KNOWN_STATES.includes(guard.state as ProcessGuardState) &&
    typeof guard.jobCreated === 'boolean' &&
    typeof guard.treeConfirmedGone === 'boolean' &&
    (guard.exitCode === null || safeInteger(guard.exitCode)) &&
    (guard.signal === null || typeof guard.signal === 'string') &&
    (guard.detail === null || typeof guard.detail === 'string') &&
    nonEmptyString(guard.createdAt) &&
    nonEmptyString(guard.updatedAt),
  );
}

function matchesStartingGuard(actual: ProcessGuardRecord, expected: ProcessGuardRecord): boolean {
  return (
    actual.executionId === expected.executionId &&
    actual.launchToken === expected.launchToken &&
    actual.parentPid === expected.parentPid &&
    actual.supervisorPid === expected.supervisorPid &&
    actual.supervisorStartTime === expected.supervisorStartTime &&
    actual.processGroupId === expected.processGroupId &&
    actual.cgroupPath === expected.cgroupPath &&
    actual.cliPid === null &&
    actual.cliStartTime === null &&
    actual.isolation === expected.isolation &&
    actual.state === 'starting' &&
    actual.jobCreated === expected.jobCreated &&
    actual.treeConfirmedGone === false &&
    actual.exitCode === null &&
    actual.signal === null &&
    actual.detail === null &&
    actual.createdAt === expected.createdAt
  );
}

function describeReadError(error: unknown): string {
  if (error instanceof EvidenceFileError) {
    switch (error.code) {
      case 'missing':
        return 'the process guard was not written';
      case 'symlink':
        return 'the process guard path is a symbolic link';
      case 'not-regular':
        return 'the process guard path is not a regular file';
      case 'too-large':
        return 'the process guard file is unreasonably large';
      case 'unreadable':
        return error.message;
    }
  }
  return errorMessage(error);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return safeInteger(value) && value > 0;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
