import { describe, expect, it } from 'vitest';
import { buildFilterExpression, findInvalidFilterValue, FilterOperator, FilterRow } from '../filter-bar';
import type { ColumnInfo, ColumnKind } from '../../api';

const column = (name: string, column_type: string, kind: ColumnKind): ColumnInfo => ({
  name,
  column_type,
  kind,
  logical_type: null,
  physical_type: column_type,
});

const columns = [
  column('id', 'INT64', 'integer'),
  column('price', 'DECIMAL(20,4)', 'decimal'),
  column('flag', 'BOOLEAN', 'boolean'),
  column('name', 'STRING', 'text'),
  column('d', 'DATE', 'temporal'),
  column('ts', 'TIMESTAMP(MICROS(MicroSeconds), UTC:false)', 'temporal'),
  column('MixedCase', 'INT64', 'integer'),
  column("od'd", 'STRING', 'text'),
  column('blob', 'BYTE_ARRAY', 'binary'),
  column('ratio', 'DOUBLE', 'float'),
  column('tags', 'LIST<STRING>', 'nested'),
  column('mystery', 'UNKNOWN', 'other'),
];

const row = (column: string, operator: FilterOperator, value: string): FilterRow =>
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

  it('compares binary columns by the hex the grid shows', () => {
    expect(buildFilterExpression([row('blob', '=', '0001FF ')], columns))
      .toBe(`encode(CAST("blob" AS BYTEA), 'hex') = '0001ff'`);
    expect(buildFilterExpression([row('blob', 'LIKE', '%ff%')], columns))
      .toBe(`encode(CAST("blob" AS BYTEA), 'hex') LIKE '%ff%'`);
    expect(buildFilterExpression([row('blob', 'IS NULL', '')], columns))
      .toBe(`encode(CAST("blob" AS BYTEA), 'hex') IS NULL`);
  });
});

describe('buildFilterExpression for the remaining kinds', () => {
  it('treats floats like the other numeric kinds', () => {
    expect(buildFilterExpression([row('ratio', '>', ' 0.5 ')], columns)).toBe('"ratio" > 0.5');
    expect(buildFilterExpression([row('ratio', '=', 'abc')], columns)).toBe('"ratio" = \'abc\'');
  });

  it('quotes nested and unknown kinds trimmed, and casts them for LIKE', () => {
    expect(buildFilterExpression([row('tags', '=', ' a ')], columns)).toBe('"tags" = \'a\'');
    expect(buildFilterExpression([row('mystery', 'LIKE', '%x%')], columns)).toBe('CAST("mystery" AS TEXT) LIKE \'%x%\'');
  });
});

describe('findInvalidFilterValue', () => {
  it('checks floats but not nested or unknown kinds', () => {
    expect(findInvalidFilterValue([row('ratio', '=', 'abc')], columns))
      .toEqual({ column: 'ratio', value: 'abc', expects: 'number' });
    expect(findInvalidFilterValue([row('tags', '=', 'abc')], columns)).toBeNull();
    expect(findInvalidFilterValue([row('mystery', '=', 'abc')], columns)).toBeNull();
  });

  it('rejects values a numeric or boolean column can never hold', () => {
    expect(findInvalidFilterValue([row('id', '=', 'abc')], columns))
      .toEqual({ column: 'id', value: 'abc', expects: 'number' });
    expect(findInvalidFilterValue([row('flag', '=', 'yes')], columns))
      .toEqual({ column: 'flag', value: 'yes', expects: 'boolean' });
  });

  it('accepts parseable values, text, LIKE and null checks', () => {
    expect(findInvalidFilterValue([row('id', '=', ' 1e3 ')], columns)).toBeNull();
    expect(findInvalidFilterValue([row('price', '>', '-0.5')], columns)).toBeNull();
    expect(findInvalidFilterValue([row('flag', '=', 'TRUE')], columns)).toBeNull();
    expect(findInvalidFilterValue([row('name', '=', 'abc')], columns)).toBeNull();
    expect(findInvalidFilterValue([row('id', 'LIKE', 'abc')], columns)).toBeNull();
    expect(findInvalidFilterValue([row('id', 'IS NULL', 'abc')], columns)).toBeNull();
    expect(findInvalidFilterValue([row('id', '=', '')], columns)).toBeNull();
  });
});
