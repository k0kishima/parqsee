import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { WorkspaceProvider, useWorkspace } from '../WorkspaceContext';
import { RecentFilesProvider } from '../RecentFilesContext';
import { SettingsProvider } from '../SettingsContext';
import { evictCacheQuietly, openParquetFile } from '../../features/file-viewer/api';
import { open } from '@tauri-apps/plugin-dialog';
import { addWorkspaceRoot, listWorkspaceRoots, removeWorkspaceRoot, listSessionTabs, saveSession } from '../../features/workspace/api';
import type { SessionTab } from '../../features/workspace/api';
import { rememberFile, removeRecentFile } from '../../features/welcome/api';
import { checkFileExists } from '../../features/file-viewer/api';
import { useRecentFiles } from '../RecentFilesContext';
import { saveSettings, defaultSettings } from '../../lib/settings-storage';

vi.mock('../../lib/tauri', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('../../features/workspace/api', () => ({
  listWorkspaceRoots: vi.fn(async () => []),
  addWorkspaceRoot: vi.fn(async (path: string) => ({ path, name: path.split('/').pop() })),
  removeWorkspaceRoot: vi.fn(async () => undefined),
  listSessionTabs: vi.fn(async () => ({ tabs: [], active: null })),
  saveSession: vi.fn(async () => undefined),
}));
// SettingsProvider syncs the language into i18n, which the global setup does not provide.
vi.mock('../../lib/i18n', () => ({ default: { language: 'en', changeLanguage: vi.fn() } }));
// SettingsProvider follows the system theme through matchMedia, which jsdom lacks.
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));
vi.mock('../../features/file-viewer/api', () => ({
  checkFileExists: vi.fn(async () => true),
  openParquetFile: vi.fn(async () => ({ num_rows: 1, num_columns: 1, columns: [] })),
  evictCacheQuietly: vi.fn(async () => undefined),
}));
vi.mock('../../features/welcome/api', () => ({
  listRecentFiles: vi.fn(async () => []),
  rememberFile: vi.fn(async (path: string) => ({ path, name: path.split('/').pop(), size: 1, last_accessed: 0, available: true })),
  removeRecentFile: vi.fn(async () => undefined),
  clearRecentFiles: vi.fn(async () => undefined),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <SettingsProvider>
    <RecentFilesProvider>
      <WorkspaceProvider>{children}</WorkspaceProvider>
    </RecentFilesProvider>
  </SettingsProvider>
);

function renderWorkspace() {
  return renderHook(() => useWorkspace(), { wrapper });
}

/** A workspace with one tab open per path, opened in order. */
async function openTabs(...paths: string[]) {
  const { result } = renderWorkspace();
  for (const path of paths) {
    await act(() => result.current.openParquetFile(path));
  }
  return result;
}

describe('WorkspaceProvider tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(evictCacheQuietly).mockClear();
  });

  it('opens a tab per file and activates the last one', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet');

    expect(result.current.tabs.map(t => t.path)).toEqual(['/data/a.parquet', '/data/b.parquet']);
    expect(result.current.activeTab?.path).toBe('/data/b.parquet');
    expect(result.current.currentFile).toBe('/data/b.parquet');
  });

  it('re-activates the existing tab when the same file is opened again', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet', '/data/a.parquet');

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
    const result = await openTabs('/data/a.parquet', '/data/b.parquet');
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
    const result = await openTabs('/data/a.parquet');
    const [a] = result.current.tabs;

    // The tab owns viewMode, the grid owns the page: neither may erase the other.
    act(() => result.current.setTabState(a.id, { viewMode: 'query' }));
    act(() => result.current.setTabState(a.id, { currentPage: 2 }));

    expect(result.current.tabStates[a.id]).toEqual({ viewMode: 'query', currentPage: 2 });
  });

  it('activates the neighbour when the active tab is closed', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet', '/data/c.parquet');
    const [, b, c] = result.current.tabs;

    act(() => result.current.closeTab(c.id));
    expect(result.current.activeTab?.id).toBe(b.id);
    expect(result.current.currentFile).toBe('/data/b.parquet');

    act(() => result.current.closeTab(b.id));
    expect(result.current.activeTab?.path).toBe('/data/a.parquet');
  });

  it('evicts the backend cache only when no other tab shows the file', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet');
    const [a, b] = result.current.tabs;

    act(() => result.current.closeTab(b.id));
    expect(evictCacheQuietly).toHaveBeenCalledWith('/data/b.parquet');

    vi.mocked(evictCacheQuietly).mockClear();
    act(() => result.current.closeTab(a.id));
    expect(evictCacheQuietly).toHaveBeenCalledWith('/data/a.parquet');
    expect(result.current.tabs).toHaveLength(0);
    expect(result.current.currentFile).toBeNull();
  });
});

