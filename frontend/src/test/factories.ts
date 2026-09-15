import type { RecentFile } from '../bindings/ipc/RecentFile';

/**
 * A Recent Files entry in the shape the backend actually sends.
 *
 * Typed against the generated `RecentFile` so a test cannot quietly build a
 * field the webview never receives: three test files each declared their own
 * literal type for this entry, and `last_accessed` had drifted to an ISO
 * string in one of them. The command returns Unix milliseconds, and
 * `new Date(...)` accepts either, so nothing caught it.
 */
export function makeRecentFile(overrides: Partial<RecentFile> = {}): RecentFile {
  const name = overrides.name ?? 'a.parquet';
  return { path: `/data/${name}`, name, size: 1, last_accessed: 0, available: true, ...overrides };
}
