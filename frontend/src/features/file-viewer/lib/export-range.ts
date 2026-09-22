import { assertNever } from '../../../lib/exhaustive';
import { pageWindow } from './page-window';

export const EXPORT_RANGES = ['all', 'current', 'custom'] as const;
export type ExportRange = typeof EXPORT_RANGES[number];

export interface ExportRangeContext {
  /** Rows in the filtered result the range addresses. */
  totalRows: number;
  currentPage: number;
  rowsPerPage: number;
  /** The typed bounds of a custom range: 1-based, inclusive, as entered. */
  startInput: string;
  endInput: string;
}

/**
 * The row window handed to the export command: `offset` / `limit` within
 * the filtered result, both absent for the whole result.
 */
export interface ExportWindow {
  offset?: number;
  limit?: number;
}

/**
 * Turn the chosen range into the window the backend exports, or null when
 * the range cannot be exported: a custom range whose bounds are not whole
 * numbers, start before row 1, end before they start or run past the last
 * row. Every range is spelled out so a new one cannot fall through to
 * "export everything".
 */
/**
 * A typed bound as a row number, or null when it is not one. The digits are
 * matched rather than parsed, because every numeric parse JS offers reads a
 * prefix and throws the rest away: `parseInt('2.5')` is 2 and `parseInt('1e1')`
 * is 1, so a bound that is not a row number would silently export a different
 * range from the one on screen. Surrounding whitespace is the one thing
 * forgiven — it is invisible in the field.
 */
function parseRowNumber(input: string): number | null {
  const trimmed = input.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

export function resolveExportRange(range: ExportRange, ctx: ExportRangeContext): ExportWindow | null {
  switch (range) {
    case 'all':
      return {};
    case 'current': {
      const { offset, limit } = pageWindow(ctx.currentPage, ctx.rowsPerPage, ctx.totalRows);
      return { offset, limit };
    }
    case 'custom': {
      const start = parseRowNumber(ctx.startInput);
      const end = parseRowNumber(ctx.endInput);
      const valid = start !== null && end !== null
        && start >= 1 && end >= start && end <= ctx.totalRows;
      return valid ? { offset: start - 1, limit: end - start + 1 } : null;
    }
    default:
      return assertNever(range, 'export range');
  }
}
