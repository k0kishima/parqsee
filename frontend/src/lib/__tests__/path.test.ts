import { describe, it, expect } from 'vitest';
import parquetExtensionCases from '../../../../contracts/parquet-extension-cases.json';
import { ancestorsWithin, dirname, getFileName, isParquetPath, isWithin, stripParquetExtension } from '../path';

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

describe('dirname', () => {
  it('drops the last segment', () => {
    expect(dirname('/data/reports/sales.parquet')).toBe('/data/reports');
  });

  it('keeps the root for a top-level path and is empty without a separator', () => {
    expect(dirname('/sales.parquet')).toBe('/');
    expect(dirname('sales.parquet')).toBe('');
  });
});

describe('isWithin', () => {
  it('accepts the root itself and anything below it', () => {
    expect(isWithin('/data', '/data')).toBe(true);
    expect(isWithin('/data', '/data/a/b.parquet')).toBe(true);
    expect(isWithin('/data/', '/data/a.parquet')).toBe(true);
  });

  it('rejects siblings that merely share a prefix', () => {
    expect(isWithin('/data', '/database/a.parquet')).toBe(false);
    expect(isWithin('/data', '/other/data/a.parquet')).toBe(false);
  });
});

describe('ancestorsWithin', () => {
  it('lists the folders from the root down to the directory', () => {
    expect(ancestorsWithin('/r', '/r/a/b')).toEqual(['/r', '/r/a', '/r/a/b']);
    expect(ancestorsWithin('/r', '/r')).toEqual(['/r']);
  });

  it('is empty for a directory outside the root', () => {
    expect(ancestorsWithin('/r', '/elsewhere')).toEqual([]);
  });
});