describe('WorkspaceProvider workspace roots', () => {
  beforeEach(() => {
    vi.mocked(listWorkspaceRoots).mockClear();
    vi.mocked(addWorkspaceRoot).mockClear();
    vi.mocked(removeWorkspaceRoot).mockClear();
    vi.mocked(open).mockReset();
  });

  it('restores the roots the backend kept from the last session', async () => {
    vi.mocked(listWorkspaceRoots).mockResolvedValueOnce([{ path: '/data', name: 'data' }]);
    const { result } = renderWorkspace();

    await waitFor(() => expect(result.current.roots).toEqual([{ path: '/data', name: 'data' }]));
  });

  it('adds the folder picked in the dialog as a root', async () => {
    vi.mocked(open).mockResolvedValueOnce('/Users/me/data');
    const { result } = renderWorkspace();

    await act(() => result.current.openFolderDialog());

    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect(addWorkspaceRoot).toHaveBeenCalledWith('/Users/me/data');
    expect(result.current.roots).toEqual([{ path: '/Users/me/data', name: 'data' }]);
  });

  it('adds nothing when the dialog is cancelled', async () => {
    vi.mocked(open).mockResolvedValueOnce(null);
    const { result } = renderWorkspace();

    await act(() => result.current.openFolderDialog());

    expect(addWorkspaceRoot).not.toHaveBeenCalled();
    expect(result.current.roots).toEqual([]);
  });

  it('removes a root locally and in the backend', async () => {
    vi.mocked(listWorkspaceRoots).mockResolvedValueOnce([{ path: '/data', name: 'data' }, { path: '/more', name: 'more' }]);
    const { result } = renderWorkspace();
    await waitFor(() => expect(result.current.roots).toHaveLength(2));

    act(() => result.current.removeWorkspaceRoot('/data'));

    expect(result.current.roots).toEqual([{ path: '/more', name: 'more' }]);
    expect(removeWorkspaceRoot).toHaveBeenCalledWith('/data');
  });
});

describe('WorkspaceProvider recent files', () => {
  beforeEach(() => {
    vi.mocked(rememberFile).mockClear();
    vi.mocked(removeRecentFile).mockClear();
    vi.mocked(checkFileExists).mockClear();
  });

  function renderBoth() {
    return renderHook(() => ({ workspace: useWorkspace(), recent: useRecentFiles() }), { wrapper });
  }

  it('records an opened file in the backend and shows it first in the list', async () => {
    const { result } = renderBoth();

    await act(() => result.current.workspace.openParquetFile('/data/a.parquet'));
    await act(() => result.current.workspace.openParquetFile('/data/b.parquet'));

    expect(rememberFile).toHaveBeenCalledWith('/data/a.parquet');
    expect(result.current.recent.recentFiles.map(f => f.path)).toEqual(['/data/b.parquet', '/data/a.parquet']);
    expect(result.current.workspace.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet']);
  });

  it('still opens the tab when the file could not be recorded', async () => {
    vi.mocked(rememberFile).mockRejectedValueOnce('disk full');
    const { result } = renderBoth();

    await act(() => result.current.workspace.openParquetFile('/data/a.parquet'));

    expect(result.current.workspace.tabs.map(t => t.name)).toEqual(['a.parquet']);
    expect(result.current.recent.recentFiles).toEqual([]);
  });

  it('drops a file that no longer exists from the list instead of opening it', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { result } = renderBoth();
    await act(() => result.current.workspace.openParquetFile('/data/a.parquet'));

    vi.mocked(checkFileExists).mockResolvedValueOnce(false);
    await act(() => result.current.workspace.openParquetFile('/data/a.parquet'));

    expect(removeRecentFile).toHaveBeenCalledWith('/data/a.parquet');
    expect(result.current.recent.recentFiles).toEqual([]);
    expect(window.alert).toHaveBeenCalledWith('File not found: /data/a.parquet');
  });
});

