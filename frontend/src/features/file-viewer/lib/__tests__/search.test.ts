import { describe, it, expect } from 'vitest';
import { findSearchMatches, indexOfTerm, matchesTerm } from '../search';

const columns = [{ name: 'id' }, { name: 'Name' }, { name: 'meta' }];
const rows = [
  { id: 1, Name: 'Alice', meta: { city: 'Nantes' } },
  { id: 2, Name: null, meta: null },
  { id: 31, Name: 'bob', meta: [1, 2] },
];

describe('indexOfTerm / matchesTerm', () => {
  it('finds the term regardless of case and reports where', () => {
    expect(indexOfTerm('Alice', 'LIC')).toBe(1);
    expect(indexOfTerm('Alice', 'x')).toBe(-1);
    expect(matchesTerm('Alice', 'ali')).toBe(true);
  });

  it('never matches an empty term, an empty text or NULL', () => {
    expect(indexOfTerm('Alice', '')).toBe(-1);
    expect(indexOfTerm('', 'a')).toBe(-1);
    expect(matchesTerm(null, 'a')).toBe(false);
  });
});

describe('findSearchMatches', () => {
  it('lists header matches first, then cells in row and column order', () => {
    expect(findSearchMatches('na', columns, rows)).toEqual([
      { rowIndex: -1, colIndex: 1, value: 'Name' },
      { rowIndex: 0, colIndex: 2, value: '{"city":"Nantes"}' },
    ]);
  });

  it('matches cells as the grid renders them: numbers as text, NULL not at all', () => {
    expect(findSearchMatches('1', columns, rows)).toEqual([
      { rowIndex: 0, colIndex: 0, value: '1' },
      { rowIndex: 2, colIndex: 0, value: '31' },
      { rowIndex: 2, colIndex: 2, value: '[1,2]' },
    ]);
  });

  it('is empty for an empty term', () => {
    expect(findSearchMatches('', columns, rows)).toEqual([]);
  });

  it('stops at the cap', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: i, Name: 'a', meta: 'a' }));
    expect(findSearchMatches('a', columns, many, 7)).toHaveLength(7);
    // The header "Name" matches too, and counts towards the cap.
    expect(findSearchMatches('a', columns, many, 1)).toEqual([{ rowIndex: -1, colIndex: 1, value: 'Name' }]);
  });
});
