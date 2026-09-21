import { describe, it, expect } from 'vitest';
import { loadFailure, type LoadedState } from '../load-failure';
import type { SortSpec } from '../../api';

const ascending: SortSpec = { column: 'id', direction: 'asc' };

const onScreen = (over: Partial<LoadedState> = {}): LoadedState =>
  ({ page: 2, filter: 'a > 1', sort: null, totalRows: 100, ...over });

describe('loadFailure', () => {
  it('is a file-level error when nothing has ever loaded', () => {
    expect(loadFailure(null, { page: 1, filter: '', sort: null })).toEqual({ kind: 'file' });
  });

  it('retries the plain page when the first load carried a filter', () => {
    expect(loadFailure(null, { page: 1, filter: '"gone" = 1', sort: null })).toEqual({ kind: 'retryPlain' });
  });

  it('retries the plain page when the first load carried a sort', () => {
    expect(loadFailure(null, { page: 1, filter: '', sort: ascending })).toEqual({ kind: 'retryPlain' });
  });

  it('keeps the rows and rewinds the filter that was rejected', () => {
    const result = loadFailure(onScreen(), { page: 2, filter: 'bad(', sort: null });
    expect(result).toEqual({ kind: 'banner', restore: onScreen(), rewinds: true });
  });

  it('rewinds a page too deep to load', () => {
    const result = loadFailure(onScreen(), { page: 900, filter: 'a > 1', sort: null });
    expect(result.kind === 'banner' && result.rewinds).toBe(true);
  });

  it('rewinds a sort the file could not answer', () => {
    const result = loadFailure(onScreen(), { page: 2, filter: 'a > 1', sort: ascending });
    expect(result.kind === 'banner' && result.restore.sort).toBe(null);
  });

  it('does not rewind when the failed request is the one already on screen', () => {
    const result = loadFailure(onScreen(), { page: 2, filter: 'a > 1', sort: null });
    expect(result.kind === 'banner' && result.rewinds).toBe(false);
  });

  it('holds a sort by identity, so the same sort object is no rewind', () => {
    const result = loadFailure(onScreen({ sort: ascending }), { page: 2, filter: 'a > 1', sort: ascending });
    expect(result.kind === 'banner' && result.rewinds).toBe(false);
  });
});
