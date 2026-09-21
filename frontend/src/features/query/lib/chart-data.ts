import type { QueryChartType, QueryResult } from '../types';
import { formatCellValue } from '../../../lib/format';
import { assertNever } from '../../../lib/exhaustive';
import {
  CHART_KINDS,
  type ChartAvailability,
  type ChartKind,
  type ChartModel,
  type ChartPoint,
  type ChartProblem,
  type ChartRow,
  type ChartSeries,
  type ExclusionReason,
  type NumericKind,
  type XKind,
} from './chart-types';
import { parseDateValue, parseTimestampValue } from './chart-time';
import { pieData } from './pie-data';

/**
 * The most data points a chart draws, summed over every series — the SQL
 * view's own row cap, reused so a two-series result needs at most 5,000
 * rows. Past it the chart is refused and the SQL asked to narrow, never
 * thinned: a sample would draw a shape the query did not return (Q2).
 */
export const MAX_CHART_POINTS = 10_000;

/** A parsed Y value, or why the cell has none. */
export type ParsedNumber = { ok: true; value: number } | { ok: false; reason: ExclusionReason };

const MISSING: ParsedNumber = { ok: false, reason: 'missing' };
const NON_FINITE: ParsedNumber = { ok: false, reason: 'nonFinite' };
const PRECISION: ParsedNumber = { ok: false, reason: 'precision' };
const INVALID: ParsedNumber = { ok: false, reason: 'invalid' };

const isMissing = (value: unknown) => value === null || value === undefined;

/**
 * An integer column: `batches_to_rows` sends values inside ±2^53 as
 * numbers and the rest as decimal strings. A string is parsed with BigInt
 * and only accepted back inside the safe range — a double could not hold
 * it exactly, and a chart that silently rounded 9007199254740993 to
 * ...992 would be lying by one. The precision count tells the user, and a
 * CAST to DOUBLE in the SQL is how they opt into the approximation.
 */
export function parseInteger(value: unknown): ParsedNumber {
  if (isMissing(value)) return MISSING;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? { ok: true, value } : PRECISION;
  if (typeof value !== 'string' || !/^[+-]?\d+$/.test(value)) return INVALID;
  const big = BigInt(value);
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < -BigInt(Number.MAX_SAFE_INTEGER)) return PRECISION;
  return { ok: true, value: Number(big) };
}

/**
 * A float column: finite numbers as they come; NaN and the infinities
 * arrive as the strings `batches_to_rows` spells them with and are counted
 * as non-finite rather than drawn at the edge of the plot.
 */
export function parseFloat64(value: unknown): ParsedNumber {
  if (isMissing(value)) return MISSING;
  if (typeof value === 'number') return Number.isFinite(value) ? { ok: true, value } : NON_FINITE;
  if (typeof value === 'string' && ['NaN', 'Infinity', '-Infinity'].includes(value)) return NON_FINITE;
  return INVALID;
}

const DECIMAL = /^([+-])?(\d+)(?:\.(\d+))?$/;

/**
 * A decimal column arrives as its exact string. It is plotted only when a
 * double can carry it: at most 15 significant digits (the digits of the
 * coefficient without leading and trailing zeros), a magnitude inside the
 * safe-integer range, and a non-zero that does not round to zero. Anything
 * finer is counted under precision — the table and the details keep the
 * exact string, and `CAST(... AS DOUBLE)` opts into the approximation.
 */
export function parseDecimal(value: unknown): ParsedNumber {
  if (isMissing(value)) return MISSING;
  if (typeof value !== 'string') return INVALID;
  const match = DECIMAL.exec(value);
  if (!match) return INVALID;
  const [, , whole, fraction = ''] = match;
  const digits = (whole + fraction).replace(/^0+/, '').replace(/0+$/, '');
  if (digits.length > 15) return PRECISION;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) return PRECISION;
  if (digits.length > 0 && parsed === 0) return PRECISION;
  return { ok: true, value: parsed };
}

export function parseNumeric(kind: NumericKind, value: unknown): ParsedNumber {
  switch (kind) {
    case 'integer': return parseInteger(value);
    case 'float': return parseFloat64(value);
    case 'decimal': return parseDecimal(value);
    default: return assertNever(kind, 'numeric kind');
  }
}

export function numericKindOf(type: QueryChartType): NumericKind | null {
  switch (type.kind) {
    case 'integer': return 'integer';
    case 'float': return 'float';
    case 'decimal': return 'decimal';
    default: return null;
  }
}

