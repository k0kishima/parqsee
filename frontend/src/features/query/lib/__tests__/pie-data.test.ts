import { describe, it, expect } from 'vitest';
import type { QueryChartType, QueryResult } from '../../types';
import { buildChartModel } from '../chart-data';
import { compensatedSum, MAX_PIE_ROWS, MAX_PIE_SLICES, pieData, type PieResult } from '../pie-data';

const T = {
  integer: { kind: 'integer' } as QueryChartType,
  float: { kind: 'float' } as QueryChartType,
  decimal: { kind: 'decimal' } as QueryChartType,
  date: { kind: 'date' } as QueryChartType,
  category: { kind: 'category' } as QueryChartType,
};

function result(columns: [string, QueryChartType][], rows: Record<string, unknown>[], extra: Partial<QueryResult> = {}): QueryResult {
  return {
    columns: columns.map(([name, chart_type]) => ({ name, data_type: chart_type.kind, chart_type })),
    rows,
    execution_time_ms: 1,
    truncated: false,
    max_rows: 10_000,
    ...extra,
  };
}

/** A category X and one integer Y, the shape a pie wants. */
const shares = (rows: Record<string, unknown>[], extra: Partial<QueryResult> = {}, y: QueryChartType = T.integer): PieResult =>
  pieData(buildChartModel(result([['x', T.category], ['y', y]], rows, extra), ['bar', 'pie']));

const rowsOf = (n: number, value: (i: number) => unknown = i => i + 1) =>
  Array.from({ length: n }, (_, i) => ({ x: `c${i}`, y: value(i) }));

const reason = (pie: PieResult) => (pie.ok ? null : pie.reason.code);
const slices = (pie: PieResult) => (pie.ok ? pie.data.slices.map(s => [s.id, s.value]) : null);

describe('compensatedSum', () => {
  it('keeps a small tail that a running sum would lose entirely', () => {
    const values = [1e16, ...Array.from({ length: 10 }, () => 1)];
    expect(values.reduce((a, b) => a + b, 0)).toBe(1e16);
    expect(compensatedSum(values)).toBe(10000000000000010);
  });
});

describe('pie availability', () => {
  it('takes a category X, one numeric column and a handful of rows', () => {
    const pie = shares([{ x: 'a', y: 1 }, { x: 'b', y: 3 }]);
    expect(pie.ok && pie.data).toMatchObject({ seriesName: 'y', total: 4, zeroRows: 0, approximate: false });
    expect(slices(pie)).toEqual([['1', 3], ['0', 1]]);
    expect(pie.ok && pie.data.slices.map(s => s.share)).toEqual([0.75, 0.25]);
  });

  it.each([
    ['a numeric X', pieData(buildChartModel(result([['x', T.integer], ['y', T.integer]], [{ x: 1, y: 1 }]))), 'pieCategory'],
    ['a temporal X', pieData(buildChartModel(result([['x', T.date], ['y', T.integer]], [{ x: '2024-01-01', y: 1 }]))), 'pieCategory'],
    ['two numeric columns', pieData(buildChartModel(result([['x', T.category], ['y', T.integer], ['z', T.integer]], [{ x: 'a', y: 1, z: 2 }]))), 'pieOneSeries'],
    ['a repeated category', shares([{ x: 'a', y: 1 }, { x: 'a', y: 2 }]), 'pieUnique'],
    ['a NULL category', shares([{ x: 'a', y: 1 }, { x: null, y: 2 }]), 'pieUnique'],
    ['a negative value', shares([{ x: 'a', y: 1 }, { x: 'b', y: -1 }]), 'pieValues'],
    ['a NULL value', shares([{ x: 'a', y: 1 }, { x: 'b', y: null }]), 'pieValues'],
    ['a value a double cannot hold', shares([{ x: 'a', y: 1 }, { x: 'b', y: '9007199254740993' }]), 'pieValues'],
    ['nothing but zeros', shares([{ x: 'a', y: 0 }, { x: 'b', y: 0 }]), 'pieValues'],
    ['a truncated result', shares([{ x: 'a', y: 1 }], { truncated: true }), 'piePartial'],
    ['a total no double can hold', shares([{ x: 'a', y: 1.7e308 }, { x: 'b', y: 1.7e308 }], {}, T.float), 'unsafeRange'],
    ['an integer total past the safe range', shares([{ x: 'a', y: 9007199254740991 }, { x: 'b', y: 9007199254740991 }]), 'unsafeRange'],
  ])('refuses %s', (_, pie, code) => {
    expect(reason(pie)).toBe(code);
  });

  it.each([[1, true], [MAX_PIE_SLICES, true], [MAX_PIE_SLICES + 1, true], [MAX_PIE_ROWS, true], [MAX_PIE_ROWS + 1, false]])(
    'takes %i rows: %s', (n, ok) => {
      const pie = shares(rowsOf(n));
      expect(pie.ok).toBe(ok);
      if (!ok) expect(pie.ok === false && pie.reason).toEqual({ code: 'pieRows', params: { max: MAX_PIE_ROWS } });
    });

  it('tells an empty category from a NULL one, so neither is merged into the other', () => {
    expect(reason(shares([{ x: '', y: 1 }, { x: null, y: 2 }]))).toBe('pieUnique');
    const pie = shares([{ x: '', y: 1 }, { x: 'a', y: 1 }]);
    expect(pie.ok && pie.data.slices.map(s => s.label)).toEqual(['', 'a']);
  });

  it('tells a boolean category from the text of the same word', () => {
    const pie = shares([{ x: true, y: 1 }, { x: 'true', y: 2 }]);
    expect(pie.ok && pie.data.slices.map(s => s.label)).toEqual(['true', 'true']);
  });

  it('says a float or decimal total is an approximation, and an integer one is not', () => {
    expect(shares([{ x: 'a', y: 0.5 }], {}, T.float)).toMatchObject({ data: { approximate: true } });
    expect(shares([{ x: 'a', y: '1.25' }], {}, T.decimal)).toMatchObject({ data: { approximate: true } });
    expect(shares([{ x: 'a', y: 2 }])).toMatchObject({ data: { approximate: false } });
  });
});

