import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCellValue } from '../../../lib/format';
import { barGeometry, PLOT_MARGIN, Y_AXIS_WIDTH, type AxisTick } from '../lib/chart-geometry';
import { EXCLUSION_REASONS, type ChartKind, type ChartModel, type ChartPoint, type ChartProblem } from '../lib/chart-types';
import { BarChart, type MarkRef } from './charts/bar-chart';
import { seriesColor } from './chart-style';

/**
 * The kinds that have a renderer. The model decides availability for all
 * four; the UI offers and infers only these, so a stage that adds a
 * renderer adds it here and nowhere else.
 */
export const IMPLEMENTED_CHART_KINDS: readonly ChartKind[] = ['bar'];

interface QueryChartProps {
  model: ChartModel;
  kind: ChartKind;
  /** Shown above the plot: the previous kind became unavailable and was replaced. */
  notice?: string | null;
}

/** The sentence for a problem code, with its parameters formatted for the locale. */
export function useProblemText() {
  const { t, i18n } = useTranslation();
  return useCallback((problem: ChartProblem) => {
    const params = Object.fromEntries(
      Object.entries(problem.params ?? {}).map(([k, v]) => [k, typeof v === 'number' ? v.toLocaleString(i18n.language) : v])
    );
    return t(`viewer.query.chart.${problem.code}`, params);
  }, [t, i18n.language]);
}

