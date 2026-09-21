import { useTranslation } from 'react-i18next';
import { LINE_MARK_RADIUS, PLOT_MARGIN, type LineGeometry, type PlottedPoint } from '../../lib/chart-geometry';
import type { ChartModel } from '../../lib/chart-types';
import { seriesColor, seriesDash } from '../chart-style';
import type { MarkRef } from './chart-chrome';

interface LineChartProps {
  model: ChartModel;
  geometry: LineGeometry;
  height: number;
  selected: MarkRef | null;
}

/**
 * The plot of a line chart: a path per series over a continuous X, the
 * two axes, and a caption for what the labels leave unsaid.
 *
 * Nothing is drawn per point. A result may hold ten thousand of them, and
 * a circle each would be a DOM the size of the grid the chart was meant
 * to summarize; the path carries the shape, and the only marks are the
 * points a path cannot show — one with no neighbour to join — and the one
 * the reader has selected. The pointer is answered by measuring to the
 * nearest vertex rather than by hit-testing marks that are not there.
 */
export function LineChart({ model, geometry, height, selected }: LineChartProps) {
  const { t } = useTranslation();
  const axisY = PLOT_MARGIN.top + geometry.plotHeight;
  const zeroY = geometry.yScale.domain.min < 0 && geometry.yScale.domain.max > 0 ? geometry.yScale(0) : null;
  const selectedVertex = selected
    ? geometry.series[selected.seriesOrdinal]?.vertices.find(vertex => vertex.rowIndex === selected.rowIndex) ?? null
    : null;

  // A timestamp with a zone is drawn on a UTC axis; one without has no
  // zone to convert from, and its wall clock is shown as it was written.
  const xType = model.x?.chartType;
  const zone = xType?.kind === 'timestamp' ? t(xType.timezone ? 'viewer.query.chart.utc' : 'viewer.query.chart.naiveTime') : null;
  const dates = geometry.xDates ? t('viewer.query.chart.dateRange', { range: geometry.xDates.join(' – ') }) : null;

  return (
    <svg
      data-chart-kind="line"
      width={geometry.contentWidth}
      height={height}
      viewBox={`0 0 ${geometry.contentWidth} ${height}`}
      className="block shrink-0 select-none"
      aria-hidden="true"
      focusable="false"
    >
      <g aria-hidden="true">
        {geometry.yTicks.map(tick => (
          <line key={`y${tick.value}`} x1={0} x2={geometry.contentWidth} y1={tick.position} y2={tick.position} stroke="var(--chart-grid)" strokeWidth={1} />
        ))}
        {geometry.xTicks.map(tick => (
          <line key={`x${tick.value}`} x1={tick.position} x2={tick.position} y1={PLOT_MARGIN.top} y2={axisY} stroke="var(--chart-grid)" strokeWidth={1} />
        ))}
        {zeroY !== null && (
          <line x1={0} x2={geometry.contentWidth} y1={zeroY} y2={zeroY} stroke="var(--chart-axis)" strokeWidth={1} />
        )}
        <line x1={0} x2={geometry.contentWidth} y1={axisY} y2={axisY} stroke="var(--chart-axis)" strokeWidth={1} />
      </g>
      <g fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round">
        {geometry.series.map(series => (
          series.path === '' ? null : (
            <path
              key={series.ordinal}
              data-series-index={series.ordinal}
              d={series.path}
              stroke={seriesColor(series.ordinal)}
              strokeDasharray={seriesDash(series.ordinal)}
            />
          )
        ))}
      </g>
      <g>
        {geometry.series.flatMap(series => series.isolated.map(vertex => (
          <Mark key={`${vertex.rowIndex}-${vertex.seriesOrdinal}`} vertex={vertex} isolated />
        )))}
        {selectedVertex && <Mark vertex={selectedVertex} selected />}
      </g>
      <g aria-hidden="true" fill="var(--text-tertiary)" fontSize={11}>
        {geometry.xTicks.map(tick => (
          <g key={tick.value}>
            <line x1={tick.position} x2={tick.position} y1={axisY} y2={axisY + 5} stroke="var(--chart-axis)" strokeWidth={1} />
            <text x={tick.position} y={axisY + 18} textAnchor="middle">{tick.label}</text>
          </g>
        ))}
        {dates && <text x={0} y={axisY + 34}>{dates}</text>}
        {zone && <text x={geometry.contentWidth} y={axisY + 34} textAnchor="end">{zone}</text>}
      </g>
    </svg>
  );
}

/**
 * A point drawn in its own right: one the line left alone, or the
 * selected one. The selected mark is outlined rather than enlarged, so
 * that where it sits does not move as the reader walks the series.
 */
function Mark({ vertex, isolated, selected }: { vertex: PlottedPoint; isolated?: boolean; selected?: boolean }) {
  return (
    <circle
      data-row-index={vertex.rowIndex}
      data-series-index={vertex.seriesOrdinal}
      data-isolated={isolated ? '' : undefined}
      data-selected={selected ? '' : undefined}
      cx={vertex.x}
      cy={vertex.y}
      r={LINE_MARK_RADIUS}
      fill={seriesColor(vertex.seriesOrdinal)}
      stroke={selected ? 'var(--chart-focus)' : 'none'}
      strokeWidth={selected ? 2 : 0}
    />
  );
}
