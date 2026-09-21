import type { ChartModel } from './chart-types';
import {
  barDomain,
  linearScale,
  linearTicks,
  paddedDomain,
  tickLabels,
  timeAxis,
  timeAxisDates,
  timeDomain,
  type LinearScale,
} from './chart-scales';

/**
 * Pixels above and below the plot for the top tick's label and the X
 * labels. Horizontal coordinates are the plot's own: the Y axis is drawn
 * in a separate SVG beside the scrolling plot, so nothing here is offset
 * for it.
 */
export const PLOT_MARGIN = { top: 24, bottom: 64 } as const;
/** The width of the Y axis SVG beside the plot. */
export const Y_AXIS_WIDTH = 80;

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

/** Coordinates are written to the path with enough precision for a pixel, and no more. */
const round = (value: number) => Number(value.toFixed(3));

const MIN_BAR_WIDTH = 6;
/** Two rows would otherwise paint bars a screen wide; a bar is a length, not an area. */
const MAX_BAR_WIDTH = 48;
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
  // Spread the groups over the viewport when they fit, else give each its minimum.
  const pitch = Math.max(groupWidth, model.rows.length > 0 ? Math.max(0, viewport.width) / model.rows.length : groupWidth);
  const contentWidth = pitch * model.rows.length;
  const barWidth = Math.min(MAX_BAR_WIDTH, Math.max(MIN_BAR_WIDTH, (pitch - GROUP_PADDING - BAR_GAP * (seriesCount - 1)) / seriesCount));
  // Bars sit centred in their group, which matters once the width is capped.
  const barsWidth = seriesCount * barWidth + BAR_GAP * (seriesCount - 1);

  const domain = barDomain(model.yExtent);
  const yScale = linearScale(domain, [PLOT_MARGIN.top + plotHeight, PLOT_MARGIN.top]);
  const baseline = yScale(0);
  const { ticks, labels } = tickLabels(linearTicks(domain, Math.max(2, Math.min(8, Math.floor(plotHeight / 50)))), locale);
  const yTicks = ticks.map((value, i) => ({ value, position: yScale(value), label: labels[i] }));

  const groups: BarGroup[] = model.rows.map((row, i) => ({
    rowIndex: row.rowIndex,
    label: row.label,
    x: i * pitch,
    width: pitch,
  }));
  const groupStart = (rowIndex: number) => rowIndex * pitch + (pitch - barsWidth) / 2;
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

/** The gap between the pie's edge and its box, so a hovered outline is not clipped. */
const PIE_PADDING = 12;
/** Below this the circle is a dot; the pane stacks the legend under it instead of shrinking further. */
const MIN_PIE_SIZE = 96;

export interface PieArc {
  /** The slice's own id, as `pieData` gave it. */
  id: string;
  /** Radians from 12 o'clock, clockwise. */
  startAngle: number;
  endAngle: number;
  /** The wedge, or null when this slice is the whole circle and is drawn as one. */
  path: string | null;
}

export interface PieGeometry {
  /** The side of the square the circle is drawn in. */
  size: number;
  cx: number;
  cy: number;
  radius: number;
  arcs: PieArc[];
  /** One slice holds everything: a circle, not an arc from a point back to itself. */
  whole: boolean;
}

/** A point on the circle, measuring from 12 o'clock clockwise like a clock face. */
const onCircle = (cx: number, cy: number, r: number, angle: number): [number, number] =>
  [round(cx + r * Math.sin(angle)), round(cy - r * Math.cos(angle))];

