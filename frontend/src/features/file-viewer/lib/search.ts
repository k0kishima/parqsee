import { RowData } from '../../../lib/row';
import { formatCellValue } from '../../../lib/format';

export interface SearchMatch {
  /** -1 for a column header match. */
  rowIndex: number;
  colIndex: number;
  value: string;
}

/** Matches past this many are not collected; searching stops there. */
export const MAX_SEARCH_MATCHES = 1000;

/**
 * Position of the first case-insensitive occurrence of `term` in `text`, or
 * -1. This is the one definition of "matches" — the match list, the cell
 * and header highlights all go through it, so they cannot disagree about
 * what counts.
 */
export function indexOfTerm(text: string, term: string): number {
  if (!term || !text) return -1;
  return text.toLowerCase().indexOf(term.toLowerCase());
}

export function matchesTerm(text: string | null, term: string): boolean {
  return text !== null && indexOfTerm(text, term) !== -1;
}

/**
 * Every place `term` occurs on the page: the column headers first, then
 * each row's cells as the grid renders them (see formatCellValue; NULL cells
 * never match), in column order, stopping at `maxMatches`.
 */
export function findSearchMatches(
  term: string,
  columns: readonly { name: string }[],
  rows: readonly RowData[],
  maxMatches = MAX_SEARCH_MATCHES
): SearchMatch[] {
  if (!term) return [];
  const matches: SearchMatch[] = [];

  for (let colIndex = 0; colIndex < columns.length; colIndex++) {
    const name = columns[colIndex].name;
    if (matchesTerm(name, term)) {
      matches.push({ rowIndex: -1, colIndex, value: name });
      if (matches.length >= maxMatches) return matches;
    }
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    for (let colIndex = 0; colIndex < columns.length; colIndex++) {
      const value = formatCellValue(row[columns[colIndex].name]);
      if (matchesTerm(value, term)) {
        matches.push({ rowIndex, colIndex, value: value as string });
        if (matches.length >= maxMatches) return matches;
      }
    }
  }

  return matches;
}
