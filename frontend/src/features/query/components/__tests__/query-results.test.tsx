import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryResults } from '../query-results';
import type { QueryResult } from '../../types';

type RowDensity = 'comfortable' | 'compact';

const settings = { rowsPerPage: 50, typeDisplay: 'logical', rowDensity: 'comfortable' as RowDensity };
vi.mock('../../../../contexts/SettingsContext', () => ({
  useSettings: () => ({ settings, updateSettings: () => {}, effectiveTheme: 'light' as const }),
}));

const result = (rows: number): QueryResult => ({
  columns: [{ name: 'id', data_type: 'Int64', chart_type: { kind: 'integer' } }],
  rows: Array.from({ length: rows }, (_, i) => ({ id: i })),
  execution_time_ms: 1,
  truncated: false,
  max_rows: 10_000,
  result_id: 'r1',
});

/**
 * jsdom lays nothing out, so every row measures zero and the grid would
 * never re-measure. Give each rendered row the pitch its density has,
 * placed by its row index, which is what a real layout would report.
 */
const pitchByDensity: Record<RowDensity, number> = { comfortable: 30, compact: 18 };
const layOutRows = () =>
  vi.spyOn(HTMLTableRowElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLTableRowElement) {
    const pitch = pitchByDensity[settings.rowDensity];
    const index = Number(this.dataset.row);
    return { top: index * pitch, bottom: (index + 1) * pitch, height: pitch } as DOMRect;
  });

/** The pitch the grid is sizing rows with, read off the spacers it sized with it. */
const measuredPitch = (total: number) => {
  const body = document.querySelector('tbody')!;
  const spacers = Array.from(body.querySelectorAll<HTMLTableRowElement>('tr[aria-hidden="true"]'))
    .reduce((sum, row) => sum + parseFloat(row.style.height), 0);
  const rendered = body.querySelectorAll('tr[data-row]').length;
  // spacers + rendered * pitch === total * pitch
  return spacers / (total - rendered);
};

afterEach(() => {
  settings.rowDensity = 'comfortable';
  vi.restoreAllMocks();
});

describe('QueryResults grid density', () => {
  it('pads the cells for the density in force', () => {
    const { rerender } = render(<QueryResults result={result(3)} isLoading={false} />);
    const cell = () => document.querySelector('tbody td')!.className;
    const header = () => document.querySelector('thead th')!.className;
    expect(cell()).toContain('py-1.5');
    expect(header()).toContain('py-2');

    settings.rowDensity = 'compact';
    rerender(<QueryResults result={result(3)} isLoading={false} />);
    expect(cell()).toContain('py-0.5');
    expect(cell()).not.toContain('py-1.5');
    expect(header()).toContain('py-1');
  });

  it('measures the row pitch again when the density changes', () => {
    layOutRows();
    const rows = 200;
    const { rerender } = render(<QueryResults result={result(rows)} isLoading={false} />);
    expect(measuredPitch(rows)).toBeCloseTo(30);

    settings.rowDensity = 'compact';
    rerender(<QueryResults result={result(rows)} isLoading={false} />);
    expect(measuredPitch(rows)).toBeCloseTo(18);
  });
});
