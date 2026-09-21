import React, { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
 * One handler on the plot reads the mark under the pointer, at most once a
 * frame: a result can hold ten thousand marks, and a listener each would
 * cost more than the chart.
 */
export function usePointerMark(plotRef: React.RefObject<HTMLElement>, onMark: (mark: SVGElement, at: { x: number; y: number }) => void) {
  const frame = useRef<number | null>(null);
  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const target = (event.target as Element).closest?.('[data-mark]') as SVGElement | null;
    const container = plotRef.current;
    if (!target || !container) return;
    const bounds = container.getBoundingClientRect();
    const at = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      onMark(target, at);
    });
  }, [plotRef, onMark]);
  useLayoutEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  return onPointerMove;
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
