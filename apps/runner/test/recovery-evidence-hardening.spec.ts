import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionJournal, type ExecutionJournalRecord } from '../src/execution-journal';
import {
  corruptProvenancePath,
  defaultEvidenceIo,
  readResolutionSidecar,
  readValidCorruptResolution,
  writeResolutionSidecar,
  type EvidenceIo,
} from '../src/recovery-evidence';
import { ExecutionRecovery, type RecoveryDependencies } from '../src/recovery';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'haft-recovery-evidence-'));
  roots.push(root);
  return root;
}

function dependencies(overrides: Partial<RecoveryDependencies> = {}): RecoveryDependencies {
  return {
    inspectProcess: vi.fn().mockResolvedValue(null),
    terminateProcessTree: vi.fn().mockResolvedValue(undefined),
    waitForProcessExit: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function journalRecord(overrides: Partial<ExecutionJournalRecord> = {}): ExecutionJournalRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    executionId: 'execution_recovery_evidence',
    runtime: 'codex',
    projectId: 'project_demo',
    pid: null,
    processStartTime: null,
    processGroupId: null,
    worktreePath: null,
    branchName: null,
    baseCommit: null,
    phase: 'running',
    status: 'active',
    lastSequence: 0,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    launchToken: null,
    guardPath: null,
    supervisorPid: null,
    supervisorStartTime: null,
    cliPid: null,
    cliStartTime: null,
    processKind: 'direct',
    spawnState: 'intent',
    recoveryBlockedReason: null,
    recoveryBlockedAt: null,
    recoveryNote: null,
    ...overrides,
  };
}

async function quarantine(
  root: string,
  name = 'broken.json',
  contents = '{not-json',
): Promise<{ recovery: ExecutionRecovery; quarantined: string }> {
  await writeFile(join(root, name), contents, 'utf8');
  const recovery = new ExecutionRecovery(root, dependencies());
  const scan = await recovery.scan();
  const quarantined = scan.corrupted.find((entry) => entry.path.endsWith(name))?.quarantinedPath;
  if (!quarantined) throw new Error(`journal ${name} was not quarantined`);
  return { recovery, quarantined };
}

async function expectBlocked(root: string, file: string): Promise<void> {
  const scan = await new ExecutionRecovery(root, dependencies()).scan();
  expect(scan.clean).toBe(false);
  expect(
    scan.blocked.some(
      (entry) =>
        entry.kind === 'corrupt-journal' && entry.file.toLowerCase() === file.toLowerCase(),
    ),
  ).toBe(true);
}

