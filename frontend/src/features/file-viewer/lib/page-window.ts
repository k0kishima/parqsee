/**
 * The rows of the filtered result that the current page addresses.
 *
 * `offset` / `limit` are what the backend is asked to read; `startRow` /
 * `endRow` are the 1-based inclusive bounds the UI shows ("Showing 51-100 of
 * 120"), both 0 for an empty result.
 */
export interface PageWindow {
  offset: number;
  limit: number;
  startRow: number;
  endRow: number;
}

/**
 * The grid's page read, its "Showing …" label, the export modal's current-page
 * label and the export command's window are the same arithmetic. They were
 * spelled out separately and had already drifted — the grid's label clamped
 * neither bound to `totalRows` while the export modal's clamped both, so a
 * page past the end read "Showing 101-100 of 100" in one place and "100-100"
 * in the other. Both bounds are clamped here.
 */
export function pageWindow(currentPage: number, rowsPerPage: number, totalRows: number): PageWindow {
  const offset = (currentPage - 1) * rowsPerPage;
  const hasRows = totalRows > 0;
  return {
    offset,
    limit: rowsPerPage,
    startRow: hasRows ? Math.min(offset + 1, totalRows) : 0,
    endRow: hasRows ? Math.min(offset + rowsPerPage, totalRows) : 0,
  };
}
