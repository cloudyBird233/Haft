import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../features/executions/diff-parser';

describe('parseUnifiedDiff', () => {
  it('returns no files for an empty patch', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('   \n')).toEqual([]);
  });

  it('parses a modified file with addition and deletion counts', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/src/index.ts b/src/index.ts',
        'index 1111111..2222222 100644',
        '--- a/src/index.ts',
        '+++ b/src/index.ts',
        '@@ -1,3 +1,3 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        ' const c = 4;',
      ].join('\n'),
    );

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'src/index.ts',
      oldPath: null,
      status: 'modified',
      binary: false,
      additions: 1,
      deletions: 1,
    });
  });

  it('parses added and deleted files including /dev/null headers', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/new.txt b/new.txt',
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1 @@',
        '+hello',
        'diff --git a/old.txt b/old.txt',
        'deleted file mode 100644',
        'index 1111111..0000000',
        '--- a/old.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-goodbye',
      ].join('\n'),
    );

    expect(files.map((file) => [file.path, file.status])).toEqual([
      ['new.txt', 'added'],
      ['old.txt', 'deleted'],
    ]);
  });

  it('parses a rename and keeps the previous path', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/src/old-name.ts b/src/new-name.ts',
        'similarity index 100%',
        'rename from src/old-name.ts',
        'rename to src/new-name.ts',
      ].join('\n'),
    );

    expect(files[0]).toMatchObject({
      path: 'src/new-name.ts',
      oldPath: 'src/old-name.ts',
      status: 'renamed',
    });
  });

  it('marks binary patches without textual hunks', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/image.bin b/image.bin',
        'index e0d84f4..9a529b9 100644',
        'Binary files a/image.bin and b/image.bin differ',
      ].join('\n'),
    );

    expect(files[0]).toMatchObject({
      path: 'image.bin',
      status: 'modified',
      binary: true,
    });
  });

  it('is tolerant of a patch truncated in the middle of a file block', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/big.txt b/big.txt',
        '--- a/big.txt',
        '+++ b/big.txt',
        '@@ -1,2 +1,2 @@',
        '-line one',
        '+line one changed',
        'diff --git a/cut.ts b/cut.ts',
        '--- a/cut.ts',
        '+++ b/cut.ts',
        '@@ -1 +1 @@',
        '-const partial',
      ].join('\n'),
    );

    expect(files).toHaveLength(2);
    expect(files[1]).toMatchObject({ path: 'cut.ts', status: 'modified' });
    expect(files[1]?.content).toContain('-const partial');
  });
});
