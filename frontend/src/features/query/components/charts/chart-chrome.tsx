import React, { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** The (row, series) a mark belongs to; what the tooltip and the detail describe. */
export interface MarkRef {
  rowIndex: number;
  seriesOrdinal: number;
}

/** The plot area's size, from a ResizeObserver so a hidden tab's chart is measured when it comes back. */
export function useElementSize(ref: React.RefObject<HTMLElement>) {
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
 * Where the pointer is in the plot's own coordinates, at most once a
 * frame: a result can hold ten thousand marks, and answering every move
 * would cost more than the chart. The plot does not scroll vertically and
 * a kind that scrolls sideways places its marks in the same coordinates
 * the tooltip is placed in, so the position is taken from the container's
 * box as it stands.
 */
export function usePointerAt(
  plotRef: React.RefObject<HTMLElement>,
  onMove: (at: { x: number; y: number }, target: Element) => void,
) {
  const frame = useRef<number | null>(null);
  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const container = plotRef.current;
    if (!container) return;
    const target = event.target as Element;
    const bounds = container.getBoundingClientRect();
    const at = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      onMove(at, target);
    });
  }, [plotRef, onMove]);
  useLayoutEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  return onPointerMove;
}

/**
 * The mark under the pointer, for the kinds that draw one element per
 * value and can be asked which one the pointer is over.
 */
export function usePointerMark(plotRef: React.RefObject<HTMLElement>, onMark: (mark: SVGElement, at: { x: number; y: number }) => void) {
  return usePointerAt(plotRef, useCallback((at, target) => {
    const mark = target.closest?.('[data-mark]') as SVGElement | null;
    if (mark) onMark(mark, at);
  }, [onMark]));
}

/** An X label as a chart draws it: an empty string is named rather than shown as nothing. */
export function useLabelOf() {
  const { t } = useTranslation();
  return useCallback((label: string) => (label === '' ? t('viewer.query.chart.emptyString') : label), [t]);
}

interface ChartDetailBoxProps {
  /** The selected mark in words, or null when nothing is selected. */
  description: string | null;
  /** Which keys move the selection — the kinds differ, a pie having no series. */
  keysHint: string;
  onKeyDown: (event: React.KeyboardEvent) => void;
}

/**
 * The one focusable box that describes the selected mark. A result can
 * hold ten thousand marks, and a tab stop each would bury the rest of the
 * page, so the arrow keys walk them from here and the box announces where
 * they landed.
 */
export function ChartDetailBox({ description, keysHint, onKeyDown }: ChartDetailBoxProps) {
  const { t } = useTranslation();
  const keysId = useId();
  return (
    <div
      data-chart-detail=""
      tabIndex={0}
      role="group"
      aria-label={t('viewer.query.chart.detailLabel')}
      aria-describedby={keysId}
      onKeyDown={onKeyDown}
      className="ml-auto min-w-48 max-w-full px-2 py-1 rounded border border-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
    >
      <div aria-live="polite" className="text-primary max-h-24 overflow-y-auto">{description ?? t('viewer.query.chart.detailEmpty')}</div>
      <div id={keysId} className="text-tertiary">{keysHint}</div>
    </div>
  );
}

/**
 * Where the tooltip sits for a pointer at `at`, in the plot's own
 * coordinates: just below and right of the mark, and never far enough right
 * that its 240px of width would run off the plot. Returns null when there is
 * nothing to place, so a caller can test it and the tooltip together.
 */
export function tooltipPosition(
  plotRef: React.RefObject<HTMLElement>,
  at: { x: number; y: number } | null,
): React.CSSProperties | null {
  if (!at || !plotRef.current) return null;
  return {
    left: Math.min(at.x + 12, Math.max(0, plotRef.current.clientWidth - 240)),
    top: Math.max(0, at.y - 12),
  };
}

/**
 * The chart's spoken summary, the one sentence a screen reader gets in place
 * of the SVG. Every kind counts its series and its points the same way, so
 * the numbers are formatted here rather than at each renderer.
 */
export function useChartSummary(kind: string, x: string, series: number, points: number) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  return t('viewer.query.chart.svgLabel', {
    kind,
    x,
    series: series.toLocaleString(locale),
    points: points.toLocaleString(locale),
  });
}

/** The hover tooltip, placed in the plot's own coordinates by its caller. */
export function ChartTooltip({ text, style }: { text: string; style: React.CSSProperties }) {
  return (
    <div
      role="tooltip"
      className="absolute z-10 max-w-60 px-2 py-1 rounded border border-primary bg-primary text-primary shadow-md whitespace-pre-wrap break-words pointer-events-auto"
      style={style}
    >
      {text}
    </div>
  );
}
