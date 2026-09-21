import type { QueryChartType } from '../types';

/**
 * Every chart the SQL view can draw. A kind is *implemented* when it has a
 * renderer; the model still decides availability for all of them so the
 * inference falls back the same way whichever stage the code is at.
 */
export type ChartKind = 'bar' | 'line' | 'scatter' | 'pie';
export const CHART_KINDS: readonly ChartKind[] = ['bar', 'line', 'scatter', 'pie'];

/** The Y columns a chart can use. */
export type NumericKind = 'integer' | 'float' | 'decimal';

/**
 * What the first result column is to a chart: a label per row, a number,
 * or a point in time. Unsupported means the query has to CAST it.
 */
export type XKind = 'category' | 'numeric' | 'date' | 'timestamp' | 'unsupported';

export interface ChartXColumn {
  name: string;
  kind: XKind;
  chartType: QueryChartType;
}

/** One Y column. `ordinal` numbers the series from 0 in column order; it picks the color. */
export interface ChartSeries {
  columnIndex: number;
  name: string;
  ordinal: number;
  type: NumericKind;
  /** How many rows gave this series a plottable value. */
  validCount: number;
}

/**
 * One result row on the X axis. `label` is what the axis shows (never
 * translated here — an empty string stays '' for the UI to name), `value`
 * the numeric coordinate when X is numeric, and `valid` false when the row
 * cannot be placed at all, which excludes every Y of the row.
 */
export interface ChartRow {
  rowIndex: number;
  raw: unknown;
  label: string;
  value: number | null;
  valid: boolean;
}

/** One plottable (row, series) pair. The coordinate is the parsed number; the raw value stays in the row. */
export interface ChartPoint {
  rowIndex: number;
  seriesOrdinal: number;
  y: number;
  raw: unknown;
}

/** Why a candidate point was not plotted, in the order the reasons are decided. */
export type ExclusionReason = 'missing' | 'nonFinite' | 'precision' | 'invalid';
export const EXCLUSION_REASONS: readonly ExclusionReason[] = ['missing', 'nonFinite', 'precision', 'invalid'];

export interface ChartDiagnostics {
  /** rows × series. */
  candidatePoints: number;
  excludedPoints: number;
  byReason: Record<ExclusionReason, number>;
  /** Result columns after the first that are not numeric and so not Y. */
  ignoredColumns: string[];
  /**
   * Rows whose X carried digits finer than a millisecond. They are plotted
   * at the millisecond they were truncated to, which the chart says rather
   * than letting a microsecond series look evenly spaced when it is not.
   */
  subMillisecondRows: number;
}

/**
 * Why the result cannot be charted at all, or why one kind cannot. The
 * codes are translation keys under `viewer.query.chart`; the UI adds the
 * words. `params` carries what the message interpolates.
 */
export type ChartProblemCode =
  | 'empty'
  | 'needColumns'
  | 'unsupportedX'
  | 'missingType'
  | 'invalidResult'
  | 'duplicateColumns'
  | 'noValidPoints'
  | 'pointLimit'
  | 'unsafeRange'
  | 'numericXRequired'
  | 'continuousXRequired'
  | 'pieCategory'
  | 'pieOneSeries'
  | 'pieRows'
  | 'pieUnique'
  | 'pieValues'
  | 'piePartial';

export interface ChartProblem {
  code: ChartProblemCode;
  params?: Record<string, string | number>;
}

export type ChartAvailability = { available: true } | { available: false; reason: ChartProblem };

export interface ChartModel {
  x: ChartXColumn | null;
  series: ChartSeries[];
  rows: ChartRow[];
  points: ChartPoint[];
  /** Min and max over every plotted Y, or null without a point. */
  yExtent: { min: number; max: number } | null;
  diagnostics: ChartDiagnostics;
  /** Something that stops every kind; the per-kind entries repeat it. */
  problem: ChartProblem | null;
  availability: Record<ChartKind, ChartAvailability>;
  /** The kind picked from the data, among the implemented and available ones. */
  inferred: ChartKind | null;
  /** True when the result was cut at its row limit: the chart is of the first rows only. */
  truncated: boolean;
}