/** The plot area's size, from a ResizeObserver so a hidden tab's chart is measured when it comes back. */
function useElementSize(ref: React.RefObject<HTMLElement>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number, height: number) => {
      setSize(current => (current.width === width && current.height === height ? current : { width, height }));
    };
    const rect = element.getBoundingClientRect();
    update(rect.width, rect.height);
    const observer = new ResizeObserver(entries => {
      const entry = entries[entries.length - 1];
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * The chart of a result: the plot with its Y axis beside it, the legend,
 * what was left out and why, and one "data point details" box that the
 * keyboard, the legend and the pointer all drive. There is no focusable
 * element per mark: a result can have ten thousand of them, and the
 * arrow keys walk them from the one box instead.
 */
export function QueryChart({ model, kind, notice }: QueryChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const problemText = useProblemText();
  const plotRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(plotRef);
  const descriptionId = useId();
  const keysId = useId();

  const geometry = useMemo(() => {
    if (kind !== 'bar') return null;
    if (size.width <= 0 || size.height <= 0) return null;
    return barGeometry(model, { width: size.width, height: size.height }, locale);
  }, [model, kind, size.width, size.height, locale]);

  // The detail and the tooltip describe one point. `selected` is what the
  // keyboard and the legend chose (and the pointer, while it hovers).
  const [selected, setSelected] = useState<MarkRef | null>(null);
  const [tooltipAt, setTooltipAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { setSelected(null); setTooltipAt(null); }, [model, kind]);

  const pointAt = useCallback((ref: MarkRef | null): ChartPoint | null =>
    ref ? model.points.find(p => p.rowIndex === ref.rowIndex && p.seriesOrdinal === ref.seriesOrdinal) ?? null : null,
  [model.points]);
  const labelOf = useCallback((label: string) => (label === '' ? t('viewer.query.chart.emptyString') : label), [t]);

  /** The plotted points of one series, in row order. */
  const seriesPoints = useCallback((ordinal: number) => model.points.filter(p => p.seriesOrdinal === ordinal), [model.points]);

  /** The point of `ordinal` at `rowIndex`, else the nearest plotted row (the later one on a tie). */
  const nearestInSeries = useCallback((ordinal: number, rowIndex: number): MarkRef | null => {
    const points = seriesPoints(ordinal);
    if (points.length === 0) return null;
    let best = points[0];
    for (const p of points) {
      const d = Math.abs(p.rowIndex - rowIndex);
      const bd = Math.abs(best.rowIndex - rowIndex);
      if (d < bd || (d === bd && p.rowIndex > best.rowIndex)) best = p;
    }
    return { rowIndex: best.rowIndex, seriesOrdinal: ordinal };
  }, [seriesPoints]);

  const step = useCallback((direction: 1 | -1 | 'first' | 'last') => {
    const ordinal = selected?.seriesOrdinal ?? model.series.find(s => s.validCount > 0)?.ordinal ?? 0;
    const points = seriesPoints(ordinal);
    if (points.length === 0) return;
    const at = selected ? points.findIndex(p => p.rowIndex === selected.rowIndex) : -1;
    let next: ChartPoint;
    if (direction === 'first') next = points[0];
    else if (direction === 'last') next = points[points.length - 1];
    else if (at < 0) next = direction === 1 ? points[0] : points[points.length - 1];
    else next = points[Math.min(points.length - 1, Math.max(0, at + direction))];
    setSelected({ rowIndex: next.rowIndex, seriesOrdinal: ordinal });
    setTooltipAt(null);
  }, [selected, model.series, seriesPoints]);

  const changeSeries = useCallback((ordinal: number) => {
    const target = nearestInSeries(ordinal, selected?.rowIndex ?? 0);
    if (target) { setSelected(target); setTooltipAt(null); }
  }, [nearestInSeries, selected]);

  const onDetailKeyDown = (event: React.KeyboardEvent) => {
    const count = model.series.length;
    const ordinal = selected?.seriesOrdinal ?? 0;
    switch (event.key) {
      case 'ArrowRight': step(1); break;
      case 'ArrowLeft': step(-1); break;
      case 'Home': step('first'); break;
      case 'End': step('last'); break;
      case 'ArrowDown': if (count > 0) changeSeries((ordinal + 1) % count); break;
      case 'ArrowUp': if (count > 0) changeSeries((ordinal - 1 + count) % count); break;
      case 'Escape': setTooltipAt(null); break;
      default: return;
    }
    event.preventDefault();
  };

  // One handler on the plot reads the mark under the pointer, at most once a frame.
  const frame = useRef<number | null>(null);
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = (event.target as Element).closest?.('[data-mark]') as SVGElement | null;
    const container = plotRef.current;
    if (!target || !container) return;
    const rowIndex = Number(target.getAttribute('data-row-index'));
    const seriesOrdinal = Number(target.getAttribute('data-series-index'));
    const bounds = container.getBoundingClientRect();
    const at = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setSelected({ rowIndex, seriesOrdinal });
      setTooltipAt(at);
    });
  };
  const onPointerLeave = () => { setTooltipAt(null); };
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);

  const point = pointAt(selected);
  const description = point ? describePoint(point) : null;
  function describePoint(p: ChartPoint): string {
    const series = model.series[p.seriesOrdinal];
    const row = model.rows[p.rowIndex];
    return t('viewer.query.chart.pointDescription', {
      series: `#${series.ordinal + 1} ${series.name}`,
      row: (p.rowIndex + 1).toLocaleString(locale),
      xName: model.x?.name ?? '',
      x: labelOf(row.label),
      yName: series.name,
      y: formatCellValue(p.raw) ?? '',
    });
  }

  const summary = t('viewer.query.chart.svgLabel', {
    kind: t(`viewer.query.chart.${kind}`),
    x: model.x?.name ?? '',
    series: model.series.length.toLocaleString(locale),
    points: model.points.length.toLocaleString(locale),
  });
  const { diagnostics } = model;
  const excludedNote = diagnostics.excludedPoints > 0
    ? [t('viewer.query.chart.excluded', { excluded: diagnostics.excludedPoints.toLocaleString(locale), total: diagnostics.candidatePoints.toLocaleString(locale) }),
      ...EXCLUSION_REASONS.filter(r => diagnostics.byReason[r] > 0).map(r => t(`viewer.query.chart.${r}`, { n: diagnostics.byReason[r].toLocaleString(locale) }))].join(' · ')
    : null;

  const tooltipStyle = tooltipAt && plotRef.current
    ? { left: Math.min(tooltipAt.x + 12, Math.max(0, plotRef.current.clientWidth - 240)), top: Math.max(0, tooltipAt.y - 12) }
    : undefined;

  const problem = model.problem ?? (model.availability[kind].available ? null : model.availability[kind].reason);

  return (
    <div className="flex-1 min-h-0 flex flex-col text-xs text-secondary">
      {(notice || model.truncated || diagnostics.ignoredColumns.length > 0 || excludedNote) && (
        <div className="px-3 py-1.5 border-b border-primary flex flex-wrap gap-x-4 gap-y-1">
          {notice && <span className="text-amber-700 dark:text-amber-400">{notice}</span>}
          {model.truncated && <span className="text-amber-700 dark:text-amber-400">{t('viewer.query.chart.partial', { n: model.rows.length.toLocaleString(locale) })}</span>}
          {diagnostics.ignoredColumns.length > 0 && <span>{t('viewer.query.chart.ignoredColumns', { columns: diagnostics.ignoredColumns.join(', ') })}</span>}
          {excludedNote && <span>{excludedNote}</span>}
        </div>
      )}
      {problem ? (
        <div className="flex-1 flex items-center justify-center p-6 text-center text-sm text-tertiary">
          <p role="status">{problemText(problem)}</p>
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 flex overflow-hidden" style={{ minHeight: 240 }}>
            <YAxis ticks={geometry?.yTicks ?? []} height={size.height} title={model.series.length === 1 ? model.series[0].name : t('viewer.query.chart.values')} />
            <div
              ref={plotRef}
              className="relative flex-1 min-w-0 overflow-x-auto overflow-y-hidden"
              onPointerMove={onPointerMove}
              onPointerLeave={onPointerLeave}
            >
              {geometry && (
                <div role="img" aria-label={summary} aria-describedby={descriptionId} className="h-full">
                  <BarChart model={model} geometry={geometry} height={size.height} selected={selected} labelOf={labelOf} />
                </div>
              )}
              {point && tooltipStyle && (
                <div
                  role="tooltip"
                  className="absolute z-10 max-w-60 px-2 py-1 rounded border border-primary bg-primary text-primary shadow-md whitespace-pre-wrap break-words pointer-events-auto"
                  style={tooltipStyle}
                >
                  {description}
                </div>
              )}
            </div>
          </div>
          <p id={descriptionId} className="sr-only">{t('viewer.query.chart.svgDescription', { summary })}</p>
          <div className="px-3 py-2 border-t border-primary flex flex-wrap items-start gap-x-4 gap-y-2">
            <ul className="flex flex-wrap gap-x-3 gap-y-1 max-h-24 overflow-y-auto">
              {model.series.map(series => (
                <li key={series.ordinal}>
                  <button
                    type="button"
                    aria-pressed={(selected?.seriesOrdinal ?? -1) === series.ordinal}
                    aria-label={t('viewer.query.chart.seriesDetails', { name: `#${series.ordinal + 1} ${series.name}` })}
                    onClick={() => changeSeries(series.ordinal)}
                    className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500 aria-pressed:font-semibold"
                  >
                    <span aria-hidden="true" className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: seriesColor(series.ordinal) }} />
                    <span className="text-primary">#{series.ordinal + 1} {series.name}</span>
                    {series.validCount === 0 && <span className="italic text-tertiary">— {t('viewer.query.chart.seriesEmpty', { name: series.name })}</span>}
                  </button>
                </li>
              ))}
            </ul>
            <div
              data-chart-detail=""
              tabIndex={0}
              role="group"
              aria-label={t('viewer.query.chart.detailLabel')}
              aria-describedby={keysId}
              onKeyDown={onDetailKeyDown}
              className="ml-auto min-w-48 max-w-full px-2 py-1 rounded border border-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <div aria-live="polite" className="text-primary">{description ?? t('viewer.query.chart.detailEmpty')}</div>
              <div id={keysId} className="text-tertiary">{t('viewer.query.chart.detailKeys')}</div>
            </div>
          </div>
        </>
      )}
      <p className="px-3 py-1 border-t border-primary text-tertiary">
        {t('viewer.query.chart.axisRule')} {t('viewer.query.chart.autoRule')}
      </p>
    </div>
  );
}

