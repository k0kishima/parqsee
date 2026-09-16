import type { BarGeometry } from '../../lib/chart-geometry';
import { labelStride, PLOT_MARGIN } from '../../lib/chart-geometry';
import type { ChartModel } from '../../lib/chart-types';
import { seriesColor } from '../chart-style';

/** The (row, series) a mark belongs to; what the tooltip and the detail describe. */
export interface MarkRef {
  rowIndex: number;
  seriesOrdinal: number;
}

interface BarChartProps {
  model: ChartModel;
  geometry: BarGeometry;
  height: number;
  selected: MarkRef | null;
  /** The X labels, translated for an empty string. */
  labelOf: (label: string) => string;
}

/** Rows a label is dropped to when the group is narrower than a label. */
const ellipsize = (text: string, pitch: number) => {
  const max = Math.max(3, Math.floor(pitch / 7));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * The scrolling half of a bar chart: the bars and the X labels. The Y axis
 * is drawn beside it by `QueryChart`, so this SVG is exactly as wide as
 * the bars need. Every bar carries its row and column as data attributes
 * and the hover handler on the parent reads them — no handler per bar.
 */
export function BarChart({ model, geometry, height, selected, labelOf }: BarChartProps) {
  const pitch = geometry.groups.length > 1 ? geometry.groups[1].x - geometry.groups[0].x : geometry.contentWidth;
  const stride = labelStride(pitch);
  const columnIndexOf = (ordinal: number) => model.series[ordinal].columnIndex;
  return (
    <svg
      data-chart-kind="bar"
      width={geometry.contentWidth}
      height={height}
      viewBox={`0 0 ${geometry.contentWidth} ${height}`}
      className="block shrink-0 select-none"
      aria-hidden="true"
      focusable="false"
    >
      <g aria-hidden="true">
        {geometry.yTicks.map(tick => (
          <line key={tick.value} x1={0} x2={geometry.contentWidth} y1={tick.position} y2={tick.position} stroke="var(--chart-grid)" strokeWidth={1} />
        ))}
        <line x1={0} x2={geometry.contentWidth} y1={geometry.baseline} y2={geometry.baseline} stroke="var(--chart-axis)" strokeWidth={1} />
      </g>
      <g>
        {geometry.marks.map(mark => {
          const isSelected = selected !== null && selected.rowIndex === mark.rowIndex && selected.seriesOrdinal === mark.seriesOrdinal;
          // A zero has no length; a hairline on the baseline says the value is there, unlike a NULL's empty slot.
          const zero = mark.height < 1;
          return (
            <rect
              key={`${mark.rowIndex}-${mark.seriesOrdinal}`}
              data-mark=""
              data-row-index={mark.rowIndex}
              data-column-index={columnIndexOf(mark.seriesOrdinal)}
              data-series-index={mark.seriesOrdinal}
              data-selected={isSelected ? '' : undefined}
              x={mark.x}
              y={zero ? geometry.baseline - 1 : mark.y}
              width={mark.width}
              height={zero ? 2 : mark.height}
              fill={seriesColor(mark.seriesOrdinal)}
              stroke={isSelected ? 'var(--chart-focus)' : 'none'}
              strokeWidth={isSelected ? 2 : 0}
            />
          );
        })}
      </g>
      <g aria-hidden="true" fill="var(--text-tertiary)" fontSize={11} textAnchor="middle">
        {geometry.groups.map((group, i) => (
          i % stride === 0 ? (
            <text key={group.rowIndex} x={group.x + group.width / 2} y={height - PLOT_MARGIN.bottom + 18}>
              <title>{labelOf(group.label)}</title>
              {ellipsize(labelOf(group.label), pitch * stride)}
            </text>
          ) : null
        ))}
      </g>
    </svg>
  );
}
