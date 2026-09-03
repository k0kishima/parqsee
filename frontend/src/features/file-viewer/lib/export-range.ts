import { assertNever } from '../../../lib/exhaustive';

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
export function resolveExportRange(range: ExportRange, ctx: ExportRangeContext): ExportWindow | null {
  switch (range) {
    case 'all':
      return {};
    case 'current':
      return { offset: (ctx.currentPage - 1) * ctx.rowsPerPage, limit: ctx.rowsPerPage };
    case 'custom': {
      const start = parseInt(ctx.startInput, 10);
      const end = parseInt(ctx.endInput, 10);
      const valid = Number.isInteger(start) && Number.isInteger(end)
        && start >= 1 && end >= start && end <= ctx.totalRows;
      return valid ? { offset: start - 1, limit: end - start + 1 } : null;
    }
    default:
      return assertNever(range, 'export range');
  }
}
