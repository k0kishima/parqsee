import { describe, it, expect } from 'vitest';
import { applyConditions, columnAlias, filterSqlOf, type AppliedCondition } from '../result-filter';

const condition = (columnIndex: number, operator: AppliedCondition['operator'], value: string): AppliedCondition => ({
  columnIndex,
  operator,
  label: `col${columnIndex} ${operator} ${value}`,
  sql: `${columnAlias(columnIndex)} ${operator} ${value}`,
});

describe('columnAlias', () => {
  it('names a column by its position, as the backend addresses it', () => {
    expect(columnAlias(0)).toBe('c0');
    expect(columnAlias(12)).toBe('c12');
  });
});

describe('applyConditions', () => {
  it('keeps conditions on other columns and other operators', () => {
    const existing = [condition(0, '=', "'a'"), condition(1, '>=', '5')];
    const next = applyConditions(existing, [condition(2, '=', "'b'")]);
    expect(next.map(c => c.sql)).toEqual(["c0 = 'a'", 'c1 >= 5', "c2 = 'b'"]);
  });

  it('replaces a condition on the same column with the same operator', () => {
    const existing = [condition(1, '>=', '0'), condition(1, '<', '100')];
    const next = applyConditions(existing, [condition(1, '>=', '40'), condition(1, '<', '60')]);
    expect(next.map(c => c.sql)).toEqual(['c1 >= 40', 'c1 < 60']);
  });

  // A bucket's upper bound is `<` or `<=` depending on whether the last
  // instant of the range falls inside it, so the two share a slot: a
  // drill-down must replace the wider bound, not add a second one.
  it('lets the two upper bounds replace each other', () => {
    const existing = [condition(0, '<=', "'2024-01-02'")];
    const next = applyConditions(existing, [condition(0, '<', "'2024-01-01T12:00:00'")]);
    expect(next.map(c => c.sql)).toEqual(["c0 < '2024-01-01T12:00:00'"]);
  });

  it('keeps a NULL condition apart from a value on the same column', () => {
    const existing = [condition(0, '=', "'a'")];
    const next = applyConditions(existing, [condition(0, 'IS NULL', '')]);
    expect(next.map(c => c.operator)).toEqual(['=', 'IS NULL']);
  });
});

describe('filterSqlOf', () => {
  it('joins the conditions with AND, and is undefined when there are none', () => {
    expect(filterSqlOf([])).toBeUndefined();
    expect(filterSqlOf([condition(0, '=', "'a'"), condition(1, '>=', '5')])).toBe("c0 = 'a' AND c1 >= 5");
  });
});
