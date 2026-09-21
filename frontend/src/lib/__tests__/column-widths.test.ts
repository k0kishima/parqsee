import { describe, it, expect } from 'vitest';
import {
  cellOverflows,
  displayCells,
  estimateCellWidth,
  measureCharWidth,
  measureColumnWidths,
  MIN_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
} from '../column-widths';

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

describe('displayCells', () => {
  it('counts one cell per narrow character', () => {
    expect(displayCells('abc')).toBe(3);
    expect(displayCells('')).toBe(0);
  });

  it('counts two cells for an ideograph and one for a halfwidth kana', () => {
    expect(displayCells('日本')).toBe(4);
    expect(displayCells('ｱｲ')).toBe(2);
  });
});

// A monospaced grid gives an ideograph, a fullwidth form or an emoji the
// width of two digits; measuring by character count made those columns half
// as wide as their contents.
describe('measureColumnWidths with wide characters', () => {
  const charWidth = measureCharWidth('mono');
  const widthOf = (value: string) =>
    measureColumnWidths([{ name: 'v', typeLabel: '' }], [{ v: value }])[0];

  it('measures a CJK value at two cells per character', () => {
    const cjk = widthOf('日本語日本語');
    const latin = widthOf('abcdef');
    expect(cjk).toBeGreaterThan(latin);
    expect(cjk - latin).toBeCloseTo(6 * charWidth, 0);
  });

  it('counts an emoji as a wide cell', () => {
    expect(widthOf('\u{1f389}'.repeat(8))).toBeGreaterThan(widthOf('a'.repeat(8)));
  });

  it('gives a combining mark no width of its own', () => {
    expect(widthOf('e\u0301'.repeat(20))).toBe(widthOf('e'.repeat(20)));
  });
});

describe('estimateCellWidth', () => {
  it('is the cells of the text at the width of one character', () => {
    expect(estimateCellWidth('ab', 8)).toBe(16);
    expect(estimateCellWidth('日本', 8)).toBe(32);
  });
});

describe('cellOverflows', () => {
  it('answers from the column width, wide characters counted', () => {
    // 32px of padding, so two narrow characters need 48px and two
    // ideographs 64px.
    expect(cellOverflows('ab', 8, 48)).toBe(false);
    expect(cellOverflows('ab', 8, 47)).toBe(true);
    expect(cellOverflows('日本', 8, 48)).toBe(true);
    expect(cellOverflows('日本', 8, 64)).toBe(false);
  });
});
