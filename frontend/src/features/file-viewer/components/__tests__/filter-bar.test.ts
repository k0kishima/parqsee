import { describe, expect, it } from 'vitest';
import { buildFilterExpression, FilterRow } from '../filter-bar';
import type { ColumnInfo } from '../../api';

const column = (name: string, column_type: string): ColumnInfo => ({
  name,
  column_type,
  physical_type: column_type,
});

const columns = [
  column('id', 'INT64'),
  column('price', 'DECIMAL(20,4)'),
  column('flag', 'BOOLEAN'),
  column('name', 'STRING'),
  column('d', 'DATE'),
  column('ts', 'TIMESTAMP(MICROS(MicroSeconds), UTC:false)'),
  column('MixedCase', 'INT64'),
  column("od'd", 'STRING'),
];

const row = (column: string, operator: string, value: string): FilterRow =>
  ({ id: 1, column, operator, value });

describe('buildFilterExpression', () => {
  it('leaves numeric and boolean literals bare', () => {
    expect(buildFilterExpression([row('id', '>', ' 5 ')], columns)).toBe('"id" > 5');
    expect(buildFilterExpression([row('price', '<=', '1.25')], columns)).toBe('"price" <= 1.25');
    expect(buildFilterExpression([row('flag', '=', 'true')], columns)).toBe('"flag" = true');
  });

  it('quotes date and timestamp values so DataFusion can coerce them', () => {
    expect(buildFilterExpression([row('d', '=', '2022-01-08')], columns)).toBe("\"d\" = '2022-01-08'");
    expect(buildFilterExpression([row('ts', '>=', '2023-11-14 22:13:20')], columns))
      .toBe("\"ts\" >= '2023-11-14 22:13:20'");
  });

  it('trims non-text values but keeps text values verbatim', () => {
    expect(buildFilterExpression([row('d', '=', '2022-01-08 ')], columns)).toBe("\"d\" = '2022-01-08'");
    expect(buildFilterExpression([row('ts', '<', ' 2023-11-14 22:13:20 ')], columns))
      .toBe("\"ts\" < '2023-11-14 22:13:20'");
    expect(buildFilterExpression([row('name', '=', 'x ')], columns)).toBe("\"name\" = 'x '");
  });

  it('quotes a value that does not parse as its numeric column type', () => {
    expect(buildFilterExpression([row('id', '=', 'abc')], columns)).toBe("\"id\" = 'abc'");
  });

  it('quotes identifiers, which DataFusion would otherwise lower-case', () => {
    expect(buildFilterExpression([row('MixedCase', '=', '7')], columns)).toBe('"MixedCase" = 7');
  });

  it('escapes quotes in identifiers and values', () => {
    expect(buildFilterExpression([row("od'd", '=', "it's")], columns)).toBe(`"od'd" = 'it''s'`);
  });

  it('casts non-text columns for LIKE', () => {
    expect(buildFilterExpression([row('id', 'LIKE', '%23%')], columns))
      .toBe(`CAST("id" AS TEXT) LIKE '%23%'`);
    expect(buildFilterExpression([row('name', 'LIKE', '%ab%')], columns))
      .toBe(`"name" LIKE '%ab%'`);
  });

  it('takes no value for the null operators', () => {
    expect(buildFilterExpression([row('name', 'IS NULL', '')], columns)).toBe('"name" IS NULL');
    expect(buildFilterExpression([row('name', 'IS NOT NULL', '')], columns)).toBe('"name" IS NOT NULL');
  });

  it('skips incomplete rows and joins the rest with AND', () => {
    const rows = [row('id', '>', '5'), row('name', '=', '   '), { ...row('d', '=', '2022-01-08'), id: 3 }];
    expect(buildFilterExpression(rows, columns)).toBe(`"id" > 5 AND "d" = '2022-01-08'`);
  });

  it('is empty when nothing is filled in', () => {
    expect(buildFilterExpression([row('id', '=', '')], columns)).toBe('');
  });
});
