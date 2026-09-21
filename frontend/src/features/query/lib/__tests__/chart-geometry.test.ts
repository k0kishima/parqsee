import { describe, it, expect } from 'vitest';
import type { QueryChartType, QueryResult } from '../../types';
import { buildChartModel } from '../chart-data';
import { arcPath, barGeometry, labelStride, lineGeometry, nearestVertex, pieGeometry, PLOT_MARGIN, scatterGeometry } from '../chart-geometry';

const cat: QueryChartType = { kind: 'category' };
const int: QueryChartType = { kind: 'integer' };

function result(rows: Record<string, unknown>[], series = ['y']): QueryResult {
  return {
    columns: [{ name: 'x', data_type: 'Utf8', chart_type: cat }, ...series.map(name => ({ name, data_type: 'Int64', chart_type: int }))],
    rows,
    execution_time_ms: 1,
    truncated: false,
    max_rows: 10_000,
  result_id: 'r1',
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
    // Two groups over 600px: the bars are capped, not a screen wide, and centred in the group.
    expect(a1.width).toBe(48);
    expect(a1.x - geometry.groups[0].x).toBeCloseTo(geometry.groups[0].x + geometry.groups[0].width - (a2.x + a2.width));
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

describe('pieGeometry', () => {
  const quarters = [
    { id: 'a', value: 1 },
    { id: 'b', value: 1 },
    { id: 'c', value: 1 },
    { id: 'd', value: 1 },
  ];

  it('runs clockwise from 12 o\'clock and closes the circle exactly', () => {
    const geometry = pieGeometry(quarters, viewport)!;
    expect(geometry.arcs.map(a => a.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(geometry.arcs.map(a => a.startAngle)).toEqual([0, Math.PI / 2, Math.PI, Math.PI * 1.5]);
    expect(geometry.arcs[3].endAngle).toBe(Math.PI * 2);
    // The first wedge leaves the centre straight up and comes back at 3 o'clock.
    expect(geometry.arcs[0].path).toBe(`M 200 200 L 200 12 A 188 188 0 0 1 388 200 Z`);
  });

  it('takes the angles from the running total, so rounding cannot leave a gap', () => {
    const thirds = [{ id: 'a', value: 1 }, { id: 'b', value: 1 }, { id: 'c', value: 1 }];
    const geometry = pieGeometry(thirds, viewport)!;
    expect(geometry.arcs[2].endAngle).toBe(Math.PI * 2);
    geometry.arcs.forEach((arc, i) => { if (i > 0) expect(arc.startAngle).toBe(geometry.arcs[i - 1].endAngle); });
  });

  it('flags a wedge past a half circle so its arc takes the long way round', () => {
    const geometry = pieGeometry([{ id: 'big', value: 3 }, { id: 'rest', value: 1 }], viewport)!;
    expect(geometry.arcs[0].path).toContain(' 1 1 ');
    expect(geometry.arcs[1].path).toContain(' 0 1 ');
  });

  it('draws one slice as a circle rather than an arc from a point back to itself', () => {
    const geometry = pieGeometry([{ id: 'all', value: 5 }], viewport)!;
    expect(geometry.whole).toBe(true);
    expect(geometry.arcs[0]).toMatchObject({ startAngle: 0, endAngle: Math.PI * 2, path: null });
  });

  it('fits the circle in the shorter side of its box, never below a legible size', () => {
    expect(pieGeometry(quarters, { width: 600, height: 240 })!.size).toBe(240);
    expect(pieGeometry(quarters, { width: 120, height: 400 })!.size).toBe(120);
    expect(pieGeometry(quarters, { width: 20, height: 20 })!.size).toBe(96);
    expect(pieGeometry([], viewport)).toBeNull();
  });

  it('measures its angles from 12 o\'clock clockwise', () => {
    expect(arcPath(0, 0, 10, 0, Math.PI / 2)).toBe('M 0 0 L 0 -10 A 10 10 0 0 1 10 0 Z');
    expect(arcPath(0, 0, 10, Math.PI, Math.PI * 1.5)).toBe('M 0 0 L 0 10 A 10 10 0 0 1 -10 0 Z');
  });
});

const date: QueryChartType = { kind: 'date' };
const ts: QueryChartType = { kind: 'timestamp', timezone: null };

function timeResult(xType: QueryChartType, rows: Record<string, unknown>[], series = ['y']): QueryResult {
  return {
    columns: [{ name: 't', data_type: 'Date32', chart_type: xType }, ...series.map(name => ({ name, data_type: 'Int64', chart_type: int }))],
    rows,
    execution_time_ms: 1,
    truncated: false,
    max_rows: 10_000,
  result_id: 'r1',
  };
}

describe('lineGeometry', () => {
  it('draws one path per series, the first and last points inside the plot', () => {
    const model = buildChartModel(timeResult(date, [
      { t: '2024-01-01', y1: 1, y2: 5 },
      { t: '2024-01-02', y1: 2, y2: 4 },
      { t: '2024-01-03', y1: 3, y2: 3 },
    ], ['y1', 'y2']));
    const geometry = lineGeometry(model, viewport, 'en')!;
    expect(geometry.series).toHaveLength(2);
    expect(geometry.series[0].vertices).toHaveLength(3);
    expect(geometry.series[0].isolated).toEqual([]);
    expect(geometry.series[0].path.startsWith('M ')).toBe(true);
    expect(geometry.series[0].path.match(/L/g)).toHaveLength(2);
    const [first, , last] = geometry.series[0].vertices;
    expect(first.x).toBeGreaterThan(0);
    expect(last.x).toBeLessThan(geometry.contentWidth);
    expect(last.x).toBeGreaterThan(first.x);
  });

  it('cuts the path at a gap instead of drawing over it, per series', () => {
    const model = buildChartModel(timeResult(date, [
      { t: '2024-01-01', y1: 1, y2: 1 },
      { t: '2024-01-02', y1: null, y2: 2 },
      { t: '2024-01-03', y1: 3, y2: 3 },
      { t: '2024-01-04', y1: 4, y2: 4 },
    ], ['y1', 'y2']));
    const geometry = lineGeometry(model, viewport, 'en')!;
    // y1 loses the second row: a lone point, then a pair. y2 is unbroken.
    expect(geometry.series[0].path.match(/M/g)).toHaveLength(1);
    expect(geometry.series[0].isolated.map(v => v.rowIndex)).toEqual([0]);
    expect(geometry.series[1].path.match(/M/g)).toHaveLength(1);
    expect(geometry.series[1].isolated).toEqual([]);
  });

  it('breaks every series where the X itself cannot be placed', () => {
    const model = buildChartModel(timeResult(date, [
      { t: '2024-01-01', y: 1 },
      { t: '2024-02-30', y: 2 },
      { t: '2024-01-03', y: 3 },
    ]));
    const geometry = lineGeometry(model, viewport, 'en')!;
    expect(geometry.series[0].vertices.map(v => v.rowIndex)).toEqual([0, 2]);
    expect(geometry.series[0].path).toBe('');
    expect(geometry.series[0].isolated.map(v => v.rowIndex)).toEqual([0, 2]);
  });

  it('connects the rows in the order they came, even when X goes backwards', () => {
    const model = buildChartModel(timeResult(date, [
      { t: '2024-01-03', y: 1 },
      { t: '2024-01-01', y: 2 },
      { t: '2024-01-05', y: 3 },
    ]));
    expect(model.xOutOfOrder).toBe(true);
    const geometry = lineGeometry(model, viewport, 'en')!;
    const [a, b, c] = geometry.series[0].vertices;
    expect(b.x).toBeLessThan(a.x);
    expect(c.x).toBeGreaterThan(a.x);
    expect(geometry.series[0].path.match(/L/g)).toHaveLength(2);
  });

  it('keeps two rows with the same X as two vertices rather than combining them', () => {
    const model = buildChartModel(timeResult(date, [
      { t: '2024-01-01', y: 1 }, { t: '2024-01-02', y: 2 }, { t: '2024-01-02', y: 4 },
    ]));
    const geometry = lineGeometry(model, viewport, 'en')!;
    const [, second, third] = geometry.series[0].vertices;
    expect(geometry.series[0].vertices).toHaveLength(3);
    expect(third.x).toBeCloseTo(second.x);
    expect(third.y).not.toBeCloseTo(second.y);
    // One run: the query returned them in a row, so the line goes straight up.
    expect(geometry.series[0].path.match(/M/g)).toHaveLength(1);
  });

  it('ticks the X axis by the calendar and names the days when the labels are clock times', () => {
    const daily = buildChartModel(timeResult(date, [
      { t: '2024-01-01', y: 1 }, { t: '2024-02-01', y: 2 }, { t: '2024-03-01', y: 3 },
    ]));
    const overMonths = lineGeometry(daily, viewport, 'en')!;
    expect(overMonths.xTicks.every(tick => /^\d{4}-\d{2}(-\d{2})?$/.test(tick.label))).toBe(true);
    expect(overMonths.xDates).toBeNull();

    const seconds = buildChartModel(timeResult(ts, [
      { t: '2024-01-02T03:04:05', y: 1 }, { t: '2024-01-02T03:04:35', y: 2 },
    ]));
    const overSeconds = lineGeometry(seconds, viewport, 'en')!;
    expect(overSeconds.xTicks.every(tick => /^\d{2}:\d{2}:\d{2}$/.test(tick.label))).toBe(true);
    expect(overSeconds.xDates).toEqual(['2024-01-02']);
  });

  it('gives a single instant a plot to sit in the middle of', () => {
    const model = buildChartModel(timeResult(date, [{ t: '2024-01-01', y: 1 }, { t: '2024-01-01', y: 3 }]));
    const geometry = lineGeometry(model, viewport, 'en')!;
    const [first, second] = geometry.series[0].vertices;
    expect(first.x).toBeCloseTo(geometry.contentWidth / 2);
    expect(second.x).toBeCloseTo(first.x);
  });

  it('answers the pointer with the nearest vertex, and with nothing when it is far', () => {
    const model = buildChartModel(timeResult(date, [
      { t: '2024-01-01', y: 1 }, { t: '2024-01-02', y: 2 }, { t: '2024-01-03', y: 3 },
    ]));
    const geometry = lineGeometry(model, viewport, 'en')!;
    const target = geometry.series[0].vertices[1];
    expect(nearestVertex(geometry, { x: target.x + 3, y: target.y - 4 })).toBe(target);
    expect(nearestVertex(geometry, { x: target.x, y: target.y }, 40)).toBe(target);
    expect(nearestVertex(geometry, { x: target.x + 300, y: target.y + 300 })).toBeNull();
  });
});

function numericResult(rows: Record<string, unknown>[], series = ['y']): QueryResult {
  return {
    columns: [{ name: 'x', data_type: 'Int64', chart_type: int }, ...series.map(name => ({ name, data_type: 'Int64', chart_type: int }))],
    rows,
    execution_time_ms: 1,
    truncated: false,
    max_rows: 10_000,
  result_id: 'r1',
  };
}

describe('scatterGeometry', () => {
  it('places a mark per plotted pair, in column order and then row order', () => {
    const model = buildChartModel(numericResult([
      { x: 1, y1: 10, y2: 20 },
      { x: 2, y1: 11, y2: null },
      { x: 3, y1: 12, y2: 22 },
    ], ['y1', 'y2']));
    const geometry = scatterGeometry(model, viewport, 'en')!;
    expect(geometry.marks.map(m => [m.seriesOrdinal, m.rowIndex])).toEqual([[0, 0], [0, 1], [0, 2], [1, 0], [1, 2]]);
    // Each mark keeps the row it came from, and its value as it arrived.
    expect(geometry.marks[4]).toMatchObject({ rowIndex: 2, seriesOrdinal: 1, value: 22, raw: 22 });
    // X grows to the right, Y upwards.
    expect(geometry.marks[0].x).toBeLessThan(geometry.marks[2].x);
    expect(geometry.marks[0].y).toBeGreaterThan(geometry.marks[2].y);
  });

  it('pads both axes, so the extremes are not sitting on the frame', () => {
    const model = buildChartModel(numericResult([{ x: 0, y: 0 }, { x: 10, y: 100 }]));
    const geometry = scatterGeometry(model, viewport, 'en')!;
    const [low, high] = geometry.marks;
    expect(geometry.xScale.domain).toEqual({ min: -0.5, max: 10.5 });
    expect(geometry.yScale.domain).toEqual({ min: -5, max: 105 });
    expect(low.x).toBeGreaterThan(geometry.xScale.range[0]);
    expect(high.x).toBeLessThan(geometry.xScale.range[1]);
    expect(low.y).toBeLessThan(PLOT_MARGIN.top + geometry.plotHeight);
    expect(high.y).toBeGreaterThan(PLOT_MARGIN.top);
  });

  it('draws every point the model allows, without thinning them', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ x: i, y: i % 97 }));
    const model = buildChartModel(numericResult(rows));
    expect(model.problem).toBeNull();
    expect(scatterGeometry(model, viewport, 'en')!.marks).toHaveLength(10_000);
  });

  it('has no plot without a coordinate for X', () => {
    const labels = buildChartModel(result([{ x: 'a', y: 1 }]));
    expect(scatterGeometry(labels, viewport, 'en')).toBeNull();
  });
});
