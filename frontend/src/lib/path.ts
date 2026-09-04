export function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
}

export const PARQUET_EXTENSION = 'parquet';

// Case-insensitive, matching the backend's `is_parquet` check.
export function isParquetPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(`.${PARQUET_EXTENSION}`);
}

export function stripParquetExtension(filePath: string): string {
  return filePath.replace(new RegExp(`\\.${PARQUET_EXTENSION}$`, 'i'), '');
}

/** The directory part of a posix path: `/a/b/c.parquet` → `/a/b`, `/a` → `/`. */
export function dirname(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  if (index < 0) return '';
  return index === 0 ? '/' : filePath.substring(0, index);
}

/** True when `filePath` is `root` itself or lies below it. */
export function isWithin(root: string, filePath: string): boolean {
  const base = root.replace(/\/+$/, '');
  return filePath === base || filePath === root || filePath.startsWith(base + '/');
}

/**
 * The directories from `root` down to `dir`, inclusive:
 * `('/r', '/r/a/b')` → `['/r', '/r/a', '/r/a/b']`. Empty when `dir` is not
 * within `root`.
 */
export function ancestorsWithin(root: string, dir: string): string[] {
  if (!isWithin(root, dir)) return [];
  const base = root.replace(/\/+$/, '');
  if (dir === base || dir === root) return [base];
  const chain = [base];
  for (const segment of dir.substring(base.length + 1).split('/').filter(Boolean)) {
    chain.push(`${chain[chain.length - 1]}/${segment}`);
  }
  return chain;
}
