import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCellValue } from '../../../../lib/format';
import { pieGeometry } from '../../lib/chart-geometry';
import type { PieData, PieEntry, PieSlice } from '../../lib/pie-data';
import { seriesColor } from '../chart-style';
import { ChartDetailBox, ChartTooltip, useElementSize, useLabelOf, usePointerMark } from './chart-chrome';

interface PieChartProps {
  data: PieData;
  /** The first column's name, for the chart's spoken summary. */
  xName: string;
}

/**
 * The aggregate's colour. Grey, outside the categorical ramp: Other is
 * not a ninth category but the rest of them, and a ninth hue would read
 * as one more.
 */
const sliceColor = (slice: PieSlice, index: number) =>
  slice.rowIndex === null ? 'var(--chart-other)' : seriesColor(index);

/**
 * A pie of one numeric column's shares. Slices run clockwise from 12
 * o'clock, biggest first, with the aggregated Other last; nothing is
 * labelled inside the circle, because the labels that fit there are the
 * ones nobody needs. The legend carries the category, the value and the
 * percentage, and it wraps under the circle when the pane is narrow.
 */
export function PieChart({ data, xName }: PieChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const labelOf = useLabelOf();
  const plotRef = useRef<HTMLDivElement>(null);
  const circleRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(circleRef);
  const descriptionId = useId();

  const geometry = useMemo(
    () => (size.width > 0 && size.height > 0 ? pieGeometry(data.slices, size) : null),
    [data.slices, size],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tooltipAt, setTooltipAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { setSelectedId(null); setTooltipAt(null); }, [data]);
  const selected = data.slices.find(slice => slice.id === selectedId) ?? null;

  const percent = useCallback(
    (share: number) => (share * 100).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    [locale],
  );
  /** A row keeps the cell as it arrived — a decimal's exact string included; the aggregate is a sum. */
  const valueText = useCallback(
    (entry: PieEntry | PieSlice) => (entry.rowIndex === null ? entry.value.toLocaleString(locale) : formatCellValue(entry.raw) ?? ''),
    [locale],
  );
  const categoryOf = useCallback(
    (slice: PieSlice) => (slice.rowIndex === null ? t('viewer.query.chart.other') : labelOf(slice.label)),
    [t, labelOf],
  );
  const describe = useCallback(
    (slice: PieSlice) => t('viewer.query.chart.sliceDescription', { category: categoryOf(slice), value: valueText(slice), percent: percent(slice.share) }),
    [t, categoryOf, valueText, percent],
  );
  /** The aggregate's own rows, which is where the values it swallowed can be read. */
  const describeMembers = useCallback((slice: PieSlice) => slice.members
    .map(member => t('viewer.query.chart.sliceDescription', { category: labelOf(member.label), value: valueText(member), percent: percent(member.share) }))
    .join(' · '), [t, labelOf, valueText, percent]);

  const tooltipText = selected
    ? [describe(selected), selected.members.length > 0 ? t('viewer.query.chart.otherSummary', { n: selected.members.length.toLocaleString(locale) }) : null].filter(Boolean).join(' · ')
    : null;
  const detailText = selected
    ? [tooltipText, selected.members.length > 0 ? describeMembers(selected) : null].filter(Boolean).join(' · ')
    : null;

  const step = (direction: 1 | -1 | 'first' | 'last') => {
    const at = data.slices.findIndex(slice => slice.id === selectedId);
    const last = data.slices.length - 1;
    const next = direction === 'first' ? 0
      : direction === 'last' ? last
      : at < 0 ? (direction === 1 ? 0 : last)
      : Math.min(last, Math.max(0, at + direction));
    setSelectedId(data.slices[next].id);
    setTooltipAt(null);
  };

  const onDetailKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowRight': step(1); break;
      case 'ArrowLeft': step(-1); break;
      case 'Home': step('first'); break;
      case 'End': step('last'); break;
      case 'Escape': setTooltipAt(null); break;
      default: return;
    }
    event.preventDefault();
  };

  const onPointerMove = usePointerMark(plotRef, useCallback((mark, at) => {
    setSelectedId(mark.getAttribute('data-slice-id'));
    setTooltipAt(at);
  }, []));

  const summary = t('viewer.query.chart.svgLabel', {
    kind: t('viewer.query.chart.pie'),
    x: xName,
    series: (1).toLocaleString(locale),
    points: data.slices.length.toLocaleString(locale),
  });
  const tooltipStyle = tooltipAt && plotRef.current
    ? { left: Math.min(tooltipAt.x + 12, Math.max(0, plotRef.current.clientWidth - 240)), top: Math.max(0, tooltipAt.y - 12) }
    : null;

  return (
    <>
      <div
        ref={plotRef}
        className="relative flex-1 min-h-0 flex flex-wrap items-center justify-center gap-4 p-3 overflow-auto"
        style={{ minHeight: 240 }}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setTooltipAt(null)}
      >
        <div ref={circleRef} className="flex-1 basis-64 min-w-40 self-stretch min-h-0 flex items-center justify-center">
          {geometry && (
            <div role="img" aria-label={summary} aria-describedby={descriptionId}>
              <svg
                data-chart-kind="pie"
                width={geometry.size}
                height={geometry.size}
                viewBox={`0 0 ${geometry.size} ${geometry.size}`}
                className="block select-none"
                aria-hidden="true"
                focusable="false"
              >
                {geometry.arcs.map((arc, i) => {
                  const slice = data.slices[i];
                  const isSelected = slice.id === selectedId;
                  const paint = {
                    'data-mark': '',
                    'data-slice-id': slice.id,
                    'data-selected': isSelected ? '' : undefined,
                    fill: sliceColor(slice, i),
                    // An outline in the surface's own colour keeps two
                    // neighbouring slices apart whatever their colours.
                    stroke: isSelected ? 'var(--chart-focus)' : 'var(--bg-primary)',
                    strokeWidth: isSelected ? 2 : 1,
                  };
                  // A single slice is the whole circle: an arc from a point back to itself draws nothing.
                  return arc.path === null
                    ? <circle key={slice.id} cx={geometry.cx} cy={geometry.cy} r={geometry.radius} {...paint} />
                    : <path key={slice.id} d={arc.path} {...paint} />;
                })}
              </svg>
            </div>
          )}
        </div>
        <ul className="flex-1 basis-64 min-w-40 max-h-full overflow-y-auto flex flex-col gap-0.5">
          {data.slices.map((slice, i) => (
            <li key={slice.id}>
              <button
                type="button"
                aria-pressed={slice.id === selectedId}
                onClick={() => { setSelectedId(slice.id); setTooltipAt(null); }}
                className="w-full inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded text-left hover:bg-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500 aria-pressed:font-semibold"
              >
                <span aria-hidden="true" className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: sliceColor(slice, i) }} />
                <span className="text-primary truncate">{describe(slice)}</span>
              </button>
            </li>
          ))}
        </ul>
        {tooltipText && tooltipStyle && <ChartTooltip text={tooltipText} style={tooltipStyle} />}
      </div>
      <p id={descriptionId} className="sr-only">{t('viewer.query.chart.svgDescription', { summary })}</p>
      <div className="px-3 py-2 border-t border-primary flex flex-wrap items-start gap-x-4 gap-y-2">
        <ChartDetailBox description={detailText} keysHint={t('viewer.query.chart.sliceKeys')} onKeyDown={onDetailKeyDown} />
      </div>
    </>
  );
}