export function xKindOf(type: QueryChartType): XKind {
  switch (type.kind) {
    case 'integer':
    case 'float':
    case 'decimal':
      return 'numeric';
    case 'date': return 'date';
    case 'timestamp': return 'timestamp';
    case 'category': return 'category';
    case 'unsupported': return 'unsupported';
    default: return assertNever(type, 'chart type');
  }
}

interface PlacedRow {
  row: ChartRow;
  reason: ExclusionReason | null;
  /** The X was a time finer than a millisecond and was truncated to one. */
  subMillisecond?: boolean;
}

/**
 * The first column as an axis position. A category is a label per row and
 * has no coordinate — the bar chart lists those rows as they came. A
 * number and an instant are both parsed into one, and a row the parser
 * refuses is out of the chart entirely, its Y values with it: a point
 * whose X cannot be placed has nowhere to go, and keeping it as a label
 * would put it at a position the value does not have.
 */
function placeRow(kind: XKind, chartType: QueryChartType, rowIndex: number, raw: unknown): PlacedRow {
  const invalid = (reason: ExclusionReason): PlacedRow =>
    ({ row: { rowIndex, raw, label: formatCellValue(raw) ?? '', value: null, valid: false }, reason });
  if (isMissing(raw)) return invalid('missing');
  if (kind === 'numeric') {
    const numeric = numericKindOf(chartType);
    const parsed = numeric ? parseNumeric(numeric, raw) : INVALID;
    if (!parsed.ok) return invalid(parsed.reason);
    return { row: { rowIndex, raw, label: String(raw), value: parsed.value, valid: true }, reason: null };
  }
  if (kind === 'date' || kind === 'timestamp') {
    const parsed = kind === 'date' ? parseDateValue(raw) : parseTimestampValue(raw);
    if (!parsed.ok) return invalid(parsed.reason);
    return {
      row: { rowIndex, raw, label: formatCellValue(raw) ?? '', value: parsed.value, valid: true },
      reason: null,
      subMillisecond: parsed.subMillisecond,
    };
  }
  if (kind === 'category' && typeof raw !== 'string' && typeof raw !== 'boolean') return invalid('invalid');
  return { row: { rowIndex, raw, label: formatCellValue(raw) ?? '', value: null, valid: true }, reason: null };
}

const unavailable = (code: ChartProblem['code'], params?: ChartProblem['params']): ChartAvailability =>
  ({ available: false, reason: { code, params } });
const AVAILABLE: ChartAvailability = { available: true };

const allUnavailable = (reason: ChartProblem): Record<ChartKind, ChartAvailability> =>
  Object.fromEntries(CHART_KINDS.map(kind => [kind, { available: false, reason }])) as Record<ChartKind, ChartAvailability>;

/** The chart the data asks for, before availability: labels → bars, time → a line, numbers → a scatter. */
function preferredKind(x: XKind): ChartKind | null {
  switch (x) {
    case 'category': return 'bar';
    case 'date':
    case 'timestamp':
      return 'line';
    case 'numeric': return 'scatter';
    case 'unsupported': return null;
    default: return assertNever(x, 'x kind');
  }
}

/**
 * Pick the kind for a result: what its X asks for when that is implemented
 * and available, else the first implemented and available of bar, line,
 * scatter. Pie is never inferred — nothing in a column's type says its
 * values are shares of a whole.
 */
export function inferChartKind(
  x: XKind,
  availability: Record<ChartKind, ChartAvailability>,
  implemented: readonly ChartKind[],
): ChartKind | null {
  const usable = (kind: ChartKind) => implemented.includes(kind) && availability[kind].available;
  const preferred = preferredKind(x);
  if (preferred && usable(preferred)) return preferred;
  return (['bar', 'line', 'scatter'] as const).find(usable) ?? null;
}

function emptyModel(problem: ChartProblem, truncated: boolean): ChartModel {
  return {
    x: null,
    series: [],
    rows: [],
    points: [],
    yExtent: null,
    diagnostics: { candidatePoints: 0, excludedPoints: 0, byReason: { missing: 0, nonFinite: 0, precision: 0, invalid: 0 }, ignoredColumns: [], subMillisecondRows: 0 },
    problem,
    availability: allUnavailable(problem),
    inferred: null,
    truncated,
  };
}

const hasChartType = (result: QueryResult) =>
  result.columns.every(c => typeof c.chart_type === 'object' && c.chart_type !== null && typeof c.chart_type.kind === 'string');

