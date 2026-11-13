import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, rm, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { EvidenceFileError, readRegularFileSnapshot, type EvidenceFileSnapshot } from './safe-file';

/**
 * Durable evidence around quarantined journals.
 *
 * A corrupt journal is only resolvable when two independently verifiable files
 * exist:
 * - `<target>.provenance.json`, written by the real quarantine path; it binds
 *   the original journal name, the quarantined name, the recovery root, the
 *   isolation time and the exact content digest.
 * - `<target>.resolution.json`, written atomically by an operator resolution;
 *   it binds the same content digest and the provenance execution identity.
 *
 * Anything missing, malformed, truncated, relocated or modified fails closed.
 */

export const RESOLUTION_SIDECAR_VERSION = 2;
export const CORRUPT_PROVENANCE_VERSION = 1;
export const RESOLUTION_KIND = 'corrupt-journal-resolution';
export const PROVENANCE_KIND = 'corrupt-journal-quarantine';
export const RESOLUTION_VALUE = 'operator-confirmed-process-gone';

export interface ResolutionSidecarRecord {
  version: typeof RESOLUTION_SIDECAR_VERSION;
  kind: typeof RESOLUTION_KIND;
  executionId: string | null;
  targetName: string;
  targetSha256: string;
  targetSize: number;
  resolution: typeof RESOLUTION_VALUE;
  note: string;
  resolvedAt: string;
}

export interface CorruptProvenanceRecord {
  version: typeof CORRUPT_PROVENANCE_VERSION;
  kind: typeof PROVENANCE_KIND;
  recoveryRoot: string;
  originalName: string;
  quarantinedName: string;
  executionId: string | null;
  isolatedAt: string;
  sha256: string;
  size: number;
}

export type ResolutionReadResult =
  | { valid: true; record: ResolutionSidecarRecord; path: string }
  | { valid: false; reason: string; missing: boolean };

export type ProvenanceReadResult =
  | { valid: true; record: CorruptProvenanceRecord; path: string }
  | { valid: false; reason: string; missing: boolean };

export type CorruptResolutionReadResult =
  | { valid: true; resolution: ResolutionSidecarRecord; provenance: CorruptProvenanceRecord }
  | { valid: false; reason: string; missing: boolean };

