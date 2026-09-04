import { describe, it, expect } from 'vitest';
import parquetExtensionCases from '../../../../contracts/parquet-extension-cases.json';
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
  it('follows the shared parquet-extension contract', () => {
    for (const testCase of parquetExtensionCases) {
      expect(isParquetPath(testCase.path), testCase.path).toBe(testCase.matches);
    }
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
