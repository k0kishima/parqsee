import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { WorkspaceProvider, useWorkspace } from '../WorkspaceContext';
import { RecentFilesProvider } from '../RecentFilesContext';
import { evictCache } from '../../features/file-viewer/api';

vi.mock('../../lib/tauri', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('../../features/file-viewer/api', () => ({
  checkFileExists: vi.fn(async () => true),
  openParquetFile: vi.fn(async () => ({ num_rows: 1, num_columns: 1, columns: [] })),
  getFileInfo: vi.fn(async (path: string) => ({ path, name: path.split('/').pop(), size: 1 })),
  evictCache: vi.fn(async () => undefined),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <RecentFilesProvider>
    <WorkspaceProvider>{children}</WorkspaceProvider>
  </RecentFilesProvider>
);

function renderWorkspace() {
  return renderHook(() => useWorkspace(), { wrapper });
}

describe('WorkspaceProvider tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(evictCache).mockClear();
  });

  it('opens a tab per file and activates the last one', async () => {
    const { result } = renderWorkspace();
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    await act(() => result.current.openParquetFile('/data/b.parquet'));

    expect(result.current.tabs.map(t => t.path)).toEqual(['/data/a.parquet', '/data/b.parquet']);
    expect(result.current.activeTab?.path).toBe('/data/b.parquet');
    expect(result.current.currentFile).toBe('/data/b.parquet');
  });

  it('re-activates the existing tab when the same file is opened again', async () => {
    const { result } = renderWorkspace();
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    await act(() => result.current.openParquetFile('/data/b.parquet'));
    await act(() => result.current.openParquetFile('/data/a.parquet'));

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeTab?.path).toBe('/data/a.parquet');
  });

  it('keeps the tabs added by files opened back to back in one tick', async () => {
    const { result } = renderWorkspace();
    // A multi-file drop opens the files one after another without a render
    // in between.
    await act(async () => {
      await result.current.openParquetFile('/data/a.parquet');
      await result.current.openParquetFile('/data/b.parquet');
      await result.current.openParquetFile('/data/c.parquet');
    });

    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'c.parquet']);
  });

  it('closing a tab through a stale closeTab keeps the other tabs\' state', async () => {
    const { result } = renderWorkspace();
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    await act(() => result.current.openParquetFile('/data/b.parquet'));
    const [a, b] = result.current.tabs;

    // TabBar is memoized on the tab list only, so it keeps calling the
    // closeTab it was handed before any tab state changed.
    const closeTabAsTabBarSawIt = result.current.closeTab;
    act(() => result.current.setTabState(a.id, { viewMode: 'query', currentPage: 3 }));
    act(() => closeTabAsTabBarSawIt(b.id));

    expect(result.current.tabs.map(t => t.id)).toEqual([a.id]);
    expect(result.current.tabStates[a.id]).toMatchObject({ viewMode: 'query', currentPage: 3 });
    expect(result.current.tabStates[b.id]).toBeUndefined();
  });

  it('merges tab state patches from different writers', async () => {
    const { result } = renderWorkspace();
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    const [a] = result.current.tabs;

    // The tab owns viewMode, the grid owns the page: neither may erase the other.
    act(() => result.current.setTabState(a.id, { viewMode: 'query' }));
    act(() => result.current.setTabState(a.id, { currentPage: 2 }));

    expect(result.current.tabStates[a.id]).toEqual({ viewMode: 'query', currentPage: 2 });
  });

  it('activates the neighbour when the active tab is closed', async () => {
    const { result } = renderWorkspace();
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    await act(() => result.current.openParquetFile('/data/b.parquet'));
    await act(() => result.current.openParquetFile('/data/c.parquet'));
    const [, b, c] = result.current.tabs;

    act(() => result.current.closeTab(c.id));
    expect(result.current.activeTab?.id).toBe(b.id);
    expect(result.current.currentFile).toBe('/data/b.parquet');

    act(() => result.current.closeTab(b.id));
    expect(result.current.activeTab?.path).toBe('/data/a.parquet');
  });

  it('evicts the backend cache only when no other tab shows the file', async () => {
    const { result } = renderWorkspace();
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    await act(() => result.current.openParquetFile('/data/b.parquet'));
    const [a, b] = result.current.tabs;

    act(() => result.current.closeTab(b.id));
    expect(evictCache).toHaveBeenCalledWith('/data/b.parquet');

    vi.mocked(evictCache).mockClear();
    act(() => result.current.closeTab(a.id));
    expect(evictCache).toHaveBeenCalledWith('/data/a.parquet');
    expect(result.current.tabs).toHaveLength(0);
    expect(result.current.currentFile).toBeNull();
  });
});
