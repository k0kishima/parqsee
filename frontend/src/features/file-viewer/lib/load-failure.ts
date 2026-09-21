import type { SortSpec } from '../api';

/** The request state the rows on screen were successfully loaded for. */
export interface LoadedState {
  page: number;
  filter: string;
  sort: SortSpec | null;
  totalRows: number;
}

/** The request state a load was attempted for. */
export interface RequestedState {
  page: number;
  filter: string;
  sort: SortSpec | null;
}

export type LoadFailure =
  /**
   * Nothing has ever loaded for this file — the first page after opening
   * it or after a Refresh. The file itself is unreadable (a corrupt data
   * page behind a valid footer, or a file deleted since it was opened),
   * so the tab shows a file-level error rather than a banner over an
   * empty grid.
   */
  | { kind: 'file' }
  /**
   * Rows are on screen from an earlier load. A rejected filter, a page
   * too deep to sort or a column the file no longer has must not strand
   * the tab on an error screen: the rows stay, the error is a banner, and
   * the request state goes back to `restore` so that pagination and the
   * export never describe the load that failed.
   *
   * `rewinds` is false when the failed request was already the one on
   * screen (a Refresh of the same page). Rolling back then changes no
   * state and starts no reload; when it is true the caller has to
   * suppress the reload the rollback would otherwise trigger, which would
   * fetch what the grid already holds and clear the banner with it.
   */
  | { kind: 'banner'; restore: LoadedState; rewinds: boolean };

/**
 * What a failed page load leaves the viewer showing. The sort is compared
 * by identity, as the viewer holds it: a change to the sort is a new
 * object, and an unchanged one is the very same object.
 */
export function loadFailure(lastGood: LoadedState | null, requested: RequestedState): LoadFailure {
  if (!lastGood) return { kind: 'file' };
  const rewinds =
    lastGood.filter !== requested.filter ||
    lastGood.page !== requested.page ||
    lastGood.sort !== requested.sort;
  return { kind: 'banner', restore: lastGood, rewinds };
}
