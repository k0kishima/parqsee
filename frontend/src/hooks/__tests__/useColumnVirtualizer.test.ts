import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useColumnVirtualizer } from '../useColumnVirtualizer';

function fakeScroller(scrollLeft: number, clientWidth: number) {
  return { current: { scrollLeft, clientWidth } as unknown as HTMLElement };
}

describe('useColumnVirtualizer', () => {
  const widths = Array.from({ length: 100 }, () => 100); // 100 columns, 10,000px

  it('renders the columns overlapping the viewport plus overscan', () => {
    const ref = fakeScroller(2550, 500);
    const { result } = renderHook(() => useColumnVirtualizer(widths, ref, 2));

    // Viewport covers 2550..3050 => columns 25..30, overscan 2 => 23..32
    expect(result.current.start).toBe(23);
    expect(result.current.end).toBe(33);
    expect(result.current.padLeft).toBe(2300);
    expect(result.current.padRight).toBe(10000 - 3300);
    expect(result.current.totalWidth).toBe(10000);
    expect(result.current.viewportWidth).toBe(500);
  });

  it('clamps at both ends', () => {
    const { result: head } = renderHook(() => useColumnVirtualizer(widths, fakeScroller(0, 500), 4));
    expect(head.current.start).toBe(0);
    expect(head.current.padLeft).toBe(0);

    const { result: tail } = renderHook(() => useColumnVirtualizer(widths, fakeScroller(9500, 500), 4));
    expect(tail.current.end).toBe(100);
    expect(tail.current.padRight).toBe(0);
  });

  it('falls back to a default window before the viewport is measured', () => {
    const ref = { current: null };
    const { result } = renderHook(() => useColumnVirtualizer(widths, ref));
    expect(result.current.start).toBe(0);
    expect(result.current.end).toBeGreaterThan(0);
    expect(result.current.end).toBeLessThan(100);
  });

  it('handles an empty column list', () => {
    const { result } = renderHook(() => useColumnVirtualizer([], fakeScroller(0, 500)));
    expect(result.current).toMatchObject({ start: 0, end: 0, padLeft: 0, padRight: 0, totalWidth: 0 });
  });

  it('reports the left edge of a column', () => {
    const { result } = renderHook(() => useColumnVirtualizer([50, 70, 90], fakeScroller(0, 500)));
    expect(result.current.offsetOf(0)).toBe(0);
    expect(result.current.offsetOf(2)).toBe(120);
    expect(result.current.offsetOf(3)).toBe(210);
  });

  it('re-reads the viewport on scroll, once per animation frame', async () => {
    const ref = fakeScroller(0, 500);
    const { result } = renderHook(() => useColumnVirtualizer(widths, ref, 0));
    expect(result.current.start).toBe(0);

    (ref.current as unknown as { scrollLeft: number }).scrollLeft = 5000;
    await act(async () => {
      result.current.onScroll();
      result.current.onScroll();
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    });
    expect(result.current.start).toBe(50);
    expect(result.current.end).toBe(55);
  });
});
