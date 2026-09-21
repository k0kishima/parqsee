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
   * Nothing has ever loaded for this file and the request asked for the
   * plain first page — the first page after opening it or after a
   * Refresh. Nothing about the request can be blamed, so the file itself
   * is unreadable (a corrupt data page behind a valid footer, or a file
   * deleted since it was opened) and the tab shows a file-level error
   * rather than a banner over an empty grid.
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
  | { kind: 'banner'; restore: LoadedState; rewinds: boolean }
  /**
   * Nothing has loaded yet, but the request carried a filter or a sort:
   * the file may be perfectly readable and only the condition refused — a
   * column the file no longer has after a Refresh, a filter restored from
   * a session onto a rewritten file. The viewer drops both, loads the
   * plain first page and keeps the reason as a banner; only if that plain
   * load fails too is the file itself the problem.
   */
  | { kind: 'retryPlain' };

/**
 * What a failed page load leaves the viewer showing. The sort is compared
 * by identity, as the viewer holds it: a change to the sort is a new
 * object, and an unchanged one is the very same object.
 */
export function loadFailure(lastGood: LoadedState | null, requested: RequestedState): LoadFailure {
  if (!lastGood) return requested.filter || requested.sort ? { kind: 'retryPlain' } : { kind: 'file' };
  const rewinds =
    lastGood.filter !== requested.filter ||
    lastGood.page !== requested.page ||
    lastGood.sort !== requested.sort;
  return { kind: 'banner', restore: lastGood, rewinds };
}
