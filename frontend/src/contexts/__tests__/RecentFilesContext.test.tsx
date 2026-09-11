import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { RecentFilesProvider, useRecentFiles } from '../RecentFilesContext';
import { listen } from '@tauri-apps/api/event';
import { listRecentFiles } from '../../features/welcome/api';

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
    vi.mocked(listRecentFiles).mockResolvedValue([file('a.parquet'), file('b.parquet')]);
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
});