function failingIo(overrides: Partial<EvidenceIo>): EvidenceIo {
  return { ...defaultEvidenceIo, ...overrides };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('Resolution sidecar integrity (P2-2A)', () => {
  it('IR4: a zero-byte sidecar never makes the next scan clean', async () => {
    const root = await makeRoot();
    const { quarantined } = await quarantine(root);
    await writeFile(`${quarantined}.resolution.json`, '', 'utf8');

    const scan = await new ExecutionRecovery(root, dependencies()).scan();

    expect(scan.clean).toBe(false);
    expect(scan.blocked.some((entry) => entry.kind === 'corrupt-journal')).toBe(true);
    expect(existsSync(quarantined)).toBe(true);
  });

  it('IR4b: a truncated sidecar never makes the next scan clean', async () => {
    const root = await makeRoot();
    const { quarantined } = await quarantine(root);
    await writeFile(`${quarantined}.resolution.json`, '{"version":1', 'utf8');

    const scan = await new ExecutionRecovery(root, dependencies()).scan();

    expect(scan.clean).toBe(false);
    expect(scan.blocked.some((entry) => entry.kind === 'corrupt-journal')).toBe(true);
    expect(existsSync(quarantined)).toBe(true);
  });

  it('writes a verifiable sidecar atomically after a real quarantine', async () => {
    const root = await makeRoot();
    const original = '{not-json';
    const { recovery, quarantined } = await quarantine(root, 'broken.json', original);

    const result = await recovery.resolveCorruptJournal(
      quarantined,
      'operator inspected the corrupt journal',
    );

    expect(result.resolved).toBe(true);
    expect(await readFile(quarantined, 'utf8')).toBe(original);
    const sidecar = await readResolutionSidecar(quarantined);
    expect(sidecar.valid).toBe(true);
    if (sidecar.valid) {
      expect(sidecar.record.targetName).toBe(basename(quarantined));
      expect(sidecar.record.note).toBe('operator inspected the corrupt journal');
    }
    const provenance = JSON.parse(await readFile(corruptProvenancePath(quarantined), 'utf8')) as {
      version: number;
      kind: string;
      recoveryRoot: string;
      isolatedAt: string;
      originalName: string;
      quarantinedName: string;
      sha256: string;
      size: number;
    };
    expect(provenance.version).toBe(1);
    expect(provenance.kind).toBe('corrupt-journal-quarantine');
    expect(provenance.recoveryRoot).toBe(root);
    expect(Number.isNaN(Date.parse(provenance.isolatedAt))).toBe(false);
    expect(provenance.originalName).toBe('broken.json');
    expect(provenance.quarantinedName).toBe(basename(quarantined));
    expect(provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(provenance.size).toBe(Buffer.byteLength(original));
    expect((await new ExecutionRecovery(root, dependencies()).scan()).clean).toBe(true);
  });

  it('keeps recovery blocked when the sidecar write temp file fails', async () => {
    const root = await makeRoot();
    const { quarantined } = await quarantine(root);
    const io = failingIo({
      writeTempFile: vi.fn().mockRejectedValue(new Error('injected sidecar write failure')),
    });

    const result = await new ExecutionRecovery(root, {
      ...dependencies(),
      resolutionIo: io,
    }).resolveCorruptJournal(quarantined, 'operator inspected the file');

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('sidecar write failure');
    expect(existsSync(`${quarantined}.resolution.json`)).toBe(false);
    await expectBlocked(root, quarantined);
  });

  it('keeps recovery blocked when atomic publish fails', async () => {
    const root = await makeRoot();
    const { quarantined } = await quarantine(root);
    const io = failingIo({
      publish: vi.fn().mockRejectedValue(new Error('injected rename failure')),
    });

    const result = await new ExecutionRecovery(root, {
      ...dependencies(),
      resolutionIo: io,
    }).resolveCorruptJournal(quarantined, 'operator inspected the file');

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('rename failure');
    expect(existsSync(`${quarantined}.resolution.json`)).toBe(false);
    await expectBlocked(root, quarantined);
  });

  it('keeps recovery blocked when directory sync fails', async () => {
    const root = await makeRoot();
    const { quarantined } = await quarantine(root);
    const io = failingIo({
      syncDirectory: vi.fn().mockRejectedValue(new Error('injected fsync failure')),
    });

    const result = await new ExecutionRecovery(root, {
      ...dependencies(),
      resolutionIo: io,
    }).resolveCorruptJournal(quarantined, 'operator inspected the file');

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('fsync failure');
    expect(existsSync(`${quarantined}.resolution.json`)).toBe(false);
    await expectBlocked(root, quarantined);
  });

  it('cleans up a partial temporary file after a mid-write failure', async () => {
    const root = await makeRoot();
    const { quarantined } = await quarantine(root);
    const io = failingIo({
      writeTempFile: vi.fn(async (path: string) => {
        await writeFile(path, '{"version":2', 'utf8');
        throw new Error('injected partial write failure');
      }),
    });

    const result = await new ExecutionRecovery(root, {
      ...dependencies(),
      resolutionIo: io,
    }).resolveCorruptJournal(quarantined, 'operator inspected the file');

    expect(result.resolved).toBe(false);
    expect(existsSync(`${quarantined}.resolution.json`)).toBe(false);
    const files = await readdir(root);
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false);
    await expectBlocked(root, quarantined);
  });

  it('serializes concurrent resolutions without corrupting the sidecar', async () => {
    const root = await makeRoot();
    const { quarantined } = await quarantine(root);
    const recovery = new ExecutionRecovery(root, dependencies());

    const results = await Promise.all([
      recovery.resolveCorruptJournal(quarantined, 'first operator note'),
      recovery.resolveCorruptJournal(quarantined, 'second operator note'),
    ]);

    expect(results.filter((result) => result.resolved)).toHaveLength(1);
    const verification = await readValidCorruptResolution(quarantined, root);
    expect(verification.valid).toBe(true);
    expect((await new ExecutionRecovery(root, dependencies()).scan()).clean).toBe(true);
  });

  it('never overwrites an existing valid resolution sidecar', async () => {
    const root = await makeRoot();
    const { recovery, quarantined } = await quarantine(root);
    const first = await recovery.resolveCorruptJournal(quarantined, 'first operator note');
    expect(first.resolved).toBe(true);

    const second = await recovery.resolveCorruptJournal(quarantined, 'second operator note');

    expect(second.resolved).toBe(false);
    const stored = await readResolutionSidecar(quarantined);
    expect(stored.valid).toBe(true);
    if (stored.valid) expect(stored.record.note).toBe('first operator note');
  });

  it('rejects a sidecar copied from a different quarantined journal', async () => {
    const root = await makeRoot();
    const { quarantined } = await quarantine(root, 'first.json', '{not-json-first');
    const { quarantined: other } = await quarantine(root, 'second.json', '{not-json-second');
    const written = await writeResolutionSidecar(other, {
      executionId: null,
      note: 'operator inspected the other file',
    });
    expect(written.ok).toBe(true);
    await copyFile(`${other}.resolution.json`, `${quarantined}.resolution.json`);

    const result = await new ExecutionRecovery(root, dependencies()).resolveCorruptJournal(
      quarantined,
      'operator inspected the file',
    );

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('invalid resolution sidecar');
    await expectBlocked(root, quarantined);
  });

  it('rejects a sidecar that is a directory', async () => {
    const root = await makeRoot();
    const { recovery, quarantined } = await quarantine(root);
    await mkdir(`${quarantined}.resolution.json`);

    const result = await recovery.resolveCorruptJournal(quarantined, 'operator inspected the file');

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('invalid resolution sidecar');
    await expectBlocked(root, quarantined);
  });

  it.skipIf(process.platform === 'win32')('rejects a sidecar that is a symbolic link', async () => {
    const root = await makeRoot();
    const { recovery, quarantined } = await quarantine(root);
    const written = await writeResolutionSidecar(quarantined, {
      executionId: null,
      note: 'operator inspected the file',
    });
    expect(written.ok).toBe(true);
    const stored = join(root, 'stored-sidecar.json');
    await rename(`${quarantined}.resolution.json`, stored);
    await symlink(stored, `${quarantined}.resolution.json`);

    const result = await recovery.resolveCorruptJournal(quarantined, 'operator inspected the file');

    expect(result.resolved).toBe(false);
    await expectBlocked(root, quarantined);
  });

  it('rejects a sidecar whose target digest was tampered with', async () => {
    const root = await makeRoot();
    const { recovery, quarantined } = await quarantine(root);
    const written = await writeResolutionSidecar(quarantined, {
      executionId: null,
      note: 'operator inspected the file',
    });
    expect(written.ok).toBe(true);
    const sidecarPath = `${quarantined}.resolution.json`;
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
      targetSha256: string;
    };
    sidecar.targetSha256 = 'a'.repeat(64);
    await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');

    const result = await recovery.resolveCorruptJournal(quarantined, 'operator inspected the file');

    expect(result.resolved).toBe(false);
    await expectBlocked(root, quarantined);
  });

  it('rejects a valid-looking sidecar with a mismatched execution identity', async () => {
    const root = await makeRoot();
    const { quarantined } = await quarantine(
      root,
      'execution_original.json',
      '{"version":1,"executionId":"execution_original","status":"not-a-status"}',
    );
    const written = await writeResolutionSidecar(quarantined, {
      executionId: 'execution_other',
      note: 'operator inspected the file',
    });
    expect(written.ok).toBe(true);

    const result = await new ExecutionRecovery(root, dependencies()).resolveCorruptJournal(
      quarantined,
      'operator inspected the file',
    );

    expect(result.resolved).toBe(false);
    await expectBlocked(root, quarantined);
  });
});

