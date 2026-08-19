import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useColumnVirtualizer, useRowVirtualizer } from '../useVirtualRange';

function fakeScroller(scrollLeft: number, clientWidth: number) {
  return { current: { scrollLeft, clientWidth, scrollTop: 0, clientHeight: 0 } as unknown as HTMLElement };
}

describe('useVirtualRange', () => {
  const widths = Array.from({ length: 100 }, () => 100); // 100 columns, 10,000px

  it('renders the columns overlapping the viewport plus overscan', () => {
    const ref = fakeScroller(2550, 500);
    const { result } = renderHook(() => useColumnVirtualizer(widths, ref, 2));

    // Viewport covers 2550..3050 => columns 25..30, overscan 2 => 23..32
    expect(result.current.start).toBe(23);
    expect(result.current.end).toBe(33);
    expect(result.current.padStart).toBe(2300);
    expect(result.current.padEnd).toBe(10000 - 3300);
    expect(result.current.totalSize).toBe(10000);
    expect(result.current.viewportSize).toBe(500);
  });

  it('clamps at both ends', () => {
    const { result: head } = renderHook(() => useColumnVirtualizer(widths, fakeScroller(0, 500), 4));
    expect(head.current.start).toBe(0);
    expect(head.current.padStart).toBe(0);

    const { result: tail } = renderHook(() => useColumnVirtualizer(widths, fakeScroller(9500, 500), 4));
    expect(tail.current.end).toBe(100);
    expect(tail.current.padEnd).toBe(0);
  });

  it('falls back to a default window before the viewport is measured', () => {
    const ref = { current: null };
    const { result } = renderHook(() => useColumnVirtualizer(widths, ref));
    expect(result.current.start).toBe(0);
    expect(result.current.end).toBeGreaterThan(0);
    expect(result.current.end).toBeLessThan(100);
  });

  it('windows rows along the vertical axis', () => {
    const heights = Array.from({ length: 1000 }, () => 30);
    const ref = { current: { scrollLeft: 0, clientWidth: 0, scrollTop: 3000, clientHeight: 300 } as unknown as HTMLElement };
    const { result } = renderHook(() => useRowVirtualizer(heights, ref, 0));
    expect(result.current.start).toBe(100);
    expect(result.current.end).toBe(110);
    expect(result.current.padStart).toBe(3000);
    expect(result.current.padEnd).toBe(30000 - 3300);
  });

  it('handles an empty column list', () => {
    const { result } = renderHook(() => useColumnVirtualizer([], fakeScroller(0, 500)));
    expect(result.current).toMatchObject({ start: 0, end: 0, padStart: 0, padEnd: 0, totalSize: 0 });
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
