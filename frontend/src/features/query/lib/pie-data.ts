import type { ChartModel, ChartProblem } from './chart-types';

/**
 * The most slices a pie draws, the aggregated Other among them. Past
 * eight wedges the small ones are thinner than their own outline and the
 * legend stops being readable at a glance, so the tail is summed instead
 * of thinned away — the rows are all still in the table, and the Other
 * slice names them in the details.
 */
export const MAX_PIE_SLICES = 8;

/**
 * The most rows a pie is drawn from. A pie answers "how is this whole
 * split", which stops being a question anyone can read off a circle long
 * before fifty categories; a bar chart is the chart for a long list.
 */
export const MAX_PIE_ROWS = 50;

/** One row's share of the whole, or (in `PieSlice.members`) one row inside the Other slice. */
export interface PieEntry {
  /** The result row this value came from. */
  rowIndex: number;
  /** The X label as it came — never translated here, so an empty string stays ''. */
  label: string;
  value: number;
  /** The Y cell as it arrived, so the exact string of a decimal survives into the details. */
  raw: unknown;
  /** `value / total`, between 0 and 1. */
  share: number;
}

export interface PieSlice extends Omit<PieEntry, 'rowIndex' | 'raw'> {
  /**
   * What this slice is, and what the renderer keys it by. A row slice is
   * its row's index; the aggregate is `other`, which is not a row index,
   * so a result whose own X reads "Other" is still a slice of its own.
   */
  id: string;
  /** Null on the aggregate, which stands for several rows. */
  rowIndex: number | null;
  /** Null on the aggregate, whose value is a sum and not a cell. */
  raw: unknown;
  /** The rows the aggregate sums, in the same order as the slices; empty on a row slice. */
  members: PieEntry[];
}

export interface PieData {
  /** The single Y column the shares are of. */
  seriesName: string;
  /** Biggest first, ties in row order, the Other aggregate always last. */
  slices: PieSlice[];
  total: number;
  /** Rows whose value is exactly zero: a slice of no area, counted in a note instead. */
  zeroRows: number;
  /**
   * The total and the shares are approximations: a float or decimal
   * series is summed in doubles, and the percentages inherit that.
   */
  approximate: boolean;
}

export type PieResult = { ok: true; data: PieData } | { ok: false; reason: ChartProblem };

const refuse = (code: ChartProblem['code'], params?: ChartProblem['params']): PieResult =>
  ({ ok: false, reason: { code, params } });

/**
 * What makes two X values the same row of the pie: the value as it
 * arrived, not the label it is drawn with. `''` and NULL both render as
 * nothing, and a pie that merged them would claim a share for a category
 * that does not exist. Null means the row has no X at all.
 */
function rawKey(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  return `${typeof raw}:${String(raw)}`;
}

/**
 * Neumaier summation: the running compensation is added at the end, so a
 * long tail of small shares is not lost into a large total and the
 * percentages add up to what the slices show. Plain `+` over fifty
 * doubles can drift by more than the smallest slice is wide.
 */
export function compensatedSum(values: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const next = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
    sum = next;
  }
  return sum + compensation;
}

/**
 * The slices of a pie, or the one condition the result fails. A pie
 * states that the values are parts of a whole, which the other charts
 * never claim, so every way of being not-quite-a-whole refuses the kind
 * rather than drawing an approximation: a second Y column (two wholes),
 * a repeated or absent category (a share of what?), an invalid or
 * negative value (no area), a truncated result (a share of the rows that
 * came back, read as a share of the data).
 *
 * Nothing here excludes a single value the way the other kinds do. A pie
 * excluded down to its valid rows would still be drawn full, with every
 * percentage silently computed against a different denominator.
 */
export function pieData(model: ChartModel): PieResult {
  if (!model.x || model.x.kind !== 'category') return refuse('pieCategory');
  if (model.series.length !== 1) return refuse('pieOneSeries');
  const { rows } = model;
  if (rows.length === 0 || rows.length > MAX_PIE_ROWS) return refuse('pieRows', { max: MAX_PIE_ROWS });

  const seen = new Set<string>();
  for (const row of rows) {
    const key = rawKey(row.raw);
    if (key === null || seen.has(key)) return refuse('pieUnique');
    seen.add(key);
  }

  const series = model.series[0];
  const byRow = new Map(model.points.filter(p => p.seriesOrdinal === series.ordinal).map(p => [p.rowIndex, p]));
  const entries: Omit<PieEntry, 'share'>[] = [];
  let zeroRows = 0;
  for (const row of rows) {
    const point = byRow.get(row.rowIndex);
    // `< 0` leaves -0 among the zeros, where its area puts it anyway.
    if (!point || point.y < 0) return refuse('pieValues');
    if (point.y === 0) zeroRows += 1;
    entries.push({ rowIndex: row.rowIndex, label: row.label, value: point.y, raw: point.raw });
  }
  if (zeroRows === entries.length) return refuse('pieValues');
  if (model.truncated) return refuse('piePartial');

  const total = compensatedSum(entries.map(e => e.value));
  // A total a double cannot hold makes every percentage a guess; an
  // integer total past the safe range is off by whole units. The table
  // has the numbers, and SQL can rescale them.
  if (!Number.isFinite(total) || total <= 0) return refuse('unsafeRange');
  if (series.type === 'integer' && !Number.isSafeInteger(total)) return refuse('unsafeRange');

  const share = (value: number) => value / total;
  const positive = entries
    .filter(e => e.value > 0)
    .sort((a, b) => b.value - a.value || a.rowIndex - b.rowIndex);
  const slice = (entry: Omit<PieEntry, 'share'>): PieSlice =>
    ({ id: String(entry.rowIndex), rowIndex: entry.rowIndex, label: entry.label, value: entry.value, raw: entry.raw, share: share(entry.value), members: [] });

  if (positive.length <= MAX_PIE_SLICES) {
    return { ok: true, data: { seriesName: series.name, slices: positive.map(slice), total, zeroRows, approximate: series.type !== 'integer' } };
  }
  const head = positive.slice(0, MAX_PIE_SLICES - 1);
  const tail = positive.slice(MAX_PIE_SLICES - 1);
  const otherValue = compensatedSum(tail.map(e => e.value));
  const other: PieSlice = {
    id: 'other',
    rowIndex: null,
    label: '',
    value: otherValue,
    raw: null,
    share: share(otherValue),
    members: tail.map(e => ({ ...e, share: share(e.value) })),
  };
  return { ok: true, data: { seriesName: series.name, slices: [...head.map(slice), other], total, zeroRows, approximate: series.type !== 'integer' } };
}
