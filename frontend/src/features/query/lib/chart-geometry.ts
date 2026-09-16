import type { ChartModel } from './chart-types';
import { barDomain, linearScale, linearTicks, tickLabels, type LinearScale } from './chart-scales';

/** Pixels around the plot for the axes and their labels. */
export const PLOT_MARGIN = { top: 24, right: 24, bottom: 64, left: 80 } as const;

export interface BarMark {
  rowIndex: number;
  seriesOrdinal: number;
  value: number;
  raw: unknown;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BarGroup {
  rowIndex: number;
  label: string;
  /** Left edge and width of the whole group, for the hit area and the label. */
  x: number;
  width: number;
}

export interface AxisTick {
  value: number;
  position: number;
  label: string;
}

export interface BarGeometry {
  /** The width the bars need; wider than the viewport when there are many groups. */
  contentWidth: number;
  plotHeight: number;
  groups: BarGroup[];
  marks: BarMark[];
  yScale: LinearScale;
  yTicks: AxisTick[];
  /** The y of zero, where every bar starts. */
  baseline: number;
}

const MIN_BAR_WIDTH = 6;
const BAR_GAP = 2;
const GROUP_PADDING = 8;
const MIN_GROUP_WIDTH = 28;

/**
 * Grouped vertical bars: one group per result row, one bar per series
 * inside it, in column order. Groups are not stacked — the columns are
 * different measures, and stacking would add them — and rows are not
 * merged when their X repeats, since the query returned them apart. The
 * bars keep a readable width whatever the row count, so the content grows
 * past the viewport and scrolls rather than thinning to hairlines.
 */
export function barGeometry(model: ChartModel, viewport: { width: number; height: number }, locale: string): BarGeometry | null {
  if (!model.yExtent || model.series.length === 0) return null;
  const seriesCount = model.series.length;
  const plotHeight = Math.max(0, viewport.height - PLOT_MARGIN.top - PLOT_MARGIN.bottom);
  const groupWidth = Math.max(MIN_GROUP_WIDTH, seriesCount * (MIN_BAR_WIDTH + BAR_GAP) + GROUP_PADDING);
  const viewportPlot = Math.max(0, viewport.width - PLOT_MARGIN.left - PLOT_MARGIN.right);
  // Spread the groups over the viewport when they fit, else give each its minimum.
  const pitch = Math.max(groupWidth, model.rows.length > 0 ? viewportPlot / model.rows.length : groupWidth);
  const contentWidth = pitch * model.rows.length;
  const barWidth = Math.max(MIN_BAR_WIDTH, (pitch - GROUP_PADDING - BAR_GAP * (seriesCount - 1)) / seriesCount);

  const domain = barDomain(model.yExtent);
  const yScale = linearScale(domain, [PLOT_MARGIN.top + plotHeight, PLOT_MARGIN.top]);
  const baseline = yScale(0);
  const { ticks, labels } = tickLabels(linearTicks(domain, Math.max(2, Math.min(8, Math.floor(plotHeight / 50)))), locale);
  const yTicks = ticks.map((value, i) => ({ value, position: yScale(value), label: labels[i] }));

  const groups: BarGroup[] = model.rows.map((row, i) => ({
    rowIndex: row.rowIndex,
    label: row.label,
    x: PLOT_MARGIN.left + i * pitch,
    width: pitch,
  }));
  const groupStart = (rowIndex: number) => PLOT_MARGIN.left + rowIndex * pitch + GROUP_PADDING / 2;
  const marks: BarMark[] = model.points.map(point => {
    const top = yScale(point.y);
    return {
      rowIndex: point.rowIndex,
      seriesOrdinal: point.seriesOrdinal,
      value: point.y,
      raw: point.raw,
      x: groupStart(point.rowIndex) + point.seriesOrdinal * (barWidth + BAR_GAP),
      y: Math.min(top, baseline),
      width: barWidth,
      height: Math.abs(baseline - top),
    };
  });
  return { contentWidth, plotHeight, groups, marks, yScale, yTicks, baseline };
}

/**
 * Which group labels to draw when groups are narrower than a label: every
 * n-th, with n chosen so labels sit at least `minSpacing` px apart.
 */
export function labelStride(pitch: number, minSpacing = 80): number {
  return Math.max(1, Math.ceil(minSpacing / pitch));
}