export interface EvidenceIo {
  /** Writes and fsyncs a new temporary file in the target directory. */
  writeTempFile(path: string, contents: string): Promise<void>;
  /** Publishes the complete temporary file without exposing a partial target. */
  publish(tempPath: string, targetPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Makes the directory entry durable where the platform supports it. */
  syncDirectory(path: string): Promise<void>;
}

export const defaultEvidenceIo: EvidenceIo = {
  async writeTempFile(path: string, contents: string): Promise<void> {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async publish(tempPath: string, targetPath: string): Promise<void> {
    // A hard link is atomic and refuses to replace an existing target, so a
    // concurrent/valid resolution can never be overwritten silently. A
    // filesystem that cannot create hard links fails closed instead of falling
    // back to an overwriting rename.
    await link(tempPath, targetPath);
    await unlink(tempPath).catch(() => undefined);
  },
  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  },
  async syncDirectory(path: string): Promise<void> {
    if (process.platform === 'win32') return;
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY);
      await handle.sync();
    } catch (error) {
      // Directory fsync is unavailable on some filesystems. Do not turn a
      // successful atomic publish into a false failure there.
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF', 'EPERM'].includes(errorCode(error) ?? '')) {
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
};

export function resolutionSidecarPath(targetPath: string): string {
  return `${targetPath}.resolution.json`;
}

export function corruptProvenancePath(targetPath: string): string {
  return `${targetPath}.provenance.json`;
}

export async function writeResolutionSidecar(
  targetPath: string,
  input: { executionId: string | null; note: string; resolvedAt?: string },
  io: EvidenceIo = defaultEvidenceIo,
): Promise<
  { ok: true; record: ResolutionSidecarRecord; path: string } | { ok: false; reason: string }
> {
  const note = input.note.trim();
  if (!note) return { ok: false, reason: 'an operator note is required' };

  const target = await readTargetSnapshot(targetPath);
  const sidecarPath = resolutionSidecarPath(targetPath);
  const existing = await readResolutionSidecar(targetPath);
  if (existing.valid || !existing.missing) {
    return {
      ok: false,
      reason: existing.valid
        ? 'a resolution sidecar already exists; refusing to overwrite audit evidence'
        : `an invalid resolution sidecar already exists: ${existing.reason}`,
    };
  }

  const record: ResolutionSidecarRecord = {
    version: RESOLUTION_SIDECAR_VERSION,
    kind: RESOLUTION_KIND,
    executionId: input.executionId,
    targetName: basename(targetPath),
    targetSha256: target.sha256,
    targetSize: target.size,
    resolution: RESOLUTION_VALUE,
    note,
    resolvedAt: input.resolvedAt ?? new Date().toISOString(),
  };
  await publishAtomic(sidecarPath, `${JSON.stringify(record, null, 2)}\n`, io);

  const verification = await readResolutionSidecar(targetPath);
  if (!verification.valid) {
    return {
      ok: false,
      reason: `the published resolution sidecar could not be verified: ${verification.reason}`,
    };
  }
  return { ok: true, record: verification.record, path: sidecarPath };
}

export async function readResolutionSidecar(targetPath: string): Promise<ResolutionReadResult> {
  const sidecarPath = resolutionSidecarPath(targetPath);
  let snapshot: EvidenceFileSnapshot;
  try {
    snapshot = await readRegularFileSnapshot(sidecarPath, { maxBytes: 1024 * 1024 });
  } catch (error) {
    return {
      valid: false,
      missing: error instanceof EvidenceFileError && error.code === 'missing',
      reason: describeEvidenceError('resolution sidecar', error),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(snapshot.contents.toString('utf8'));
  } catch (error) {
    return {
      valid: false,
      missing: false,
      reason: `the resolution sidecar is not valid JSON: ${errorMessage(error)}`,
    };
  }
  let target: EvidenceFileSnapshot;
  try {
    target = await readTargetSnapshot(targetPath);
  } catch (error) {
    return {
      valid: false,
      missing: false,
      reason: describeEvidenceError('resolution target', error),
    };
  }
  if (!isResolutionRecord(value)) {
    return {
      valid: false,
      missing: false,
      reason: 'the resolution sidecar failed schema validation',
    };
  }
  const mismatch = resolutionMismatch(value, targetPath, target);
  if (mismatch) return { valid: false, missing: false, reason: mismatch };
  return { valid: true, record: value, path: sidecarPath };
}

/**
 * Reads the provenance record created by the corruption isolation path and
 * verifies that it still describes this exact file in this exact root.
 */
export async function readCorruptProvenance(
  targetPath: string,
  recoveryRoot: string,
): Promise<ProvenanceReadResult> {
  const provenancePath = corruptProvenancePath(targetPath);
  let snapshot: EvidenceFileSnapshot;
  try {
    snapshot = await readRegularFileSnapshot(provenancePath, { maxBytes: 1024 * 1024 });
  } catch (error) {
    return {
      valid: false,
      missing: error instanceof EvidenceFileError && error.code === 'missing',
      reason: describeEvidenceError('corrupt provenance', error),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(snapshot.contents.toString('utf8'));
  } catch (error) {
    return {
      valid: false,
      missing: false,
      reason: `the corrupt provenance is not valid JSON: ${errorMessage(error)}`,
    };
  }
  let target: EvidenceFileSnapshot;
  try {
    target = await readTargetSnapshot(targetPath);
  } catch (error) {
    return {
      valid: false,
      missing: false,
      reason: describeEvidenceError('corrupt journal', error),
    };
  }
  if (!isProvenanceRecord(value)) {
    return {
      valid: false,
      missing: false,
      reason: 'the corrupt provenance failed schema validation',
    };
  }
  const mismatch = provenanceMismatch(value, targetPath, resolve(recoveryRoot), target);
  if (mismatch) return { valid: false, missing: false, reason: mismatch };
  return { valid: true, record: value, path: provenancePath };
}

export async function readValidCorruptResolution(
  targetPath: string,
  recoveryRoot: string,
): Promise<CorruptResolutionReadResult> {
  const provenance = await readCorruptProvenance(targetPath, recoveryRoot);
  if (!provenance.valid) {
    return {
      valid: false,
      missing: provenance.missing,
      reason: `CORRUPT_PROVENANCE_INVALID: ${provenance.reason}`,
    };
  }
  const resolution = await readResolutionSidecar(targetPath);
  if (!resolution.valid) {
    return {
      valid: false,
      missing: resolution.missing,
      reason: `RESOLUTION_SIDECAR_INVALID: ${resolution.reason}`,
    };
  }
  if (resolution.record.executionId !== provenance.record.executionId) {
    return {
      valid: false,
      missing: false,
      reason: 'RESOLUTION_SIDECAR_INVALID: the resolution execution identity does not match',
    };
  }
  return {
    valid: true,
    resolution: resolution.record,
    provenance: provenance.record,
  };
}

/**
 * Called by the real quarantine path immediately after the corrupt journal is
 * renamed. A provenance write failure is surfaced to the journal so the file
 * stays blocked instead of being treated as normally resolvable.
 */
export async function writeCorruptProvenance(
  targetPath: string,
  recoveryRoot: string,
  executionId: string | null,
  io: EvidenceIo = defaultEvidenceIo,
): Promise<{ record: CorruptProvenanceRecord; path: string }> {
  const target = await readTargetSnapshot(targetPath);
  const quarantinedName = basename(targetPath);
  const originalName = quarantinedName.replace(/\.corrupt-\d+$/, '');
  if (!originalName || originalName === quarantinedName) {
    throw new Error(`cannot derive the original journal name from ${quarantinedName}`);
  }
  const record: CorruptProvenanceRecord = {
    version: CORRUPT_PROVENANCE_VERSION,
    kind: PROVENANCE_KIND,
    recoveryRoot: resolve(recoveryRoot),
    originalName,
    quarantinedName,
    executionId,
    isolatedAt: new Date().toISOString(),
    sha256: target.sha256,
    size: target.size,
  };
  const path = corruptProvenancePath(targetPath);

  const existing = await readCorruptProvenance(targetPath, recoveryRoot);
  if (existing.valid || !existing.missing) {
    if (existing.valid) return { record: existing.record, path };
    throw new Error(`an invalid corrupt provenance already exists: ${existing.reason}`);
  }

  await publishAtomic(path, `${JSON.stringify(record, null, 2)}\n`, io);
  const verification = await readCorruptProvenance(targetPath, recoveryRoot);
  if (!verification.valid) {
    throw new Error(
      `the published corrupt provenance could not be verified: ${verification.reason}`,
    );
  }
  return { record: verification.record, path };
}

async function publishAtomic(targetPath: string, contents: string, io: EvidenceIo): Promise<void> {
  const temporary = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await io.writeTempFile(temporary, contents);
    await io.publish(temporary, targetPath);
    published = true;
    await io.syncDirectory(dirname(targetPath));
  } catch (error) {
    if (published) {
      // A sidecar whose directory entry could not be synced is not durable
      // evidence. Remove it so recovery stays blocked instead of going clean.
      await io.remove(targetPath).catch(() => undefined);
    }
    await io.remove(temporary).catch(() => undefined);
    throw error;
  }
}

async function readTargetSnapshot(path: string): Promise<EvidenceFileSnapshot> {
  return readRegularFileSnapshot(path, { maxBytes: 16 * 1024 * 1024 });
}

function isResolutionRecord(value: unknown): value is ResolutionSidecarRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ResolutionSidecarRecord>;
  return Boolean(
    record.version === RESOLUTION_SIDECAR_VERSION &&
    record.kind === RESOLUTION_KIND &&
    (record.executionId === null || nonEmptyString(record.executionId)) &&
    nonEmptyString(record.targetName) &&
    typeof record.targetSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(record.targetSha256) &&
    typeof record.targetSize === 'number' &&
    Number.isSafeInteger(record.targetSize) &&
    record.targetSize >= 0 &&
    record.resolution === RESOLUTION_VALUE &&
    nonEmptyString(record.note) &&
    isIsoTimestamp(record.resolvedAt),
  );
}

function isProvenanceRecord(value: unknown): value is CorruptProvenanceRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CorruptProvenanceRecord>;
  return Boolean(
    record.version === CORRUPT_PROVENANCE_VERSION &&
    record.kind === PROVENANCE_KIND &&
    nonEmptyString(record.recoveryRoot) &&
    nonEmptyString(record.originalName) &&
    nonEmptyString(record.quarantinedName) &&
    (record.executionId === null || nonEmptyString(record.executionId)) &&
    isIsoTimestamp(record.isolatedAt) &&
    typeof record.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(record.sha256) &&
    typeof record.size === 'number' &&
    Number.isSafeInteger(record.size) &&
    record.size >= 0,
  );
}

