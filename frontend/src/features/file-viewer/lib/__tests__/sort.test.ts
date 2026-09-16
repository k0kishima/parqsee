import { describe, it, expect } from 'vitest';
import { isSortableColumn, nextSort } from '../sort';

describe('nextSort', () => {
  it('cycles a column through ascending, descending and file order', () => {
    const asc = nextSort(null, 'id');
    expect(asc).toEqual({ column: 'id', direction: 'asc' });
    const desc = nextSort(asc, 'id');
    expect(desc).toEqual({ column: 'id', direction: 'desc' });
    expect(nextSort(desc, 'id')).toBeNull();
  });

  it('starts over ascending on another column whatever the current direction', () => {
    expect(nextSort({ column: 'id', direction: 'asc' }, 'name')).toEqual({ column: 'name', direction: 'asc' });
    expect(nextSort({ column: 'id', direction: 'desc' }, 'name')).toEqual({ column: 'name', direction: 'asc' });
  });
});

describe('isSortableColumn', () => {
  it('offers every kind but nested values and the ones with no order', () => {
    for (const kind of ['boolean', 'integer', 'float', 'decimal', 'text', 'temporal', 'binary'] as const) {
      expect(isSortableColumn({ kind })).toBe(true);
    }
    expect(isSortableColumn({ kind: 'nested' })).toBe(false);
    expect(isSortableColumn({ kind: 'other' })).toBe(false);
  });
});