describe('Corrupt journal provenance (P2-2B)', () => {
  it('IR5: an arbitrary *.corrupt-N file without provenance is rejected', async () => {
    const root = await makeRoot();
    const target = join(root, 'operator-note.corrupt-123');
    await writeFile(target, 'this is not a journal', 'utf8');

    const result = await new ExecutionRecovery(root, dependencies()).resolveCorruptJournal(
      target,
      'independent review',
    );

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('no valid isolation provenance');
    expect(existsSync(`${target}.resolution.json`)).toBe(false);
    await expectBlocked(root, target);
  });

  it('rejects an ordinary JSON file with a quarantine suffix', async () => {
    const root = await makeRoot();
    const target = join(root, 'ordinary.json.corrupt-456');
    await writeFile(target, JSON.stringify(journalRecord()), 'utf8');

    const result = await new ExecutionRecovery(root, dependencies()).resolveCorruptJournal(
      target,
      'looks safe',
    );

    expect(result.resolved).toBe(false);
    await expectBlocked(root, target);
  });

  it('requires provenance even when a syntactically valid sidecar exists', async () => {
    const root = await makeRoot();
    const target = join(root, 'sidecar-only.corrupt-789');
    await writeFile(target, '{not-json', 'utf8');
    const written = await writeResolutionSidecar(target, {
      executionId: null,
      note: 'operator inspected the file',
    });
    expect(written.ok).toBe(true);

    const result = await new ExecutionRecovery(root, dependencies()).resolveCorruptJournal(
      target,
      'operator inspected the file',
    );

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('no valid isolation provenance');
    await expectBlocked(root, target);
  });

  it('rejects a quarantined journal whose content changed after isolation', async () => {
    const root = await makeRoot();
    const { quarantined } = await quarantine(root, 'execution_changed.json', '{not-json');
    await writeFile(quarantined, '{not-json-modified', 'utf8');

    const result = await new ExecutionRecovery(root, dependencies()).resolveCorruptJournal(
      quarantined,
      'operator inspected the file',
    );

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('no valid isolation provenance');
    await expectBlocked(root, quarantined);
  });

  it('rejects provenance copied from another recovery root', async () => {
    const sourceRoot = await makeRoot();
    const targetRoot = await makeRoot();
    const { quarantined } = await quarantine(sourceRoot);
    const copied = join(targetRoot, basename(quarantined));
    await copyFile(quarantined, copied);
    await copyFile(corruptProvenancePath(quarantined), corruptProvenancePath(copied));

    const result = await new ExecutionRecovery(targetRoot, dependencies()).resolveCorruptJournal(
      copied,
      'operator inspected the file',
    );

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('no valid isolation provenance');
    await expectBlocked(targetRoot, copied);
  });

  it('rejects a provenance record that belongs to another execution file', async () => {
    const root = await makeRoot();
    const { quarantined } = await quarantine(root, 'execution_one.json', '{not-json');
    const renamed = join(root, `execution_two.json.corrupt-${Date.now()}`);
    await rename(quarantined, renamed);
    await copyFile(corruptProvenancePath(quarantined), corruptProvenancePath(renamed));

    const result = await new ExecutionRecovery(root, dependencies()).resolveCorruptJournal(
      renamed,
      'operator inspected the file',
    );

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('no valid isolation provenance');
    await expectBlocked(root, renamed);
  });

  it('keeps the original corrupt file as evidence after resolution', async () => {
    const root = await makeRoot();
    const original = '{"version":1,"executionId":';
    const { recovery, quarantined } = await quarantine(root, 'kept.json', original);

    const result = await recovery.resolveCorruptJournal(quarantined, 'operator inspected the file');

    expect(result.resolved).toBe(true);
    expect(await readFile(quarantined, 'utf8')).toBe(original);
    expect(existsSync(corruptProvenancePath(quarantined))).toBe(true);
    expect(existsSync(`${quarantined}.resolution.json`)).toBe(true);
  });

  it('keeps recovery blocked when provenance creation fails', async () => {
    const root = await makeRoot();
    await writeFile(join(root, 'broken.json'), '{not-json', 'utf8');
    const journal = new ExecutionJournal(root, {
      provenanceIo: failingIo({
        writeTempFile: vi.fn().mockRejectedValue(new Error('injected provenance failure')),
      }),
    });

    const listing = await journal.listDetailed();
    const entry = listing.corrupt[0];
    expect(entry?.quarantinedPath).toBeTruthy();
    expect(entry?.provenanceError).toContain('injected provenance failure');
    const quarantined = entry?.quarantinedPath as string;

    const scan = await new ExecutionRecovery(root, dependencies()).scan();
    expect(scan.clean).toBe(false);
    expect(scan.blocked.some((block) => block.kind === 'corrupt-journal')).toBe(true);
    expect(existsSync(quarantined)).toBe(true);
    const result = await new ExecutionRecovery(root, dependencies()).resolveCorruptJournal(
      quarantined,
      'operator inspected the file',
    );
    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('no valid isolation provenance');
  });
});
