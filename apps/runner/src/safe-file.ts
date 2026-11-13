import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

/**
 * Evidence files (process guards, corrupt journals, resolution sidecars) are
 * only trusted when they are regular files. A plain `stat`/`readFile` follows
 * symlinks and can block forever on a FIFO, so every evidence read uses an
 * opened file descriptor:
 *
 * 1. `lstat` rejects an obvious symlink before it is followed.
 * 2. `open` uses `O_NOFOLLOW` (where the platform supports it) and `O_NONBLOCK`
 *    so a FIFO cannot stall the caller.
 * 3. `fstat` on the descriptor proves the opened object itself is a regular
 *    file.
 * 4. The contents and digest are read from that same descriptor.
 */
export type EvidenceFileErrorCode =
  'missing' | 'symlink' | 'not-regular' | 'too-large' | 'unreadable';

export class EvidenceFileError extends Error {
  constructor(
    readonly code: EvidenceFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvidenceFileError';
  }
}

export interface EvidenceFileSnapshot {
  contents: Buffer;
  size: number;
  sha256: string;
}

export interface EvidenceReadOptions {
  maxBytes?: number;
  /**
   * Test seam: runs after the descriptor has been fstat'ed and before the
   * contents are read. Replacing the path here must not change what is
   * validated because validation stays on the already-open descriptor.
   */
  afterOpen?: (descriptor: number) => void;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export async function readRegularFileSnapshot(
  path: string,
  options: EvidenceReadOptions = {},
): Promise<EvidenceFileSnapshot> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  await rejectSymbolicLink(path);
  let handle;
  try {
    handle = await open(path, readFlags());
  } catch (error) {
    throw evidenceOpenError(path, error);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new EvidenceFileError(
        'not-regular',
        `${path} is not a regular file (mode ${info.mode.toString(8)})`,
      );
    }
    if (info.size > maxBytes) {
      throw new EvidenceFileError('too-large', `${path} is larger than ${maxBytes} bytes`);
    }
    options.afterOpen?.(handle.fd);
    const contents = await handle.readFile();
    if (contents.length > maxBytes) {
      throw new EvidenceFileError('too-large', `${path} is larger than ${maxBytes} bytes`);
    }
    return snapshot(contents);
  } catch (error) {
    if (error instanceof EvidenceFileError) throw error;
    throw new EvidenceFileError('unreadable', `Could not read ${path}: ${errorMessage(error)}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function readRegularFileSnapshotSync(
  path: string,
  options: EvidenceReadOptions = {},
): EvidenceFileSnapshot {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink()) {
      throw new EvidenceFileError('symlink', `${path} is a symbolic link`);
    }
  } catch (error) {
    if (error instanceof EvidenceFileError) throw error;
    throw evidenceOpenError(path, error);
  }

  let descriptor: number;
  try {
    descriptor = openSync(path, readFlags());
  } catch (error) {
    throw evidenceOpenError(path, error);
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) {
      throw new EvidenceFileError(
        'not-regular',
        `${path} is not a regular file (mode ${info.mode.toString(8)})`,
      );
    }
    if (info.size > maxBytes) {
      throw new EvidenceFileError('too-large', `${path} is larger than ${maxBytes} bytes`);
    }
    options.afterOpen?.(descriptor);
    const contents = readFileSync(descriptor);
    if (contents.length > maxBytes) {
      throw new EvidenceFileError('too-large', `${path} is larger than ${maxBytes} bytes`);
    }
    return snapshot(contents);
  } catch (error) {
    if (error instanceof EvidenceFileError) throw error;
    throw new EvidenceFileError('unreadable', `Could not read ${path}: ${errorMessage(error)}`);
  } finally {
    closeSync(descriptor);
  }
}

export function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function rejectSymbolicLink(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw evidenceOpenError(path, error);
  }
  if (info.isSymbolicLink()) {
    throw new EvidenceFileError('symlink', `${path} is a symbolic link`);
  }
}

function readFlags(): number {
  return (
    constants.O_RDONLY |
    (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0) |
    (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0)
  );
}

function snapshot(contents: Buffer): EvidenceFileSnapshot {
  return { contents, size: contents.length, sha256: sha256(contents) };
}

function evidenceOpenError(path: string, error: unknown): EvidenceFileError {
  const code = errorCode(error);
  if (code === 'ENOENT') return new EvidenceFileError('missing', `${path} does not exist`);
  if (code === 'ELOOP' || code === 'EMLINK') {
    return new EvidenceFileError('symlink', `${path} is a symbolic link`);
  }
  return new EvidenceFileError('unreadable', `Could not open ${path}: ${errorMessage(error)}`);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
