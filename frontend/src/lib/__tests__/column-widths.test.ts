import { describe, it, expect } from 'vitest';
import { measureColumnWidths, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH } from '../column-widths';

// jsdom has no canvas, so widths come from the character-count fallback;
// these tests pin the behaviour that does not depend on real font metrics.
describe('measureColumnWidths', () => {
  it('returns one width per column, within the clamp range', () => {
    const columns = [{ name: 'a', typeLabel: 'Int64' }, { name: 'b', typeLabel: 'Double' }];
    const widths = measureColumnWidths(columns, [{ a: 1, b: 2.5 }]);
    expect(widths).toHaveLength(2);
    for (const w of widths) {
      expect(w).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH);
      expect(w).toBeLessThanOrEqual(MAX_COLUMN_WIDTH);
    }
  });

  it('grows with the longest value and caps at the maximum', () => {
    const columns = [{ name: 'v', typeLabel: '' }];
    const short = measureColumnWidths(columns, [{ v: 'x' }]);
    const medium = measureColumnWidths(columns, [{ v: 'x'.repeat(30) }]);
    const huge = measureColumnWidths(columns, [{ v: 'x'.repeat(5000) }]);
    expect(medium[0]).toBeGreaterThan(short[0]);
    expect(huge[0]).toBe(MAX_COLUMN_WIDTH);
  });

  it('ignores null values and uses the caller formatter', () => {
    const columns = [{ name: 'v', typeLabel: '' }];
    const nulls = measureColumnWidths(columns, [{ v: null }, { v: undefined }]);
    const objects = measureColumnWidths(columns, [{ v: { deeply: { nested: 'object value' } } }], {
      format: value => JSON.stringify(value),
    });
    expect(objects[0]).toBeGreaterThan(nulls[0]);
  });
});