/** The Y axis in its own SVG, so it stays put while the bars scroll. */
function YAxis({ ticks, height, title }: { ticks: AxisTick[]; height: number; title: string }) {
  return (
    <svg width={Y_AXIS_WIDTH} height={height} viewBox={`0 0 ${Y_AXIS_WIDTH} ${height}`} aria-hidden="true" focusable="false" className="block shrink-0">
      <line x1={Y_AXIS_WIDTH - 0.5} x2={Y_AXIS_WIDTH - 0.5} y1={PLOT_MARGIN.top} y2={Math.max(PLOT_MARGIN.top, height - PLOT_MARGIN.bottom)} stroke="var(--chart-axis)" strokeWidth={1} />
      {ticks.map(tick => (
        <g key={tick.value}>
          <line x1={Y_AXIS_WIDTH - 5} x2={Y_AXIS_WIDTH} y1={tick.position} y2={tick.position} stroke="var(--chart-axis)" strokeWidth={1} />
          <text x={Y_AXIS_WIDTH - 8} y={tick.position + 3.5} textAnchor="end" fontSize={11} fill="var(--text-tertiary)">{tick.label}</text>
        </g>
      ))}
      <text x={4} y={12} fontSize={11} fill="var(--text-tertiary)">
        <title>{title}</title>
        {title.length > 10 ? `${title.slice(0, 9)}…` : title}
      </text>
    </svg>
  );
}