describe('WorkspaceProvider session', () => {
  const sessionTab = (path: string, state: Partial<SessionTab['state']> = {}, available = true): SessionTab => ({
    path,
    name: path.split('/').pop()!,
    state: { view_mode: null, current_page: null, active_filter: null, ...state },
    available,
  });

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.mocked(listSessionTabs).mockReset().mockResolvedValue({ tabs: [], active: null });
    vi.mocked(saveSession).mockClear();
    vi.mocked(openParquetFile).mockClear();
    vi.mocked(rememberFile).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let the restore's awaits settle and the save delay elapse. */
  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }

  it('reopens the tabs of the last session in order, with their state and the active one', async () => {
    vi.mocked(listSessionTabs).mockResolvedValue({
      tabs: [
        sessionTab('/data/a.parquet', { view_mode: 'query' }),
        sessionTab('/data/b.parquet', { current_page: 3, active_filter: 'x > 1' }),
      ],
      active: '/data/b.parquet',
    });
    const { result } = renderWorkspace();
    await settle();

    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet']);
    expect(result.current.activeTab?.path).toBe('/data/b.parquet');
    const [a, b] = result.current.tabs;
    expect(result.current.tabStates[a.id]).toEqual({ viewMode: 'query' });
    expect(result.current.tabStates[b.id]).toEqual({ currentPage: 3, activeFilter: 'x > 1' });
    // Opened like a manual open, but not recorded: Recent Files keeps its order.
    expect(openParquetFile).toHaveBeenCalledTimes(2);
    expect(rememberFile).not.toHaveBeenCalled();
    expect(result.current.restoreNotice).toBeNull();
  });

  it('skips the files that are gone or fail to open and names them in the notice', async () => {
    vi.mocked(listSessionTabs).mockResolvedValue({
      tabs: [
        sessionTab('/data/gone.parquet', {}, false),
        sessionTab('/data/ok.parquet'),
        sessionTab('/data/broken.parquet'),
      ],
      active: '/data/gone.parquet',
    });
    vi.mocked(openParquetFile).mockImplementation(async (path: string) => {
      if (path.endsWith('broken.parquet')) throw new Error('not a parquet file');
      return { num_rows: 1, num_columns: 1, columns: [] };
    });
    const { result } = renderWorkspace();
    await settle();

    expect(result.current.tabs.map(t => t.name)).toEqual(['ok.parquet']);
    expect(result.current.activeTab?.path).toBe('/data/ok.parquet');
    expect(openParquetFile).not.toHaveBeenCalledWith('/data/gone.parquet');
    expect(result.current.restoreNotice).toEqual({ skipped: ['/data/gone.parquet', '/data/broken.parquet'] });
    // The first save after the restore writes the pruned session.
    await settle();
    expect(saveSession).toHaveBeenLastCalledWith(
      [{ path: '/data/ok.parquet', state: { view_mode: null, current_page: null, active_filter: null } }],
      '/data/ok.parquet',
    );

    act(() => result.current.dismissRestoreNotice());
    expect(result.current.restoreNotice).toBeNull();
    vi.mocked(openParquetFile).mockReset().mockResolvedValue({ num_rows: 1, num_columns: 1, columns: [] });
  });

  it('saves the session after each change worth keeping, not before the restore is done', async () => {
    let finishRestore!: (value: { tabs: SessionTab[]; active: string | null }) => void;
    vi.mocked(listSessionTabs).mockReturnValue(new Promise(resolve => { finishRestore = resolve; }));
    const { result } = renderWorkspace();
    await settle();
    expect(saveSession).not.toHaveBeenCalled();

    await act(async () => { finishRestore({ tabs: [], active: null }); });
    await settle();
    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(saveSession).toHaveBeenLastCalledWith([], null);

    await act(() => result.current.openParquetFile('/data/a.parquet'));
    await act(() => result.current.openParquetFile('/data/b.parquet'));
    const [a, b] = result.current.tabs;
    act(() => result.current.setTabState(a.id, { viewMode: 'query' }));
    act(() => result.current.setTabState(b.id, { currentPage: 2 }));
    act(() => result.current.setTabState(b.id, { currentPage: 3 }));
    await settle();
    // One write for the burst, describing the latest state.
    expect(saveSession).toHaveBeenCalledTimes(2);
    expect(saveSession).toHaveBeenLastCalledWith(
      [
        { path: '/data/a.parquet', state: { view_mode: 'query', current_page: null, active_filter: null } },
        { path: '/data/b.parquet', state: { view_mode: null, current_page: 3, active_filter: null } },
      ],
      '/data/b.parquet',
    );

    // Transient state is not persisted, so it does not trigger a write.
    act(() => result.current.setTabState(b.id, { searchTerm: 'x', selectedRow: 2 }));
    await settle();
    expect(saveSession).toHaveBeenCalledTimes(2);

    act(() => result.current.closeTab(b.id));
    await settle();
    expect(saveSession).toHaveBeenCalledTimes(3);
    expect(saveSession).toHaveBeenLastCalledWith(
      [{ path: '/data/a.parquet', state: { view_mode: 'query', current_page: null, active_filter: null } }],
      '/data/a.parquet',
    );
  });

  it('writes a pending change at once when the page is hidden', async () => {
    const { result } = renderWorkspace();
    await settle();
    vi.mocked(saveSession).mockClear();

    await act(() => result.current.openParquetFile('/data/a.parquet'));
    expect(saveSession).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(saveSession).toHaveBeenCalledTimes(1);
    await settle();
    expect(saveSession).toHaveBeenCalledTimes(1);
  });

  it('does not restore when the setting is off, and still saves from then on', async () => {
    saveSettings({ ...defaultSettings, restoreTabs: false });
    vi.mocked(listSessionTabs).mockResolvedValue({ tabs: [sessionTab('/data/a.parquet')], active: '/data/a.parquet' });
    const { result } = renderWorkspace();
    await settle();

    expect(listSessionTabs).not.toHaveBeenCalled();
    expect(result.current.tabs).toEqual([]);
    await act(() => result.current.openParquetFile('/data/b.parquet'));
    await settle();
    expect(saveSession).toHaveBeenLastCalledWith(
      [{ path: '/data/b.parquet', state: { view_mode: null, current_page: null, active_filter: null } }],
      '/data/b.parquet',
    );
  });
});
