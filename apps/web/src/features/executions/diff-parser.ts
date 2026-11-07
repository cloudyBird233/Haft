export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ParsedDiffFile {
  /** New path for additions/modifications/renames, old path for deletions. */
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  /** Raw unified diff block for this file, including headers and hunks. */
  content: string;
  additions: number;
  deletions: number;
}

const DIFF_HEADER = /^diff --git /;
const BINARY_HINT = /^Binary files .* differ$|^GIT binary patch$|^Binary files /;

/**
 * Splits a Git unified diff into per-file blocks without needing the Git CLI
 * or any repository path from the browser. The parser is intentionally
 * tolerant: a truncated patch may end in the middle of a block or a line.
 */
export function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  if (!diff.trim()) return [];

  const lines = diff.split(/\r?\n/);
  const blocks: string[][] = [];
  for (const line of lines) {
    if (DIFF_HEADER.test(line)) {
      blocks.push([line]);
    } else if (blocks.length > 0) {
      // The guard above keeps this index in range; TypeScript cannot narrow
      // array element access after a length check.
      blocks[blocks.length - 1]?.push(line);
    }
  }

  return blocks.map((block) => parseBlock(block));
}

function parseBlock(lines: string[]): ParsedDiffFile {
  const header = lines[0] ?? '';
  const renameFrom = headerValue(lines, 'rename from ');
  const renameTo = headerValue(lines, 'rename to ');
  const oldFromMinus = headerValue(lines, '--- a/');
  const newFromPlus = headerValue(lines, '+++ b/');
  const deleted = lines.some((line) => line.startsWith('deleted file mode '));
  const added = lines.some((line) => line.startsWith('new file mode '));
  const renamed = Boolean(renameFrom && renameTo);
  const binary = lines.some((line) => BINARY_HINT.test(line));

  let status: DiffFileStatus = 'modified';
  if (deleted) status = 'deleted';
  else if (renamed) status = 'renamed';
  else if (added) status = 'added';

  const headerPaths = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
  const path =
    renameTo ??
    newFromPlus ??
    renameFrom ??
    oldFromMinus ??
    headerPaths?.[2] ??
    headerPaths?.[1] ??
    'unknown';
  const oldPath = renameFrom ?? oldFromMinus ?? headerPaths?.[1] ?? null;

  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }

  return {
    path,
    oldPath: oldPath && oldPath !== path ? oldPath : null,
    status,
    binary,
    content: lines.join('\n'),
    additions,
    deletions,
  };
}

function headerValue(lines: string[], prefix: string): string | null {
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      return stripTrailingTab(line.slice(prefix.length));
    }
  }
  return null;
}

function stripTrailingTab(value: string): string {
  // Git appends a tab to `---`/`+++` paths that contain spaces.
  return value.endsWith('\t') ? value.slice(0, -1) : value;
}