/**
 * Everything a chart needs from a result, computed once per result: the
 * X column, the Y series, every plottable point, the counts of what was
 * left out and why, and which kinds the data allows. Pure — the result's
 * rows are read, never changed.
 */
export function buildChartModel(result: QueryResult, implemented: readonly ChartKind[] = CHART_KINDS): ChartModel {
  const { columns, rows, truncated } = result;
  if (!hasChartType(result)) return emptyModel({ code: 'missingType' }, truncated);
  const cap = Math.min(result.max_rows, MAX_CHART_POINTS);
  if (!Number.isSafeInteger(result.max_rows) || result.max_rows <= 0 || rows.length > cap) {
    return emptyModel({ code: 'invalidResult' }, truncated);
  }
  if (rows.length === 0) return emptyModel({ code: 'empty' }, truncated);
  if (columns.length < 2) return emptyModel({ code: 'needColumns' }, truncated);
  if (new Set(columns.map(c => c.name)).size !== columns.length) return emptyModel({ code: 'duplicateColumns' }, truncated);

  const xColumn = columns[0];
  const xKind = xKindOf(xColumn.chart_type);
  const x = { name: xColumn.name, kind: xKind, chartType: xColumn.chart_type };
  if (xKind === 'unsupported') return emptyModel({ code: 'unsupportedX' }, truncated);

  const series: ChartSeries[] = [];
  const ignoredColumns: string[] = [];
  columns.slice(1).forEach((column, i) => {
    const type = numericKindOf(column.chart_type);
    if (type) series.push({ columnIndex: i + 1, name: column.name, ordinal: series.length, type, validCount: 0 });
    else ignoredColumns.push(column.name);
  });
  if (series.length === 0) {
    const empty = emptyModel({ code: 'needColumns' }, truncated);
    return { ...empty, x, diagnostics: { ...empty.diagnostics, ignoredColumns } };
  }

  const byReason: Record<ExclusionReason, number> = { missing: 0, nonFinite: 0, precision: 0, invalid: 0 };
  const chartRows: ChartRow[] = [];
  const points: ChartPoint[] = [];
  let valid = 0;
  let min = Infinity;
  let max = -Infinity;
  let subMillisecondRows = 0;
  rows.forEach((row, rowIndex) => {
    const placed = placeRow(xKind, xColumn.chart_type, rowIndex, row[xColumn.name]);
    chartRows.push(placed.row);
    if (placed.subMillisecond) subMillisecondRows += 1;
    if (placed.reason) {
      byReason[placed.reason] += series.length;
      return;
    }
    for (const s of series) {
      const raw = row[s.name];
      const parsed = parseNumeric(s.type, raw);
      if (!parsed.ok) {
        byReason[parsed.reason] += 1;
        continue;
      }
      s.validCount += 1;
      valid += 1;
      if (parsed.value < min) min = parsed.value;
      if (parsed.value > max) max = parsed.value;
      // Past the cap the chart is refused anyway; keep counting, stop building.
      if (valid <= cap) points.push({ rowIndex, seriesOrdinal: s.ordinal, y: parsed.value, raw });
    }
  });

  const candidatePoints = rows.length * series.length;
  const diagnostics = { candidatePoints, excludedPoints: candidatePoints - valid, byReason, ignoredColumns, subMillisecondRows };
  const yExtent = valid > 0 ? { min, max } : null;

  let problem: ChartProblem | null = null;
  if (valid === 0) problem = { code: 'noValidPoints' };
  else if (valid > cap) problem = { code: 'pointLimit', params: { max: cap, count: valid } };
  // Two finite doubles whose difference overflows cannot share an axis;
  // the table has them, a rescale in SQL puts them on a chart.
  else if (yExtent && !Number.isFinite(yExtent.max - yExtent.min)) problem = { code: 'unsafeRange' };

  const base: ChartModel = { x, series, rows: chartRows, points: problem ? [] : points, yExtent, diagnostics, problem, availability: allUnavailable(problem ?? { code: 'empty' }), inferred: null, truncated };
  if (problem) return base;

  const continuous = xKind === 'numeric' || xKind === 'date' || xKind === 'timestamp';
  const pie = pieData(base);
  const availability: Record<ChartKind, ChartAvailability> = {
    bar: AVAILABLE,
    line: continuous ? AVAILABLE : unavailable('continuousXRequired'),
    scatter: xKind === 'numeric' ? AVAILABLE : unavailable('numericXRequired'),
    pie: pie.ok ? AVAILABLE : { available: false, reason: pie.reason },
  };
  return { ...base, availability, inferred: inferChartKind(xKind, availability, implemented) };
}
