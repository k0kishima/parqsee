import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryChart } from '../query-chart';
import { buildChartModel } from '../../lib/chart-data';
import type { QueryChartType, QueryResult } from '../../types';

const cat: QueryChartType = { kind: 'category' };
const int: QueryChartType = { kind: 'integer' };

function result(rows: Record<string, unknown>[], series = ['y'], extra: Partial<QueryResult> = {}): QueryResult {
  return {
    columns: [{ name: 'x', data_type: 'Utf8', chart_type: cat }, ...series.map(name => ({ name, data_type: 'Int64', chart_type: int }))],
    rows,
    execution_time_ms: 1,
    truncated: false,
    max_rows: 10_000,
    ...extra,
  };
}

// jsdom lays nothing out: the observer reports a fixed plot size at once.
class FakeResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe() { this.callback([{ contentRect: { width: 600, height: 400 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
  unobserve() {}
  disconnect() {}
}
beforeAll(() => { vi.stubGlobal('ResizeObserver', FakeResizeObserver); });
afterAll(() => { vi.unstubAllGlobals(); });

const marks = () => Array.from(document.querySelectorAll('[data-mark]'));
const detail = () => screen.getByRole('group', { name: 'viewer.query.chart.detailLabel' });
const detailText = () => detail().querySelector('[aria-live]')!.textContent;

describe('QueryChart (bar)', () => {
  it('draws a bar per plotted point with its row and column, and describes the SVG', () => {
    const model = buildChartModel(result([{ x: 'a', y1: 2, y2: 3 }, { x: 'b', y1: null, y2: 4 }], ['y1', 'y2']), ['bar']);
    render(<QueryChart model={model} kind="bar" />);
    expect(document.querySelector('svg[data-chart-kind="bar"]')).toBeInTheDocument();
    expect(marks().map(m => [m.getAttribute('data-row-index'), m.getAttribute('data-column-index'), m.getAttribute('data-series-index')]))
      .toEqual([['0', '1', '0'], ['0', '2', '1'], ['1', '2', '1']]);
    expect(screen.getByRole('img', { name: 'viewer.query.chart.svgLabel' })).toHaveAttribute('aria-describedby');
    // The legend numbers every series.
    expect(screen.getAllByRole('button', { name: 'viewer.query.chart.seriesDetails' }).map(b => b.textContent)).toEqual(['#1 y1', '#2 y2']);
    expect(detailText()).toBe('viewer.query.chart.detailEmpty');
  });

  it('walks the plotted points from the detail box with the arrow keys, skipping missing cells', async () => {
    const model = buildChartModel(result(
      [{ x: 'a', y1: 1, y2: 10 }, { x: 'b', y1: null, y2: 20 }, { x: 'c', y1: 3, y2: null }],
      ['y1', 'y2'],
    ), ['bar']);
    render(<QueryChart model={model} kind="bar" />);
    const box = detail();
    box.focus();
    expect(box).toHaveFocus();

    await userEvent.keyboard('{ArrowRight}');
    expect(detailText()).toBe('viewer.query.chart.pointDescription');
    expect(document.querySelector('[data-mark][data-selected]')).toHaveAttribute('data-row-index', '0');
    await userEvent.keyboard('{ArrowRight}');
    // Row b has no y1: the next point of the series is row c.
    expect(document.querySelector('[data-mark][data-selected]')).toHaveAttribute('data-row-index', '2');
    await userEvent.keyboard('{ArrowRight}');
    expect(document.querySelector('[data-mark][data-selected]')).toHaveAttribute('data-row-index', '2');
    await userEvent.keyboard('{Home}');
    expect(document.querySelector('[data-mark][data-selected]')).toHaveAttribute('data-row-index', '0');
    // Down moves to the other series at the same row.
    await userEvent.keyboard('{ArrowDown}');
    const selected = document.querySelector('[data-mark][data-selected]')!;
    expect(selected).toHaveAttribute('data-series-index', '1');
    expect(selected).toHaveAttribute('data-row-index', '0');
    await userEvent.keyboard('{End}');
    expect(document.querySelector('[data-mark][data-selected]')).toHaveAttribute('data-row-index', '1');
    // Up from y2 at row b: y1 has no row b, so the nearest plotted row, the later one on a tie.
    await userEvent.keyboard('{ArrowUp}');
    const nearest = document.querySelector('[data-mark][data-selected]')!;
    expect(nearest).toHaveAttribute('data-series-index', '0');
    expect(nearest).toHaveAttribute('data-row-index', '2');
    expect(screen.getByRole('button', { name: 'viewer.query.chart.seriesDetails', pressed: true }).textContent).toBe('#1 y1');
  });

  it('moves the detail to a series from its legend button', async () => {
    const model = buildChartModel(result([{ x: 'a', y1: 1, y2: 10 }], ['y1', 'y2']), ['bar']);
    render(<QueryChart model={model} kind="bar" />);
    const [, second] = screen.getAllByRole('button', { name: 'viewer.query.chart.seriesDetails' });
    await userEvent.click(second);
    expect(second).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('[data-mark][data-selected]')).toHaveAttribute('data-series-index', '1');
  });

  it('shows a tooltip for the bar under the pointer and closes it on Escape', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    try {
      const model = buildChartModel(result([{ x: 'a', y: 5 }]), ['bar']);
      render(<QueryChart model={model} kind="bar" />);
      fireEvent.pointerMove(marks()[0], { clientX: 100, clientY: 100 });
      act(() => { vi.runAllTimers(); });
      expect(screen.getByRole('tooltip')).toHaveTextContent('viewer.query.chart.pointDescription');
      fireEvent.keyDown(detail(), { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      // The detail keeps the point after the tooltip closes.
      expect(detailText()).toBe('viewer.query.chart.pointDescription');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists what was left out, the columns not used as Y and the truncation', () => {
    const model = buildChartModel(result([{ x: 'a', y: 1, note: 'n' }, { x: 'b', y: 'NaN', note: 'm' }], ['y'], {
      truncated: true,
    }));
    model.diagnostics.ignoredColumns.push('note');
    render(<QueryChart model={{ ...model, series: model.series }} kind="bar" notice="switched" />);
    expect(screen.getByText('switched')).toBeInTheDocument();
    expect(screen.getByText('viewer.query.chart.partial')).toBeInTheDocument();
    expect(screen.getByText('viewer.query.chart.ignoredColumns')).toBeInTheDocument();
    expect(screen.getByText(/viewer\.query\.chart\.excluded · viewer\.query\.chart\.invalid/)).toBeInTheDocument();
  });

  it('shows the problem in place of the plot', () => {
    const model = buildChartModel(result([{ x: 'a', y: null }]), ['bar']);
    render(<QueryChart model={model} kind="bar" />);
    expect(screen.getByRole('status')).toHaveTextContent('viewer.query.chart.noValidPoints');
    expect(document.querySelector('svg[data-chart-kind]')).not.toBeInTheDocument();
  });

  it('draws a zero as a hairline on the baseline', () => {
    const model = buildChartModel(result([{ x: 'a', y: 0 }, { x: 'b', y: 10 }]), ['bar']);
    render(<QueryChart model={model} kind="bar" />);
    const [zero, ten] = marks();
    expect(Number(zero.getAttribute('height'))).toBe(2);
    expect(Number(ten.getAttribute('height'))).toBeGreaterThan(100);
  });
});
