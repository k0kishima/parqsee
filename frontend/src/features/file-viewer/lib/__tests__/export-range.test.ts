import { describe, it, expect } from 'vitest';
import { resolveExportRange, ExportRangeContext } from '../export-range';

const ctx = (overrides: Partial<ExportRangeContext> = {}): ExportRangeContext => ({
  totalRows: 120,
  currentPage: 3,
  rowsPerPage: 50,
  startInput: '1',
  endInput: '120',
  ...overrides,
});

describe('resolveExportRange', () => {
  it('exports the whole result with no window', () => {
    expect(resolveExportRange('all', ctx())).toEqual({});
  });

  it('addresses the current page by offset and page size', () => {
    expect(resolveExportRange('current', ctx())).toEqual({ offset: 100, limit: 50 });
    expect(resolveExportRange('current', ctx({ currentPage: 1 }))).toEqual({ offset: 0, limit: 50 });
  });

  it('turns a 1-based inclusive custom range into offset and limit', () => {
    expect(resolveExportRange('custom', ctx({ startInput: '5', endInput: '10' }))).toEqual({ offset: 4, limit: 6 });
    expect(resolveExportRange('custom', ctx({ startInput: '7', endInput: '7' }))).toEqual({ offset: 6, limit: 1 });
    expect(resolveExportRange('custom', ctx({ startInput: '1', endInput: '120' }))).toEqual({ offset: 0, limit: 120 });
  });

  it('rejects custom bounds that are not a span inside the result', () => {
    expect(resolveExportRange('custom', ctx({ startInput: '', endInput: '10' }))).toBeNull();
    expect(resolveExportRange('custom', ctx({ startInput: 'abc', endInput: '10' }))).toBeNull();
    expect(resolveExportRange('custom', ctx({ startInput: '0', endInput: '10' }))).toBeNull();
    expect(resolveExportRange('custom', ctx({ startInput: '10', endInput: '9' }))).toBeNull();
    expect(resolveExportRange('custom', ctx({ startInput: '1', endInput: '121' }))).toBeNull();
  });
});
