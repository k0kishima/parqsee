import { vi } from 'vitest';
import type { RecentFile } from '../bindings/ipc/RecentFile';

/**
 * A stand-in for `RecentFilesContext`, for the tests that render one of
 * the surfaces over the list — the Welcome screen's, the top row's panel,
 * the header's button — rather than the store behind it.
 *
 * A test file installs it whole:
 *
 * ```ts
 * vi.mock('<path>/contexts/RecentFilesContext', () => import('<path>/test/recent-files-context-mock'));
 * ```
 *
 * The list is set through `setRecentFiles` rather than assigned to a
 * variable of the test file's own, because `vi.mock` hoists its factory
 * above the file's declarations: what the replacement reads has to live
 * where the replacement does.
 */

let files: RecentFile[] = [];

/** What the surface under test will list. Set it before rendering. */
export const setRecentFiles = (next: RecentFile[]) => {
  files = next;
};

export const removeRecentFile = vi.fn();
export const clearRecentFiles = vi.fn();

export const useRecentFiles = () => ({ recentFiles: files, removeRecentFile, clearRecentFiles });
