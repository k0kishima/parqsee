import { useCallback, useEffect, useMemo, useRef, useState, RefObject } from 'react';

export interface ColumnVirtualizer {
  /** Index of the first column to render (inclusive). */
  start: number;
  /** Index of the last column to render (exclusive). */
  end: number;
  /** Width of the spacer standing in for the columns before `start`. */
  padLeft: number;
  /** Width of the spacer standing in for the columns from `end` on. */
  padRight: number;
  /** Sum of all column widths. */
  totalWidth: number;
  /** Last measured clientWidth of the scroller (0 until measured). */
  viewportWidth: number;
  /** Left edge of column `index`, in px from the table's left edge. */
  offsetOf: (index: number) => number;
  /** Attach to the horizontally scrolling element's onScroll. */
  onScroll: () => void;
}

interface Viewport {
  scrollLeft: number;
  width: number;
}

/**
 * Horizontal windowing for a wide table.
 *
 * Given the pixel width of every column and a ref to the element that scrolls
 * horizontally, this returns the range of columns that overlap the viewport
 * (plus `overscan` extras on each side) and the spacer widths needed to keep
 * the scrollbar and the remaining columns in place. Files with hundreds of
 * columns would otherwise put tens of thousands of cells in the DOM per page,
 * and WebKit's style recalc over that many elements is what made tab switches
 * take close to a second.
 */
export function useColumnVirtualizer(
  widths: number[],
  scrollerRef: RefObject<HTMLElement>,
  overscan = 4
): ColumnVirtualizer {
  const [viewport, setViewport] = useState<Viewport>({ scrollLeft: 0, width: 0 });
  const frameRef = useRef<number | null>(null);

  // Prefix sums: offsets[i] is the left edge of column i, offsets[n] the total.
  const offsets = useMemo(() => {
    const out = new Array<number>(widths.length + 1);
    out[0] = 0;
    for (let i = 0; i < widths.length; i++) out[i + 1] = out[i] + widths[i];
    return out;
  }, [widths]);

  const readViewport = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = { scrollLeft: el.scrollLeft, width: el.clientWidth };
    setViewport(prev =>
      prev.scrollLeft === next.scrollLeft && prev.width === next.width ? prev : next
    );
  }, [scrollerRef]);

  // Coalesce scroll events to one state update per frame.
  const onScroll = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      readViewport();
    });
  }, [readViewport]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  // Track the viewport width (sidebar toggle, window resize, tab becoming
  // visible) without relying on scroll events.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    readViewport();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(readViewport);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollerRef, readViewport, widths]);

  return useMemo(() => {
    const count = widths.length;
    const totalWidth = offsets[count];
    const offsetOf = (index: number) => offsets[Math.max(0, Math.min(index, count))];

    if (count === 0) {
      return { start: 0, end: 0, padLeft: 0, padRight: 0, totalWidth, viewportWidth: viewport.width, offsetOf, onScroll };
    }

    // A viewport of width 0 means we have not measured yet (hidden tab or
    // first render): render a modest window rather than nothing so the tab
    // has content the moment it becomes visible.
    const viewWidth = viewport.width || 1200;
    const left = viewport.scrollLeft;
    const right = left + viewWidth;

    // First column whose right edge is past the viewport's left edge.
    let start = searchOffsets(offsets, left, 1, count, true) - 1;
    // One past the last column whose left edge is before the viewport's right edge.
    let end = searchOffsets(offsets, right, start, count, false);

    start = Math.max(0, start - overscan);
    end = Math.min(count, end + overscan);

    return {
      start,
      end,
      padLeft: offsets[start],
      padRight: totalWidth - offsets[end],
      totalWidth,
      viewportWidth: viewport.width,
      offsetOf,
      onScroll,
    };
  }, [widths.length, offsets, viewport, overscan, onScroll]);
}

/**
 * Smallest i in [lo, hi) with sorted[i] > value (strict) or sorted[i] >= value
 * (non-strict), or hi when there is none.
 */
function searchOffsets(sorted: number[], value: number, lo: number, hi: number, strict: boolean): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const past = strict ? sorted[mid] > value : sorted[mid] >= value;
    if (past) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
