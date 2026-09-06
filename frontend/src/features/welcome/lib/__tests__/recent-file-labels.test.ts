import { describe, it, expect } from 'vitest';
import { recentFileLabels, matchesRecentFile } from '../recent-file-labels';

const file = (path: string) => ({ path, name: path.split('/').pop()! });

describe('recentFileLabels', () => {
  it('leaves a unique name alone', () => {
    const labels = recentFileLabels([file('/data/a.parquet'), file('/data/b.parquet')]);
    expect(labels.get('/data/a.parquet')).toEqual({ name: 'a.parquet', folder: null });
    expect(labels.get('/data/b.parquet')).toEqual({ name: 'b.parquet', folder: null });
  });

  it('adds the parent folder to every entry sharing a name, and only to those', () => {
    const labels = recentFileLabels([
      file('/exports/2024q1/data.parquet'),
      file('/exports/2024q2/data.parquet'),
      file('/exports/2024q2/other.parquet'),
    ]);
    expect(labels.get('/exports/2024q1/data.parquet')).toEqual({ name: 'data.parquet', folder: '2024q1' });
    expect(labels.get('/exports/2024q2/data.parquet')).toEqual({ name: 'data.parquet', folder: '2024q2' });
    expect(labels.get('/exports/2024q2/other.parquet')).toEqual({ name: 'other.parquet', folder: null });
  });

  it('names the filesystem root for a file directly under it', () => {
    const labels = recentFileLabels([file('/data.parquet'), file('/tmp/data.parquet')]);
    expect(labels.get('/data.parquet')?.folder).toBe('/');
    expect(labels.get('/tmp/data.parquet')?.folder).toBe('tmp');
  });
});

describe('matchesRecentFile', () => {
  const f = file('/Users/me/Reports/Sales.parquet');

  it('matches the name or the path, ignoring case and surrounding spaces', () => {
    expect(matchesRecentFile(f, 'sales')).toBe(true);
    expect(matchesRecentFile(f, '  REPORTS ')).toBe(true);
    expect(matchesRecentFile(f, 'me/rep')).toBe(true);
    expect(matchesRecentFile(f, 'invoice')).toBe(false);
  });

  it('matches everything on an empty query', () => {
    expect(matchesRecentFile(f, '')).toBe(true);
    expect(matchesRecentFile(f, '   ')).toBe(true);
  });
});
