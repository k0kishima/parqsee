import { dirname, getFileName } from '../../../lib/path';

export interface RecentFileLabel {
  name: string;
  /**
   * The parent folder's name, set only when another entry in the same list
   * has the same file name — `data.parquet` from `2024q1` and from `2024q2`
   * would otherwise read as one file listed twice. The full path stays on
   * the entry for the cases a folder name does not settle.
   */
  folder: string | null;
}

/** Display labels for a list of recent files, keyed by path. */
export function recentFileLabels(files: readonly { path: string; name: string }[]): Map<string, RecentFileLabel> {
  const nameCounts = new Map<string, number>();
  for (const file of files) {
    nameCounts.set(file.name, (nameCounts.get(file.name) ?? 0) + 1);
  }
  const labels = new Map<string, RecentFileLabel>();
  for (const file of files) {
    const shared = (nameCounts.get(file.name) ?? 0) > 1;
    labels.set(file.path, { name: file.name, folder: shared ? parentFolderName(file.path) : null });
  }
  return labels;
}

/** `/a/b/c.parquet` → `b`; a file at the root of the filesystem → `/`. */
function parentFolderName(path: string): string {
  const dir = dirname(path);
  if (dir === '' || dir === '/') return dir || '';
  return getFileName(dir);
}

/** Case-insensitive match of `query` against the file's name or path; an empty query matches all. */
export function matchesRecentFile(file: { path: string; name: string }, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return file.name.toLowerCase().includes(needle) || file.path.toLowerCase().includes(needle);
}
