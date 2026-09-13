import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { RecentFilesProvider, useRecentFiles } from '../RecentFilesContext';
import { listen } from '@tauri-apps/api/event';
import {
  RecentFile,
  listRecentFiles,
  removeRecentFile,
  clearRecentFiles,
} from '../../features/welcome/api';

vi.mock('../../lib/tauri', () => ({ isTauri: () => true }));
vi.mock('../../features/welcome/api', () => ({
  listRecentFiles: vi.fn(async () => []),
  removeRecentFile: vi.fn(async () => undefined),
  clearRecentFiles: vi.fn(async () => undefined),
}));

const file = (name: string) => ({ path: `/data/${name}`, name, size: 1, last_accessed: 0, available: true });
const wrapper = ({ children }: { children: ReactNode }) => <RecentFilesProvider>{children}</RecentFilesProvider>;

describe('RecentFilesProvider', () => {
  beforeEach(() => {
    vi.mocked(listen).mockClear();
    vi.mocked(listRecentFiles).mockReset().mockResolvedValue([file('a.parquet'), file('b.parquet')]);
    vi.mocked(removeRecentFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(clearRecentFiles).mockReset().mockResolvedValue(undefined);
  });

  it('empties the mirror when the native Clear Menu says the store was cleared', async () => {
    const { result } = renderHook(() => useRecentFiles(), { wrapper });
    await waitFor(() => expect(result.current.recentFiles).toHaveLength(2));

    const cleared = vi.mocked(listen).mock.calls.find(([name]) => name === 'recent-files-cleared');
    expect(cleared).toBeDefined();
    act(() => {
      (cleared![1] as (event: unknown) => void)({ event: 'recent-files-cleared', id: 1, payload: null });
    });

    expect(result.current.recentFiles).toEqual([]);
  });

  it('keeps the whole list the backend reports, however long', async () => {
    vi.mocked(listRecentFiles).mockResolvedValue(Array.from({ length: 20 }, (_, i) => file(`f${i}.parquet`)));
    const { result } = renderHook(() => useRecentFiles(), { wrapper });
    await waitFor(() => expect(result.current.recentFiles).toHaveLength(20));

    act(() => result.current.upsertRecentFile(file('new.parquet')));
    expect(result.current.recentFiles).toHaveLength(21);
    expect(result.current.recentFiles[0].name).toBe('new.parquet');
  });

  // The first listing is a snapshot of the store from when it was asked
  // for. Anything the session did in the meantime is newer, so the snapshot
  // is dropped and the authoritative list asked for again — merging the two
  // would resurrect what a clear or a remove took out (CT-05).
  describe('while the first listing is in flight', () => {
    /** Holds the first listing open; the call returns its `resolve`. */
    const pendingListing = () => {
      let finish!: (files: RecentFile[]) => void;
      vi.mocked(listRecentFiles).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      return (files: RecentFile[]) => act(async () => finish(files));
    };

    it('keeps a file opened in the meantime, and takes the fresh listing', async () => {
      const finish = pendingListing();
      vi.mocked(listRecentFiles).mockResolvedValue([file('new.parquet'), file('old.parquet')]);
      const { result } = renderHook(() => useRecentFiles(), { wrapper });

      act(() => result.current.upsertRecentFile(file('new.parquet')));
      await finish([file('old.parquet')]);

      await waitFor(() =>
        expect(result.current.recentFiles.map(f => f.name)).toEqual(['new.parquet', 'old.parquet']),
      );
    });

    it('does not bring back the entries Clear all removed', async () => {
      const finish = pendingListing();
      vi.mocked(listRecentFiles).mockResolvedValue([]);
      let stored!: () => void;
      vi.mocked(clearRecentFiles).mockReturnValueOnce(new Promise<void>(resolve => { stored = resolve; }));
      const { result } = renderHook(() => useRecentFiles(), { wrapper });

      act(() => result.current.clearRecentFiles());
      await finish([file('a.parquet'), file('b.parquet')]);
      expect(result.current.recentFiles).toEqual([]);

      // The re-listing waits for the clear to reach the store: asked for any
      // earlier it would read the two files as still recorded.
      expect(vi.mocked(listRecentFiles)).toHaveBeenCalledTimes(1);
      await act(async () => stored());

      await waitFor(() => expect(vi.mocked(listRecentFiles)).toHaveBeenCalledTimes(2));
      expect(result.current.recentFiles).toEqual([]);
    });

    it('does not bring back an entry Remove took out', async () => {
      const finish = pendingListing();
      vi.mocked(listRecentFiles).mockResolvedValue([file('b.parquet')]);
      let stored!: () => void;
      vi.mocked(removeRecentFile).mockReturnValueOnce(new Promise<void>(resolve => { stored = resolve; }));
      const { result } = renderHook(() => useRecentFiles(), { wrapper });

      act(() => result.current.removeRecentFile('/data/a.parquet'));
      await finish([file('a.parquet'), file('b.parquet')]);
      expect(vi.mocked(listRecentFiles)).toHaveBeenCalledTimes(1);
      await act(async () => stored());

      await waitFor(() => expect(result.current.recentFiles.map(f => f.name)).toEqual(['b.parquet']));
    });

    it('does not undo the native Clear Menu', async () => {
      const finish = pendingListing();
      vi.mocked(listRecentFiles).mockResolvedValue([]);
      const { result } = renderHook(() => useRecentFiles(), { wrapper });

      const cleared = vi.mocked(listen).mock.calls.find(([name]) => name === 'recent-files-cleared');
      act(() => {
        (cleared![1] as (event: unknown) => void)({ event: 'recent-files-cleared', id: 1, payload: null });
      });
      await finish([file('a.parquet')]);

      await waitFor(() => expect(vi.mocked(listRecentFiles)).toHaveBeenCalledTimes(2));
      expect(result.current.recentFiles).toEqual([]);
    });

    it('leaves the list usable when the listing fails', async () => {
      let fail!: (error: unknown) => void;
      vi.mocked(listRecentFiles).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
      const { result } = renderHook(() => useRecentFiles(), { wrapper });
      await act(async () => fail(new Error('no store')));

      act(() => result.current.upsertRecentFile(file('new.parquet')));
      expect(result.current.recentFiles.map(f => f.name)).toEqual(['new.parquet']);
      act(() => result.current.removeRecentFile('/data/new.parquet'));
      expect(result.current.recentFiles).toEqual([]);
      expect(vi.mocked(removeRecentFile)).toHaveBeenCalledWith('/data/new.parquet');
    });
  });
});
