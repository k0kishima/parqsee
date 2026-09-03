import { describe, it, expect } from 'vitest';
import { pageWindow } from '../page-window';

describe('pageWindow', () => {
  it('addresses the page by offset and page size', () => {
    expect(pageWindow(1, 50, 120)).toEqual({ offset: 0, limit: 50, startRow: 1, endRow: 50 });
    expect(pageWindow(3, 50, 120)).toEqual({ offset: 100, limit: 50, startRow: 101, endRow: 120 });
  });

  it('reports no rows for an empty result', () => {
    expect(pageWindow(1, 50, 0)).toEqual({ offset: 0, limit: 50, startRow: 0, endRow: 0 });
  });

  it('clamps both bounds to the last row past the end of the result', () => {
    expect(pageWindow(4, 50, 120)).toEqual({ offset: 150, limit: 50, startRow: 120, endRow: 120 });
  });
});
