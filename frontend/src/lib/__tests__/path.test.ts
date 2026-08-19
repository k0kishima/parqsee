import { describe, it, expect } from 'vitest';
import { getFileName, isParquetPath, stripParquetExtension } from '../path';

describe('getFileName', () => {
  it('takes the last posix segment', () => {
    expect(getFileName('/data/reports/sales.parquet')).toBe('sales.parquet');
  });

  it('returns the input when there is no separator', () => {
    expect(getFileName('sales.parquet')).toBe('sales.parquet');
  });
});

describe('isParquetPath', () => {
  it('matches the extension regardless of case', () => {
    expect(isParquetPath('/data/sales.parquet')).toBe(true);
    expect(isParquetPath('/data/Report.PARQUET')).toBe(true);
    expect(isParquetPath('/data/Report.Parquet')).toBe(true);
  });

  it('rejects other extensions', () => {
    expect(isParquetPath('/data/readme.txt')).toBe(false);
    expect(isParquetPath('/data/parquet')).toBe(false);
    expect(isParquetPath('/data/sales.parquet.bak')).toBe(false);
  });
});

describe('stripParquetExtension', () => {
  it('drops the extension regardless of case', () => {
    expect(stripParquetExtension('sales.parquet')).toBe('sales');
    expect(stripParquetExtension('Report.PARQUET')).toBe('Report');
  });

  it('leaves other names untouched', () => {
    expect(stripParquetExtension('readme.txt')).toBe('readme.txt');
  });
});
