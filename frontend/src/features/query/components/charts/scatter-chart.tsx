import type { ScatterGeometry } from '../../lib/chart-geometry';
import type { PlottedPoint } from '../../lib/chart-geometry';
import { assertNever } from '../../../../lib/exhaustive';
import { seriesColor, seriesSymbol, type SeriesSymbol } from '../chart-style';
import { CartesianAxisLabels, CartesianGrid, type MarkRef } from './chart-chrome';

interface ScatterChartProps {
  geometry: ScatterGeometry;
  height: number;
  selected: MarkRef | null;
}

/** Half the side of a mark's box: a symbol about 6px across, big enough to aim at and small enough to crowd. */
const HALF = 3;

/**
 * The plot of a scatter chart: one mark per plotted pair over two
 * numeric axes.
 *
 * The marks are translucent so that a crowd reads as a crowd — where
 * many land together the colour deepens, which is the only density the
 * chart shows; it never bins or thins them. Their outline is the opaque
 * series colour, so a single point out on its own is still solid.
 * Every mark carries its row and column as data attributes and the
 * hover handler on the parent reads them, as the bars' does: ten
 * thousand listeners would cost more than the plot.
 */
export function ScatterChart({ geometry, height, selected }: ScatterChartProps) {
  return (
    <svg
      data-chart-kind="scatter"
      width={geometry.contentWidth}
      height={height}
      viewBox={`0 0 ${geometry.contentWidth} ${height}`}
      className="block shrink-0 select-none"
      aria-hidden="true"
      focusable="false"
    >
      <CartesianGrid axes={geometry} />
      <g fillOpacity={0.65} strokeWidth={1}>
        {geometry.marks.map(mark => symbolOf(
          mark,
          seriesSymbol(mark.seriesOrdinal),
          selected !== null && selected.rowIndex === mark.rowIndex && selected.seriesOrdinal === mark.seriesOrdinal,
        ))}
      </g>
      <CartesianAxisLabels axes={geometry} />
    </svg>
  );
}

/**
 * One mark. This is a function rather than a component: a result may
 * hold ten thousand of them, and a component each would put ten thousand
 * more nodes through reconciliation for nothing.
 */
function symbolOf(mark: PlottedPoint, symbol: SeriesSymbol, selected: boolean) {
  const key = `${mark.seriesOrdinal}-${mark.rowIndex}`;
  const shared = {
    'data-mark': '',
    'data-row-index': mark.rowIndex,
    'data-series-index': mark.seriesOrdinal,
    'data-selected': selected ? '' : undefined,
    fill: seriesColor(mark.seriesOrdinal),
    // The outline is opaque, so one mark alone is as legible as a crowd.
    stroke: selected ? 'var(--chart-focus)' : seriesColor(mark.seriesOrdinal),
    strokeWidth: selected ? 2 : 1,
  };
  const { x, y } = mark;
  switch (symbol) {
    case 'circle':
      return <circle key={key} {...shared} cx={x} cy={y} r={HALF} />;
    case 'square':
      return <rect key={key} {...shared} x={x - HALF} y={y - HALF} width={HALF * 2} height={HALF * 2} />;
    case 'triangle':
      return <polygon key={key} {...shared} points={`${x},${y - HALF} ${x + HALF},${y + HALF} ${x - HALF},${y + HALF}`} />;
    case 'diamond':
      return <polygon key={key} {...shared} points={`${x},${y - HALF} ${x + HALF},${y} ${x},${y + HALF} ${x - HALF},${y}`} />;
    default:
      return assertNever(symbol, 'series symbol');
  }
}