function resolutionMismatch(
  record: ResolutionSidecarRecord,
  targetPath: string,
  target: EvidenceFileSnapshot,
): string | null {
  if (record.targetName !== basename(targetPath)) {
    return 'the resolution sidecar belongs to a different quarantined file';
  }
  if (record.targetSize !== target.size) {
    return 'the resolution sidecar size does not match the quarantined journal';
  }
  if (record.targetSha256 !== target.sha256) {
    return 'the resolution sidecar digest does not match the quarantined journal';
  }
  return null;
}

function provenanceMismatch(
  record: CorruptProvenanceRecord,
  targetPath: string,
  recoveryRoot: string,
  target: EvidenceFileSnapshot,
): string | null {
  if (record.recoveryRoot !== recoveryRoot) {
    return 'the corrupt provenance belongs to a different recovery root';
  }
  const quarantinedName = basename(targetPath);
  const originalName = quarantinedName.replace(/\.corrupt-\d+$/, '');
  if (!originalName || originalName === quarantinedName) {
    return 'the target is not a quarantined corrupt journal name';
  }
  if (record.quarantinedName !== quarantinedName) {
    return 'the corrupt provenance belongs to a different quarantined file';
  }
  if (record.originalName !== originalName) {
    return 'the corrupt provenance original journal name does not match';
  }
  if (record.size !== target.size) {
    return 'the corrupt provenance size does not match the quarantined journal';
  }
  if (record.sha256 !== target.sha256) {
    return 'the corrupt provenance digest does not match the quarantined journal';
  }
  return null;
}

function describeEvidenceError(label: string, error: unknown): string {
  if (error instanceof EvidenceFileError) {
    switch (error.code) {
      case 'missing':
        return `the ${label} does not exist`;
      case 'symlink':
        return `the ${label} is a symbolic link`;
      case 'not-regular':
        return `the ${label} is not a regular file`;
      case 'too-large':
        return `the ${label} is unreasonably large`;
      case 'unreadable':
        return error.message;
    }
  }
  return errorMessage(error);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
