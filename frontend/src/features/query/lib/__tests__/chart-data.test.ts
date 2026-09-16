import { describe, it, expect } from 'vitest';
import type { QueryChartType, QueryResult } from '../../types';
import { buildChartModel, inferChartKind, MAX_CHART_POINTS, parseDecimal, parseFloat64, parseInteger } from '../chart-data';
import type { ChartAvailability, ChartKind } from '../chart-types';

const T = {
  integer: { kind: 'integer' } as QueryChartType,
  float: { kind: 'float' } as QueryChartType,
  decimal: { kind: 'decimal' } as QueryChartType,
  date: { kind: 'date' } as QueryChartType,
  timestamp: { kind: 'timestamp', timezone: null } as QueryChartType,
  category: { kind: 'category' } as QueryChartType,
  unsupported: { kind: 'unsupported' } as QueryChartType,
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

describe('value parsing', () => {
  it('accepts integers inside the safe range, as numbers or as the strings big ones arrive as', () => {
    expect(parseInteger(42)).toEqual({ ok: true, value: 42 });
    expect(parseInteger('9007199254740991')).toEqual({ ok: true, value: 9007199254740991 });
    expect(parseInteger('-9007199254740991')).toEqual({ ok: true, value: -9007199254740991 });
    expect(parseInteger('9007199254740992')).toEqual({ ok: false, reason: 'precision' });
    expect(parseInteger(2 ** 53)).toEqual({ ok: false, reason: 'precision' });
    expect(parseInteger(1.5)).toEqual({ ok: false, reason: 'precision' });
    expect(parseInteger(null)).toEqual({ ok: false, reason: 'missing' });
    expect(parseInteger(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(parseInteger('12abc')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseInteger(true)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('keeps finite floats and counts NaN and the infinities as non-finite, not missing', () => {
    expect(parseFloat64(0.5)).toEqual({ ok: true, value: 0.5 });
    expect(parseFloat64(-0)).toEqual({ ok: true, value: -0 });
    expect(parseFloat64('NaN')).toEqual({ ok: false, reason: 'nonFinite' });
    expect(parseFloat64('Infinity')).toEqual({ ok: false, reason: 'nonFinite' });
    expect(parseFloat64('-Infinity')).toEqual({ ok: false, reason: 'nonFinite' });
    expect(parseFloat64(Infinity)).toEqual({ ok: false, reason: 'nonFinite' });
    expect(parseFloat64(null)).toEqual({ ok: false, reason: 'missing' });
    expect(parseFloat64('1.5')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('plots decimals a double carries exactly enough and refuses the rest as precision', () => {
    expect(parseDecimal('12345.67')).toEqual({ ok: true, value: 12345.67 });
    expect(parseDecimal('-0.0001')).toEqual({ ok: true, value: -0.0001 });
    expect(parseDecimal('+3.00')).toEqual({ ok: true, value: 3 });
    expect(parseDecimal('0.000')).toEqual({ ok: true, value: 0 });
    expect(parseDecimal('123456789012345.6')).toEqual({ ok: false, reason: 'precision' });
    expect(parseDecimal('9007199254740993')).toEqual({ ok: false, reason: 'precision' });
    expect(parseDecimal('100000000000000000000')).toEqual({ ok: false, reason: 'precision' });
    expect(parseDecimal('1e5')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDecimal(' 1.5')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDecimal(1.5)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDecimal(null)).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('buildChartModel', () => {
  it('takes the first column as X and every numeric column after it as a series, in order', () => {
    const model = buildChartModel(result(
      [['cat', T.category], ['n', T.integer], ['note', T.category], ['avg', T.float], ['amount', T.decimal]],
      [{ cat: 'a', n: 1, note: 'x', avg: 0.5, amount: '1.25' }, { cat: 'b', n: 2, note: 'y', avg: 1.5, amount: '2.50' }],
    ));
    expect(model.problem).toBeNull();
    expect(model.x).toMatchObject({ name: 'cat', kind: 'category' });
    expect(model.series.map(s => [s.name, s.ordinal, s.type, s.validCount])).toEqual([['n', 0, 'integer', 2], ['avg', 1, 'float', 2], ['amount', 2, 'decimal', 2]]);
    expect(model.diagnostics.ignoredColumns).toEqual(['note']);
    expect(model.points).toHaveLength(6);
    expect(model.points[2]).toEqual({ rowIndex: 0, seriesOrdinal: 2, y: 1.25, raw: '1.25' });
    expect(model.yExtent).toEqual({ min: 0.5, max: 2.5 });
    expect(model.rows.map(r => r.label)).toEqual(['a', 'b']);
    expect(model.inferred).toBe('bar');
  });

  it.each([
    ['category', T.category, 'bar'],
    ['date', T.date, 'line'],
    ['timestamp', T.timestamp, 'line'],
    ['integer', T.integer, 'scatter'],
    ['float', T.float, 'scatter'],
  ] as const)('infers the kind from a %s X when every kind is implemented', (_, type, expected) => {
    const raw = type.kind === 'category' ? 'a' : type.kind === 'date' ? '2024-01-01' : type.kind === 'timestamp' ? '2024-01-01T00:00:00' : 1;
    const model = buildChartModel(result([['x', type], ['y', T.integer]], [{ x: raw, y: 1 }]));
    expect(model.inferred).toBe(expected);
  });

  it('falls back to bar while only bar is implemented, and hides nothing from availability', () => {
    const model = buildChartModel(result([['t', T.date], ['y', T.integer]], [{ t: '2024-01-01', y: 1 }]), ['bar']);
    expect(model.inferred).toBe('bar');
    expect(model.availability.line).toEqual({ available: true });
    expect(model.availability.scatter).toEqual({ available: false, reason: { code: 'numericXRequired', params: undefined } });
    expect(model.availability.pie.available).toBe(false);
  });

  it('never infers pie', () => {
    const availability: Record<ChartKind, ChartAvailability> = { bar: { available: true }, line: { available: true }, scatter: { available: true }, pie: { available: true } };
    expect(inferChartKind('category', availability, ['pie'])).toBeNull();
    expect(inferChartKind('category', availability, ['pie', 'line'])).toBe('line');
  });

  it.each([
    ['no rows', result([['x', T.category], ['y', T.integer]], []), 'empty'],
    ['one column', result([['y', T.integer]], [{ y: 1 }]), 'needColumns'],
    ['no numeric column', result([['x', T.category], ['s', T.category]], [{ x: 'a', s: 'b' }]), 'needColumns'],
    ['an unsupported X', result([['x', T.unsupported], ['y', T.integer]], [{ x: [1], y: 1 }]), 'unsupportedX'],
    ['duplicate names', result([['x', T.category], ['x', T.integer]], [{ x: 'a' }]), 'duplicateColumns'],
    ['every value missing', result([['x', T.category], ['y', T.integer]], [{ x: 'a', y: null }, { x: null, y: 1 }]), 'noValidPoints'],
    ['more rows than the cap says', result([['x', T.category], ['y', T.integer]], [{ x: 'a', y: 1 }, { x: 'b', y: 2 }], { max_rows: 1 }), 'invalidResult'],
    ['a nonsensical cap', result([['x', T.category], ['y', T.integer]], [{ x: 'a', y: 1 }], { max_rows: 0 }), 'invalidResult'],
  ])('refuses %s', (_, res, code) => {
    const model = buildChartModel(res);
    expect(model.problem?.code).toBe(code);
    expect(model.inferred).toBeNull();
    expect(model.points).toEqual([]);
    expect(model.availability.bar).toEqual({ available: false, reason: model.problem });
  });

  it('refuses a result whose columns carry no chart type without guessing from the display type', () => {
    const res = result([['x', T.category], ['y', T.integer]], [{ x: 'a', y: 1 }]);
    const stripped = { ...res, columns: res.columns.map(c => ({ name: c.name, data_type: 'Int64' })) } as unknown as QueryResult;
    expect(buildChartModel(stripped).problem?.code).toBe('missingType');
  });

  it('keeps the ignored columns in the diagnostics when nothing numeric is left', () => {
    const model = buildChartModel(result([['x', T.category], ['s', T.category], ['b', T.unsupported]], [{ x: 'a', s: 'b', b: null }]));
    expect(model.problem?.code).toBe('needColumns');
    expect(model.diagnostics.ignoredColumns).toEqual(['s', 'b']);
  });

  it('counts exclusions by reason, an invalid X costing the row every series, and never plots them', () => {
    const model = buildChartModel(result(
      [['x', T.category], ['n', T.integer], ['f', T.float]],
      [
        { x: 'a', n: 1, f: 0.5 },
        { x: null, n: 2, f: 1.5 },                       // X missing: 2 points missing
        { x: 'c', n: '9007199254740993', f: 'NaN' },     // precision + nonFinite
        { x: 'd', f: 2.5 },                              // n omitted: missing
        { x: 'e', n: 'abc', f: 'Infinity' },             // invalid + nonFinite
      ],
    ));
    expect(model.problem).toBeNull();
    expect(model.diagnostics).toEqual({
      candidatePoints: 10,
      excludedPoints: 7,
      byReason: { missing: 3, nonFinite: 2, precision: 1, invalid: 1 },
      ignoredColumns: [],
    });
    expect(model.rows.map(r => r.valid)).toEqual([true, false, true, true, true]);
    expect(model.points.map(p => [p.rowIndex, p.seriesOrdinal])).toEqual([[0, 0], [0, 1], [3, 1]]);
    expect(model.series.map(s => s.validCount)).toEqual([1, 2]);
  });

  it('treats a numeric X like a Y: a big integer is not rescued as a label', () => {
    const model = buildChartModel(result([['id', T.integer], ['y', T.integer]], [{ id: 1, y: 1 }, { id: '9007199254740993', y: 2 }]));
    expect(model.rows[1]).toMatchObject({ valid: false, label: '9007199254740993', value: null });
    expect(model.rows[0]).toMatchObject({ valid: true, value: 1 });
    expect(model.diagnostics.byReason.precision).toBe(1);
  });

  it('labels a boolean X by its value and an empty string as itself, distinct from NULL', () => {
    const model = buildChartModel(result([['x', T.category], ['y', T.integer]], [{ x: true, y: 1 }, { x: '', y: 2 }, { x: 'NULL', y: 3 }, { x: null, y: 4 }]));
    expect(model.rows.map(r => [r.label, r.valid])).toEqual([['true', true], ['', true], ['NULL', true], ['', false]]);
    expect(model.rows[3].raw).toBeNull();
  });

  it('applies the point cap to the valid points of every series together', () => {
    const rows = (n: number, series: number) => Array.from({ length: n }, (_, i) => Object.fromEntries([['x', `r${i}`], ...Array.from({ length: series }, (_, j) => [`y${j}`, i])]));
    const cols = (series: number): [string, QueryChartType][] => [['x', T.category], ...Array.from({ length: series }, (_, j): [string, QueryChartType] => [`y${j}`, T.integer])];
    expect(buildChartModel(result(cols(1), rows(10_000, 1))).problem).toBeNull();
    expect(buildChartModel(result(cols(2), rows(5_000, 2))).problem).toBeNull();
    const over = buildChartModel(result(cols(2), rows(5_001, 2)));
    expect(over.problem).toEqual({ code: 'pointLimit', params: { max: MAX_CHART_POINTS, count: 10_002 } });
    expect(over.points).toEqual([]);
    // NULLs do not count: 5,001 rows with one series blank on one row fit.
    const withNull = rows(5_001, 2);
    withNull[0].y1 = null;
    withNull[1].y1 = null;
    expect(buildChartModel(result(cols(2), withNull)).problem).toBeNull();
  });

  it('refuses two finite values whose difference overflows', () => {
    const model = buildChartModel(result([['x', T.category], ['y', T.float]], [{ x: 'a', y: 1.7e308 }, { x: 'b', y: -1.7e308 }]));
    expect(model.problem?.code).toBe('unsafeRange');
  });

  it('carries the truncation flag so the chart can say it is of the first rows', () => {
    expect(buildChartModel(result([['x', T.category], ['y', T.integer]], [{ x: 'a', y: 1 }], { truncated: true })).truncated).toBe(true);
  });
});