describe('pie slices', () => {
  it('orders by value, ties in row order, and keeps the exact cell of every row', () => {
    const pie = shares([{ x: 'a', y: 5 }, { x: 'b', y: 9 }, { x: 'c', y: 5 }]);
    expect(slices(pie)).toEqual([['1', 9], ['0', 5], ['2', 5]]);
    expect(pie.ok && pie.data.slices.map(s => s.raw)).toEqual([9, 5, 5]);
  });

  it('counts a zero row instead of drawing a slice of no area', () => {
    const pie = shares([{ x: 'a', y: 0 }, { x: 'b', y: 4 }, { x: 'c', y: -0 }]);
    expect(pie.ok && pie.data.zeroRows).toBe(2);
    expect(slices(pie)).toEqual([['1', 4]]);
    expect(pie.ok && pie.data.total).toBe(4);
  });

  it('gives one positive value the whole circle', () => {
    const pie = shares([{ x: 'a', y: 7 }]);
    expect(slices(pie)).toEqual([['0', 7]]);
    expect(pie.ok && pie.data.slices[0].share).toBe(1);
  });

  it('draws every row while they fit in the slices', () => {
    const pie = shares(rowsOf(MAX_PIE_SLICES));
    expect(pie.ok && pie.data.slices).toHaveLength(MAX_PIE_SLICES);
    expect(pie.ok && pie.data.slices.every(s => s.members.length === 0)).toBe(true);
  });

  it('sums the tail into a last Other slice that names the rows it swallowed', () => {
    const pie = shares(rowsOf(MAX_PIE_SLICES + 1));
    expect(pie.ok).toBe(true);
    if (!pie.ok) return;
    const { slices: drawn, total } = pie.data;
    expect(drawn).toHaveLength(MAX_PIE_SLICES);
    expect(drawn.slice(0, 7).map(s => s.value)).toEqual([9, 8, 7, 6, 5, 4, 3]);
    const other = drawn[MAX_PIE_SLICES - 1];
    expect(other).toMatchObject({ id: 'other', rowIndex: null, raw: null, value: 3 });
    expect(other.members.map(m => [m.rowIndex, m.value])).toEqual([[1, 2], [0, 1]]);
    expect(other.share).toBeCloseTo(3 / total, 12);
    expect(other.members.reduce((sum, m) => sum + m.share, 0)).toBeCloseTo(other.share, 12);
  });

  it('keeps a row whose own category reads Other apart from the aggregate', () => {
    const rows = rowsOf(MAX_PIE_SLICES + 1);
    rows[0] = { x: 'Other', y: 100 };
    const pie = shares(rows);
    expect(pie.ok && pie.data.slices[0]).toMatchObject({ id: '0', label: 'Other', value: 100 });
    expect(pie.ok && pie.data.slices[MAX_PIE_SLICES - 1]).toMatchObject({ id: 'other', rowIndex: null });
  });

  it('carries the whole tail of a full-sized result, biggest first', () => {
    const pie = shares(rowsOf(MAX_PIE_ROWS));
    expect(pie.ok).toBe(true);
    if (!pie.ok) return;
    const other = pie.data.slices[MAX_PIE_SLICES - 1];
    expect(other.members).toHaveLength(MAX_PIE_ROWS - (MAX_PIE_SLICES - 1));
    expect(other.members.map(m => m.value)).toEqual([...other.members.map(m => m.value)].sort((a, b) => b - a));
    expect(other.value + pie.data.slices.slice(0, 7).reduce((sum, s) => sum + s.value, 0)).toBe(pie.data.total);
  });
});
