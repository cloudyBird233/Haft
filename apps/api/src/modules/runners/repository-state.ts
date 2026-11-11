/**
 * Platform-aware repository path comparison.
 *
 * The API may run on Linux while the selected Runner is Windows, so this
 * deliberately avoids `node:path.resolve` on a path from another platform.
 * Windows paths are compared case-insensitively with normalized separators;
 * POSIX paths are compared exactly after separator normalization.
 */
export function normalizeRepositoryPathForComparison(
  value: string,
  platform: string | null | undefined,
): string {
  const windows = platform === 'win32';
  const separator = windows ? '\\' : '/';
  let normalized = value.replace(/[\\/]+/g, separator);
  while (normalized.length > 1 && normalized.endsWith(separator)) {
    normalized = normalized.slice(0, -1);
  }
  return windows ? normalized.toLowerCase() : normalized;
}

export function sameRepositoryPath(
  left: string | null | undefined,
  right: string | null | undefined,
  platform: string | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return (
    normalizeRepositoryPathForComparison(left, platform) ===
    normalizeRepositoryPathForComparison(right, platform)
  );
}
