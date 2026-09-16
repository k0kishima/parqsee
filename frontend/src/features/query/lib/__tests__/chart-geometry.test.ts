import { describe, it, expect } from 'vitest';
import type { QueryChartType, QueryResult } from '../../types';
import { buildChartModel } from '../chart-data';
import { barGeometry, labelStride, PLOT_MARGIN } from '../chart-geometry';

const cat: QueryChartType = { kind: 'category' };
const int: QueryChartType = { kind: 'integer' };

function result(rows: Record<string, unknown>[], series = ['y']): QueryResult {
  return {
    columns: [{ name: 'x', data_type: 'Utf8', chart_type: cat }, ...series.map(name => ({ name, data_type: 'Int64', chart_type: int }))],
    rows,
    execution_time_ms: 1,
    truncated: false,
    max_rows: 10_000,
  };
}

const viewport = { width: 600, height: 400 };

describe('barGeometry', () => {
  it('draws one group per row and one bar per series from the baseline, negatives downward', () => {
    const model = buildChartModel(result([{ x: 'a', y1: 2, y2: 3 }, { x: 'b', y1: -1, y2: 4 }], ['y1', 'y2']));
    const geometry = barGeometry(model, viewport, 'en')!;
    expect(geometry.groups).toHaveLength(2);
    expect(geometry.marks).toHaveLength(4);
    const plotBottom = PLOT_MARGIN.top + geometry.plotHeight;
    // Domain [-1, 4]: zero sits a fifth of the way up.
    expect(geometry.baseline).toBeCloseTo(plotBottom - geometry.plotHeight / 5);
    const negative = geometry.marks.find(m => m.value === -1)!;
    expect(negative.y).toBeCloseTo(geometry.baseline);
    expect(negative.height).toBeCloseTo(geometry.plotHeight / 5);
    const top = geometry.marks.find(m => m.value === 4)!;
    expect(top.y).toBeCloseTo(PLOT_MARGIN.top);
    expect(top.y + top.height).toBeCloseTo(geometry.baseline);
    // Bars of a group sit side by side in series order, inside the group.
    const [a1, a2] = geometry.marks.filter(m => m.rowIndex === 0);
    expect(a2.x).toBeGreaterThan(a1.x + a1.width);
    expect(a2.x + a2.width).toBeLessThanOrEqual(geometry.groups[0].x + geometry.groups[0].width);
    expect(geometry.yTicks.map(t => t.label)).toEqual(['-1', '0', '1', '2', '3', '4']);
  });

  it('spreads few groups over the viewport and lets many overflow it at a readable width', () => {
    const few = barGeometry(buildChartModel(result([{ x: 'a', y: 1 }, { x: 'b', y: 2 }])), viewport, 'en')!;
    expect(few.contentWidth).toBeCloseTo(viewport.width);
    expect(few.groups[0].x).toBe(0);
    const rows = Array.from({ length: 200 }, (_, i) => ({ x: `r${i}`, y: i }));
    const many = barGeometry(buildChartModel(result(rows)), viewport, 'en')!;
    expect(many.contentWidth).toBeGreaterThan(viewport.width);
    expect(Math.min(...many.marks.map(m => m.width))).toBeGreaterThanOrEqual(6);
    expect(many.groups[1].x - many.groups[0].x).toBeGreaterThanOrEqual(28);
  });

  it('marks zero as a bar of no height on the baseline, distinct from a missing value', () => {
    const geometry = barGeometry(buildChartModel(result([{ x: 'a', y: 0 }, { x: 'b', y: null }, { x: 'c', y: 5 }])), viewport, 'en')!;
    expect(geometry.marks.map(m => m.rowIndex)).toEqual([0, 2]);
    expect(geometry.marks[0]).toMatchObject({ value: 0, height: 0, y: geometry.baseline });
  });

  it('returns nothing without a plottable point', () => {
    expect(barGeometry(buildChartModel(result([{ x: 'a', y: null }])), viewport, 'en')).toBeNull();
  });

  it('skips labels so they stay 80px apart', () => {
    expect(labelStride(100)).toBe(1);
    expect(labelStride(40)).toBe(2);
    expect(labelStride(28)).toBe(3);
  });
});
