import { describe, it, expect } from 'vitest';
import parentFolderCases from '../../../../../../contracts/parent-folder-cases.json';
import { recentFileLabels, matchesRecentFile } from '../recent-file-labels';

const file = (path: string) => ({ path, name: path.split('/').pop()! });

describe('recentFileLabels', () => {
  // The same cases `services::recent_menu` is held to. The two lists
  // disambiguate over different sets — this panel sees every entry, the
  // native menu only the ones it shows — but the folder a disambiguated
  // entry carries has to read the same on both surfaces, and nothing but
  // this checks that.
  it('follows the shared parent-folder contract', () => {
    expect(parentFolderCases.length).toBeGreaterThan(0);
    for (const testCase of parentFolderCases) {
      // Two entries sharing a name is what puts the folder on a label.
      const labels = recentFileLabels([
        { path: testCase.path, name: 'report.parquet' },
        { path: '/elsewhere/report.parquet', name: 'report.parquet' },
      ]);
      expect(labels.get(testCase.path)?.folder, `parent folder of ${testCase.path}`).toBe(testCase.folder);
    }
  });

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