/** The wedge from the centre out to `start`, round to `end`, and back. */
export function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const [x0, y0] = onCircle(cx, cy, r, start);
  const [x1, y1] = onCircle(cx, cy, r, end);
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${round(cx)} ${round(cy)} L ${x0} ${y0} A ${round(r)} ${round(r)} 0 ${large} 1 ${x1} ${y1} Z`;
}

/**
 * The wedges of a pie, in the order the slices came. Angles run from 12
 * o'clock clockwise and are taken from the running total rather than from
 * each share in turn, so the last wedge ends exactly where the first
 * began however the shares round.
 */
export function pieGeometry(slices: readonly { id: string; value: number }[], viewport: { width: number; height: number }): PieGeometry | null {
  if (slices.length === 0) return null;
  const size = Math.max(MIN_PIE_SIZE, Math.min(viewport.width, viewport.height));
  const radius = Math.max(1, size / 2 - PIE_PADDING);
  const cx = size / 2;
  const cy = size / 2;
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const whole = slices.length === 1;
  const arcs: PieArc[] = [];
  let before = 0;
  for (const slice of slices) {
    const startAngle = total > 0 ? (before / total) * Math.PI * 2 : 0;
    before += slice.value;
    const endAngle = total > 0 ? (before / total) * Math.PI * 2 : 0;
    arcs.push({ id: slice.id, startAngle, endAngle, path: whole ? null : arcPath(cx, cy, radius, startAngle, endAngle) });
  }
  return { size, cx, cy, radius, arcs, whole };
}

/**
 * The inset at each end of a line's plot: a mark on the first or last
 * point is a circle, and half of it would be outside an axis that ran to
 * the very edge.
 */
const LINE_INSET = 10;
/** The radius of a drawn point: an isolated one, or the selected one. */
export const LINE_MARK_RADIUS = 3.5;

export interface LineVertex {
  rowIndex: number;
  seriesOrdinal: number;
  value: number;
  raw: unknown;
  x: number;
  y: number;
}

export interface LineSeriesGeometry {
  ordinal: number;
  /** The runs of consecutive rows, as one path; empty when nothing connects. */
  path: string;
  /** Points with no neighbouring row to join, which a line cannot show on its own. */
  isolated: LineVertex[];
  /** Every vertex of the series, in row order. */
  vertices: LineVertex[];
}

export interface LineGeometry {
  contentWidth: number;
  plotHeight: number;
  series: LineSeriesGeometry[];
  xScale: LinearScale;
  yScale: LinearScale;
  xTicks: AxisTick[];
  yTicks: AxisTick[];
  /** The days the clock-time labels below belong to, or null when they carry their own. */
  xDates: string[] | null;
}

/**
 * A line per series: the runs of consecutive rows as paths, the points
 * left alone by a gap as marks, and the two axes.
 *
 * Rows are joined in the order the query returned them and never sorted
 * here — the table and the chart have to agree, and `ORDER BY` is where
 * the order is decided. A row that is missing a value, or whose X could
 * not be placed, ends the run: a line drawn straight over the gap would
 * be a value the query never returned, and the eye reads it as data.
 * A run of one has nothing to connect to, so it is drawn as a mark
 * instead of vanishing.
 */
export function lineGeometry(
  model: ChartModel,
  viewport: { width: number; height: number },
  locale: string,
): LineGeometry | null {
  if (!model.yExtent || !model.xExtent || model.series.length === 0) return null;
  const kind = model.x?.kind;
  const overTime = kind === 'date' || kind === 'timestamp';
  const plotHeight = Math.max(0, viewport.height - PLOT_MARGIN.top - PLOT_MARGIN.bottom);
  const contentWidth = Math.max(0, viewport.width);
  const plotWidth = Math.max(1, contentWidth - LINE_INSET * 2);

  const floor = kind === 'date' ? 'day' : 'millisecond';
  const xDomain = overTime
    ? timeDomain(model.xExtent, floor)
    : (model.xExtent.max > model.xExtent.min ? model.xExtent : paddedDomain(model.xExtent));
  const xScale = linearScale(xDomain, [LINE_INSET, LINE_INSET + plotWidth]);
  const yDomain = paddedDomain(model.yExtent);
  const yScale = linearScale(yDomain, [PLOT_MARGIN.top + plotHeight, PLOT_MARGIN.top]);

  const yLabels = tickLabels(linearTicks(yDomain, Math.max(2, Math.min(8, Math.floor(plotHeight / 50)))), locale);
  const yTicks = yLabels.ticks.map((value, i) => ({ value, position: yScale(value), label: yLabels.labels[i] }));

  // A label needs about 120px of its own; the step is the finest that fits.
  const xCount = Math.max(2, Math.floor(plotWidth / 120));
  let xTicks: AxisTick[];
  let xDates: string[] | null = null;
  if (overTime) {
    const axis = timeAxis(xDomain, xCount, floor);
    xTicks = axis.ticks.map((value, i) => ({ value, position: xScale(value), label: axis.labels[i] }));
    xDates = timeAxisDates(xDomain, axis.step.unit);
  } else {
    const labels = tickLabels(linearTicks(xDomain, xCount), locale);
    xTicks = labels.ticks.map((value, i) => ({ value, position: xScale(value), label: labels.labels[i] }));
  }

  const xOf = new Map(model.rows.filter(row => row.value !== null).map(row => [row.rowIndex, row.value as number]));
  const series = model.series.map(s => {
    const vertices: LineVertex[] = [];
    for (const point of model.points) {
      if (point.seriesOrdinal !== s.ordinal) continue;
      const x = xOf.get(point.rowIndex);
      if (x === undefined) continue;
      vertices.push({
        rowIndex: point.rowIndex,
        seriesOrdinal: s.ordinal,
        value: point.y,
        raw: point.raw,
        x: xScale(x),
        y: yScale(point.y),
      });
    }
    const runs = consecutiveRuns(vertices);
    return {
      ordinal: s.ordinal,
      path: runs.filter(run => run.length > 1).map(polyline).join(' '),
      isolated: runs.filter(run => run.length === 1).map(run => run[0]),
      vertices,
    };
  });

  return { contentWidth, plotHeight, series, xScale, yScale, xTicks, yTicks, xDates };
}

/** The vertices split into runs of rows that follow one another with nothing left out between them. */
function consecutiveRuns(vertices: readonly LineVertex[]): LineVertex[][] {
  const runs: LineVertex[][] = [];
  for (const vertex of vertices) {
    const current = runs[runs.length - 1];
    if (current && vertex.rowIndex === current[current.length - 1].rowIndex + 1) current.push(vertex);
    else runs.push([vertex]);
  }
  return runs;
}

const polyline = (run: readonly LineVertex[]): string =>
  run.map((vertex, i) => `${i === 0 ? 'M' : 'L'} ${round(vertex.x)} ${round(vertex.y)}`).join(' ');

/**
 * The vertex nearest a point of the plot, or null when there is none
 * within `radius`. A line has no element per point — ten thousand circles
 * would cost more than the chart — so the pointer is answered by
 * measuring instead of by hit-testing the DOM.
 */
export function nearestVertex(
  geometry: LineGeometry,
  at: { x: number; y: number },
  radius = 40,
): LineVertex | null {
  let best: LineVertex | null = null;
  let bestDistance = radius * radius;
  for (const series of geometry.series) {
    for (const vertex of series.vertices) {
      const dx = vertex.x - at.x;
      const dy = vertex.y - at.y;
      const distance = dx * dx + dy * dy;
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = vertex;
      }
    }
  }
  return best;
}
