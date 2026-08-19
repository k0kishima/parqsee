import { useCallback, useEffect, useMemo, useRef, useState, RefObject } from 'react';

export type Axis = 'x' | 'y';

export interface VirtualRange {
  /** Index of the first item to render (inclusive). */
  start: number;
  /** Index of the last item to render (exclusive). */
  end: number;
  /** Size of the spacer standing in for the items before `start`. */
  padStart: number;
  /** Size of the spacer standing in for the items from `end` on. */
  padEnd: number;
  /** Sum of all item sizes. */
  totalSize: number;
  /** Last measured client size of the scroller along the axis (0 until measured). */
  viewportSize: number;
  /** Leading edge of item `index`, in px from the start of the content. */
  offsetOf: (index: number) => number;
  /** Attach to the scrolling element's onScroll. */
  onScroll: () => void;
}

interface Viewport {
  scroll: number;
  size: number;
}

/**
 * Windowing along one axis of a scrolling element.
 *
 * Given the pixel size of every item (column widths or row heights) and a ref
 * to the scroller, this returns the range of items that overlap the viewport
 * (plus `overscan` extras on each side) and the spacer sizes needed to keep
 * the scrollbar and the remaining items in place. Wide files put hundreds of
 * columns on a page and unbounded SQL results put tens of thousands of rows
 * in one grid; rendering all of those cells made WebKit's style recalc take
 * seconds, so both grids window their columns (and the result grid its rows).
 */
export function useVirtualRange(
  sizes: number[],
  scrollerRef: RefObject<HTMLElement>,
  axis: Axis,
  overscan: number
): VirtualRange {
  const [viewport, setViewport] = useState<Viewport>({ scroll: 0, size: 0 });
  const frameRef = useRef<number | null>(null);

  // Prefix sums: offsets[i] is the leading edge of item i, offsets[n] the total.
  const offsets = useMemo(() => {
    const out = new Array<number>(sizes.length + 1);
    out[0] = 0;
    for (let i = 0; i < sizes.length; i++) out[i + 1] = out[i] + sizes[i];
    return out;
  }, [sizes]);

  const readViewport = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = axis === 'x'
      ? { scroll: el.scrollLeft, size: el.clientWidth }
      : { scroll: el.scrollTop, size: el.clientHeight };
    setViewport(prev => (prev.scroll === next.scroll && prev.size === next.size ? prev : next));
  }, [scrollerRef, axis]);

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

  // Track the viewport size (sidebar toggle, window resize, tab becoming
  // visible) without relying on scroll events.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    readViewport();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(readViewport);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollerRef, readViewport, sizes]);

  return useMemo(() => {
    const count = sizes.length;
    const totalSize = offsets[count];
    const offsetOf = (index: number) => offsets[Math.max(0, Math.min(index, count))];

    if (count === 0) {
      return { start: 0, end: 0, padStart: 0, padEnd: 0, totalSize, viewportSize: viewport.size, offsetOf, onScroll };
    }

    // A viewport of size 0 means we have not measured yet (hidden tab or
    // first render): render a modest window rather than nothing so the tab
    // has content the moment it becomes visible.
    const viewSize = viewport.size || (axis === 'x' ? 1200 : 800);
    const from = viewport.scroll;
    const to = from + viewSize;

    // First item whose trailing edge is past the viewport's leading edge.
    let start = searchOffsets(offsets, from, 1, count, true) - 1;
    // One past the last item whose leading edge is before the viewport's trailing edge.
    let end = searchOffsets(offsets, to, start, count, false);

    start = Math.max(0, start - overscan);
    end = Math.min(count, end + overscan);

    return {
      start,
      end,
      padStart: offsets[start],
      padEnd: totalSize - offsets[end],
      totalSize,
      viewportSize: viewport.size,
      offsetOf,
      onScroll,
    };
  }, [sizes.length, offsets, viewport, axis, overscan, onScroll]);
}

export function useColumnVirtualizer(widths: number[], scrollerRef: RefObject<HTMLElement>, overscan = 4) {
  return useVirtualRange(widths, scrollerRef, 'x', overscan);
}

export function useRowVirtualizer(heights: number[], scrollerRef: RefObject<HTMLElement>, overscan = 10) {
  return useVirtualRange(heights, scrollerRef, 'y', overscan);
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
