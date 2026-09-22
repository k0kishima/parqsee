import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { WorkspaceProvider, useWorkspace } from '../WorkspaceContext';
import { RecentFilesProvider } from '../RecentFilesContext';
import { SettingsProvider } from '../SettingsContext';
import { evictCacheQuietly, openParquetFile } from '../../features/file-viewer/api';
import { open } from '@tauri-apps/plugin-dialog';
import { addWorkspaceRoot, listWorkspaceRoots, removeWorkspaceRoot, listSessionTabs, saveSession, takePendingFiles } from '../../features/workspace/api';
import type { SessionTab } from '../../features/workspace/api';
import { rememberFile, removeRecentFile, sampleFilePath } from '../../features/welcome/api';
import { checkFileExists } from '../../features/file-viewer/api';
import { useRecentFiles } from '../RecentFilesContext';
import { saveSettings, defaultSettings } from '../../lib/settings-storage';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useAppCommand } from '../../lib/app-commands';

vi.mock('../../lib/tauri', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('../../features/workspace/api', () => ({
  listWorkspaceRoots: vi.fn(async () => []),
  addWorkspaceRoot: vi.fn(async (path: string) => ({ path, name: path.split('/').pop() })),
  removeWorkspaceRoot: vi.fn(async () => undefined),
  listSessionTabs: vi.fn(async () => ({ tabs: [], active: null })),
  saveSession: vi.fn(async () => undefined),
  takePendingFiles: vi.fn(async () => [] as string[]),
}));
// The free tier's tab limit comes from the license; unlocked (no limit)
// unless a test says otherwise.
const license = vi.hoisted(() => ({ tabLimit: null as number | null, showUpgrade: vi.fn() }));
vi.mock('../LicenseContext', () => ({ useLicense: () => license }));
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
  sampleFilePath: vi.fn(async () => '/Applications/Parqsee.app/Contents/Resources/sample.parquet'),
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

/** A tab as the backend hands the last session back, available unless said otherwise. */
const sessionTab = (path: string, state: Partial<SessionTab['state']> = {}, available = true): SessionTab => ({
  path,
  name: path.split('/').pop()!,
  state: { view_mode: null, current_page: null, active_filter: null, sort: null, ...state },
  available,
});

/** Under fake timers: let the restore's awaits settle and the save delay elapse. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
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

  // A file the app cannot read, asked for twice before the first answer
  // arrives — the explorer opens on a single click, so a double click on a
  // broken file is two requests. The second waits for the first and must
  // not hand its failure on: no caller of openParquetFile catches one.
  it('resolves a second request for a file whose open fails', async () => {
    const alerted = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderWorkspace();
    let fail!: (error: unknown) => void;
    vi.mocked(openParquetFile).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));

    let settled!: Promise<string[]>;
    await act(async () => {
      const requests = [result.current.openParquetFile('/data/a.parquet'), result.current.openParquetFile('/data/a.parquet')];
      // Held from the moment they exist: an unhandled rejection takes the
      // whole run down instead of failing this test.
      settled = Promise.all(requests.map(request => request.then(() => 'resolved', error => `rejected: ${error}`)));
      await Promise.resolve();
    });
    await act(async () => { fail(new Error('corrupt')); });

    expect(await settled).toEqual(['resolved', 'resolved']);
    expect(result.current.tabs).toEqual([]);
    // One failure, reported once by the request that made it.
    expect(alerted).toHaveBeenCalledTimes(1);
    expect(alerted).toHaveBeenCalledWith('Failed to open file: Error: corrupt');
    alerted.mockRestore();
    logged.mockRestore();
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

  it('an abandoned load of a closed tab evicts the cache', async () => {
    const result = await openTabs('/data/a.parquet');
    act(() => result.current.closeTab(result.current.tabs[0].id));
    vi.mocked(evictCacheQuietly).mockClear();

    // The viewer's read landed after the close and re-filled what the
    // close had just evicted.
    act(() => result.current.evictIfClosed('/data/a.parquet'));

    expect(evictCacheQuietly).toHaveBeenCalledWith('/data/a.parquet');
  });

  it('an abandoned load of a file opened again leaves the cache alone', async () => {
    const result = await openTabs('/data/a.parquet');
    act(() => result.current.closeTab(result.current.tabs[0].id));
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    vi.mocked(evictCacheQuietly).mockClear();

    act(() => result.current.evictIfClosed('/data/a.parquet'));

    // The new tab reads the same session; its own close will evict it.
    expect(evictCacheQuietly).not.toHaveBeenCalled();
  });
});

describe('WorkspaceProvider reopening closed tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    license.tabLimit = null;
    vi.mocked(rememberFile).mockClear();
  });

  afterEach(() => {
    license.tabLimit = null;
  });

  it('brings the last closed tab back with the state it was closed on', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet');
    const [, b] = result.current.tabs;
    act(() => result.current.setTabState(b.id, { viewMode: 'query', currentPage: 4, activeFilter: 'x > 1' }));
    act(() => result.current.closeTab(b.id));
    vi.mocked(rememberFile).mockClear();

    expect(result.current.canReopenClosedTab).toBe(true);
    await act(() => result.current.reopenClosedTab());

    const reopened = result.current.tabs[1];
    expect(reopened.path).toBe('/data/b.parquet');
    expect(result.current.activeTab?.path).toBe('/data/b.parquet');
    expect(result.current.tabStates[reopened.id]).toEqual({ viewMode: 'query', currentPage: 4, activeFilter: 'x > 1' });
    // A tab that comes back is not a newly opened file: Recent Files keeps its order.
    expect(vi.mocked(rememberFile)).not.toHaveBeenCalled();
  });

  it('walks back through the closes, newest first, and stops when there are none', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet', '/data/c.parquet');
    const [a, b, c] = result.current.tabs;
    act(() => result.current.closeTab(a.id));
    act(() => result.current.closeTab(c.id));
    act(() => result.current.closeTab(b.id));

    await act(() => result.current.reopenClosedTab());
    await act(() => result.current.reopenClosedTab());
    await act(() => result.current.reopenClosedTab());

    expect(result.current.tabs.map(t => t.path)).toEqual(['/data/b.parquet', '/data/c.parquet', '/data/a.parquet']);
    expect(result.current.canReopenClosedTab).toBe(false);
  });

  it('brings a group closed at once back left to right', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet', '/data/c.parquet');
    const [a, b, c] = result.current.tabs;
    act(() => result.current.closeTabs([a.id, c.id]));

    expect(result.current.tabs.map(t => t.id)).toEqual([b.id]);

    await act(() => result.current.reopenClosedTab());
    await act(() => result.current.reopenClosedTab());

    expect(result.current.tabs.map(t => t.path)).toEqual(['/data/b.parquet', '/data/a.parquet', '/data/c.parquet']);
  });

  it('skips a closed tab whose file is open again', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet');
    const [a, b] = result.current.tabs;
    act(() => result.current.closeTab(a.id));
    act(() => result.current.closeTab(b.id));
    await act(() => result.current.openParquetFile('/data/b.parquet'));

    expect(result.current.canReopenClosedTab).toBe(true);
    await act(() => result.current.reopenClosedTab());

    expect(result.current.tabs.map(t => t.path)).toEqual(['/data/b.parquet', '/data/a.parquet']);
    expect(result.current.canReopenClosedTab).toBe(false);
  });

  it('has nothing to reopen before anything is closed', async () => {
    const result = await openTabs('/data/a.parquet');

    expect(result.current.canReopenClosedTab).toBe(false);
    await act(() => result.current.reopenClosedTab());
    expect(result.current.tabs).toHaveLength(1);
  });

  it('refuses to reopen past the free tier\'s limit, and keeps the tab for when it lifts', async () => {
    license.tabLimit = 2;
    const { result, rerender } = renderWorkspace();
    for (const n of ['a', 'b']) await act(() => result.current.openParquetFile(`/data/${n}.parquet`));
    const [, b] = result.current.tabs;
    act(() => result.current.closeTab(b.id));
    await act(() => result.current.openParquetFile('/data/c.parquet'));
    license.showUpgrade.mockClear();

    await act(() => result.current.reopenClosedTab());

    expect(result.current.tabs.map(t => t.path)).toEqual(['/data/a.parquet', '/data/c.parquet']);
    expect(license.showUpgrade).toHaveBeenCalled();
    // The prompt was the answer to this ⇧⌘T, not the end of the entry.
    expect(result.current.canReopenClosedTab).toBe(true);

    license.tabLimit = null;
    rerender();
    await act(() => result.current.reopenClosedTab());

    expect(result.current.tabs.map(t => t.path)).toEqual(['/data/a.parquet', '/data/c.parquet', '/data/b.parquet']);
    expect(result.current.canReopenClosedTab).toBe(false);
  });

  it('drops a closed tab whose file is gone from the history', async () => {
    const alerted = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const result = await openTabs('/data/a.parquet', '/data/b.parquet', '/data/c.parquet');
    const [, b, c] = result.current.tabs;
    act(() => result.current.closeTab(b.id));
    act(() => result.current.closeTab(c.id));
    vi.mocked(checkFileExists).mockResolvedValueOnce(false);

    await act(() => result.current.reopenClosedTab());

    expect(alerted).toHaveBeenCalledWith('File not found: /data/c.parquet');
    expect(result.current.tabs.map(t => t.path)).toEqual(['/data/a.parquet']);

    // The file is gone for good — Recent Files lost it too — so the next
    // ⇧⌘T is the tab before it rather than the same alert again.
    await act(() => result.current.reopenClosedTab());

    expect(result.current.tabs.map(t => t.path)).toEqual(['/data/a.parquet', '/data/b.parquet']);
    expect(result.current.canReopenClosedTab).toBe(false);
    alerted.mockRestore();
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

  it('reopens the tabs of the last session in order, with their state and the active one', async () => {
    vi.mocked(listSessionTabs).mockResolvedValue({
      tabs: [
        sessionTab('/data/a.parquet', { view_mode: 'query' }),
        sessionTab('/data/b.parquet', { current_page: 3, active_filter: 'x > 1', sort: null }),
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
    expect(result.current.restoreNotice).toEqual({ skipped: ['/data/gone.parquet', '/data/broken.parquet'], capped: [] });
    // The first save after the restore writes the pruned session.
    await settle();
    expect(saveSession).toHaveBeenLastCalledWith(
      [{ path: '/data/ok.parquet', state: { view_mode: null, current_page: null, active_filter: null, sort: null } }],
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
        { path: '/data/a.parquet', state: { view_mode: 'query', current_page: null, active_filter: null, sort: null } },
        { path: '/data/b.parquet', state: { view_mode: null, current_page: 3, active_filter: null, sort: null } },
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
      [{ path: '/data/a.parquet', state: { view_mode: 'query', current_page: null, active_filter: null, sort: null } }],
      '/data/a.parquet',
    );
  });

  it('retries the same failed snapshot on pagehide without an immediate retry loop', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderWorkspace();
    await settle();
    vi.mocked(saveSession).mockClear().mockRejectedValueOnce('save failed');
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    await settle();
    const failed = vi.mocked(saveSession).mock.calls[0];
    expect(result.current.sessionSaveFailed).toBe(true);
    expect(error).toHaveBeenCalledWith('Failed to save the session:', 'save failed');
    await settle();
    expect(saveSession).toHaveBeenCalledTimes(1);
    // A render with only transient changes still represents the failed snapshot.
    act(() => result.current.setTabState(result.current.tabs[0].id, { searchTerm: 'x' }));
    await settle();
    expect(saveSession).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(saveSession).toHaveBeenCalledTimes(2);
    expect(saveSession).toHaveBeenLastCalledWith(...failed);
    expect(result.current.sessionSaveFailed).toBe(false);
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(saveSession).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('retains a repeatedly failed save for explicit retry, then saves a newer state', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderWorkspace();
    await settle();
    vi.mocked(saveSession).mockClear().mockRejectedValueOnce('first').mockRejectedValueOnce('second');
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    await settle();
    await act(async () => { result.current.retrySessionSave(); });
    await settle();
    expect(saveSession).toHaveBeenCalledTimes(2);
    expect(result.current.sessionSaveFailed).toBe(true);
    act(() => result.current.setTabState(result.current.tabs[0].id, { currentPage: 3 }));
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(saveSession).toHaveBeenCalledTimes(3);
    expect(vi.mocked(saveSession).mock.lastCall?.[0][0].state.current_page).toBe(3);
    expect(result.current.sessionSaveFailed).toBe(false);
    error.mockRestore();
  });

  it('persists a return to the last saved state after an in-flight write', async () => {
    const { result } = renderWorkspace();
    await settle();
    let finish!: () => void;
    vi.mocked(saveSession).mockClear().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    await settle();
    act(() => result.current.closeTab(result.current.tabs[0].id));
    await settle();
    await act(async () => { finish(); });
    expect(saveSession).toHaveBeenCalledTimes(2);
    expect(saveSession).toHaveBeenLastCalledWith([], null);
  });

  it.each(['resolve', 'reject'] as const)('keeps the latest pending state when an older save finishes with %s', async outcome => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderWorkspace();
    await settle();
    let resolve!: () => void;
    let reject!: (error: string) => void;
    vi.mocked(saveSession).mockClear().mockImplementationOnce(() => new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    }));
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    await settle();
    act(() => result.current.setTabState(result.current.tabs[0].id, { currentPage: 2 }));
    await settle();
    // Saves are serialized, even when pagehide asks to flush during a write.
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(saveSession).toHaveBeenCalledTimes(1);
    await act(async () => { if (outcome === 'resolve') resolve(); else reject('old failure'); });
    expect(saveSession).toHaveBeenCalledTimes(2);
    expect(saveSession).toHaveBeenLastCalledWith([
      { path: '/data/a.parquet', state: { view_mode: null, current_page: 2, active_filter: null, sort: null } },
    ], '/data/a.parquet');
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(saveSession).toHaveBeenCalledTimes(2);
    error.mockRestore();
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
      [{ path: '/data/b.parquet', state: { view_mode: null, current_page: null, active_filter: null, sort: null } }],
      '/data/b.parquet',
    );
  });
});

// Files opened from Finder, the Dock or `open -a`: the backend buffers them
// until the webview asks, and hands over later ones as `file-drop` events
// (see `services::opened` and `deliver_opened` in lib.rs).
describe('WorkspaceProvider on the free tier', () => {
  beforeEach(() => {
    localStorage.clear();
    license.tabLimit = 3;
    license.showUpgrade.mockClear();
    vi.mocked(listSessionTabs).mockReset().mockResolvedValue({ tabs: [], active: null });
    vi.mocked(saveSession).mockClear();
    vi.mocked(openParquetFile).mockClear();
    vi.mocked(rememberFile).mockClear();
    vi.mocked(checkFileExists).mockClear();
    vi.mocked(evictCacheQuietly).mockClear();
  });

  afterEach(() => {
    license.tabLimit = null;
  });

  it('refuses the tab past the limit with the upgrade prompt, asking nothing of the backend', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet', '/data/c.parquet', '/data/d.parquet');

    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'c.parquet']);
    expect(result.current.activeTab?.path).toBe('/data/c.parquet');
    expect(license.showUpgrade).toHaveBeenCalledTimes(1);
    expect(checkFileExists).not.toHaveBeenCalledWith('/data/d.parquet');
    expect(openParquetFile).not.toHaveBeenCalledWith('/data/d.parquet');
    expect(rememberFile).not.toHaveBeenCalledWith('/data/d.parquet');
  });

  it('still activates a file already open, and frees a slot when a tab closes', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet', '/data/c.parquet');
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    expect(result.current.activeTab?.path).toBe('/data/a.parquet');
    expect(license.showUpgrade).not.toHaveBeenCalled();

    act(() => result.current.closeTab(result.current.tabs[1].id));
    await act(() => result.current.openParquetFile('/data/d.parquet'));
    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'c.parquet', 'd.parquet']);
    expect(license.showUpgrade).not.toHaveBeenCalled();
  });

  it('holds the limit when files open back to back without a render in between', async () => {
    const { result } = renderWorkspace();
    await act(async () => {
      await result.current.openParquetFile('/data/a.parquet');
      await result.current.openParquetFile('/data/b.parquet');
      await result.current.openParquetFile('/data/c.parquet');
      await result.current.openParquetFile('/data/d.parquet');
    });
    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'c.parquet']);
    // The fourth was refused before the backend heard of it, and told so.
    expect(openParquetFile).not.toHaveBeenCalledWith('/data/d.parquet');
    expect(rememberFile).not.toHaveBeenCalledWith('/data/d.parquet');
    expect(evictCacheQuietly).not.toHaveBeenCalled();
    expect(license.showUpgrade).toHaveBeenCalledTimes(1);
  });

  // Two files into one remaining slot, neither with a tab yet when the
  // other starts (a two-file drop): the second must not be opened in the
  // backend and then refused a tab, which would leave its cache and access
  // grant where no close could reach them (CT-04).
  it('reserves the last slot for the first of two files opened at once', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet');
    await act(async () => {
      await Promise.all([result.current.openParquetFile('/data/c.parquet'), result.current.openParquetFile('/data/d.parquet')]);
    });
    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'c.parquet']);
    expect(checkFileExists).not.toHaveBeenCalledWith('/data/d.parquet');
    expect(openParquetFile).not.toHaveBeenCalledWith('/data/d.parquet');
    expect(rememberFile).not.toHaveBeenCalledWith('/data/d.parquet');
    expect(evictCacheQuietly).not.toHaveBeenCalled();
    expect(license.showUpgrade).toHaveBeenCalledTimes(1);
  });

  it('treats a second request for a file being opened as activating its tab', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet');
    await act(async () => {
      await Promise.all([result.current.openParquetFile('/data/c.parquet'), result.current.openParquetFile('/data/c.parquet')]);
    });
    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'c.parquet']);
    expect(result.current.activeTab?.path).toBe('/data/c.parquet');
    expect(vi.mocked(openParquetFile).mock.calls.filter(c => c[0] === '/data/c.parquet')).toHaveLength(1);
    expect(vi.mocked(rememberFile).mock.calls.filter(c => c[0] === '/data/c.parquet')).toHaveLength(1);
    expect(evictCacheQuietly).not.toHaveBeenCalled();
    expect(license.showUpgrade).not.toHaveBeenCalled();
    // The tab is a real one: opening it again, alone, only activates it.
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    await act(() => result.current.openParquetFile('/data/c.parquet'));
    expect(result.current.tabs).toHaveLength(3);
    expect(result.current.activeTab?.path).toBe('/data/c.parquet');
  });

  it('gives the slot back when the open fails part way', async () => {
    const alerted = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await openTabs('/data/a.parquet', '/data/b.parquet');
    vi.mocked(openParquetFile).mockRejectedValueOnce(new Error('corrupt'));
    await act(() => result.current.openParquetFile('/data/c.parquet'));
    expect(result.current.tabs).toHaveLength(2);
    expect(alerted).toHaveBeenCalledWith('Failed to open file: Error: corrupt');
    await act(() => result.current.openParquetFile('/data/d.parquet'));
    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'd.parquet']);
    expect(license.showUpgrade).not.toHaveBeenCalled();
    alerted.mockRestore();
    logged.mockRestore();
  });

  it('gives the slot back when the file turns out to be gone', async () => {
    const alerted = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const result = await openTabs('/data/a.parquet', '/data/b.parquet');
    vi.mocked(checkFileExists).mockResolvedValueOnce(false);
    await act(() => result.current.openParquetFile('/data/c.parquet'));
    expect(result.current.tabs).toHaveLength(2);
    expect(alerted).toHaveBeenCalledWith('File not found: /data/c.parquet');
    await act(() => result.current.openParquetFile('/data/d.parquet'));
    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'd.parquet']);
    expect(license.showUpgrade).not.toHaveBeenCalled();
    alerted.mockRestore();
  });

  it('counts a tab closed while another file opens as room for one more', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet');
    let finishC!: () => void;
    vi.mocked(openParquetFile).mockImplementationOnce(() => new Promise(resolve => {
      finishC = () => resolve({ num_rows: 1, num_columns: 1, columns: [] } as never);
    }));
    let cOpened!: Promise<void>;
    await act(async () => {
      cOpened = result.current.openParquetFile('/data/c.parquet');
      await Promise.resolve();
    });
    // c holds the last slot: d is refused, until a tab closes.
    await act(() => result.current.openParquetFile('/data/d.parquet'));
    expect(license.showUpgrade).toHaveBeenCalledTimes(1);
    expect(openParquetFile).not.toHaveBeenCalledWith('/data/d.parquet');
    act(() => result.current.closeTab(result.current.tabs[0].id));
    await act(() => result.current.openParquetFile('/data/d.parquet'));
    await act(async () => {
      finishC();
      await cOpened;
    });
    expect(result.current.tabs.map(t => t.name)).toEqual(['b.parquet', 'd.parquet', 'c.parquet']);
    expect(license.showUpgrade).toHaveBeenCalledTimes(1);
    expect(evictCacheQuietly).toHaveBeenCalledTimes(1);
    expect(evictCacheQuietly).toHaveBeenCalledWith('/data/a.parquet');
  });

  it('opens a file the limit lifted for while it was opening', async () => {
    const { result, rerender } = renderWorkspace();
    await act(() => result.current.openParquetFile('/data/a.parquet'));
    await act(() => result.current.openParquetFile('/data/b.parquet'));
    let finishC!: () => void;
    vi.mocked(openParquetFile).mockImplementationOnce(() => new Promise(resolve => {
      finishC = () => resolve({ num_rows: 1, num_columns: 1, columns: [] } as never);
    }));
    let cOpened!: Promise<void>;
    await act(async () => {
      cOpened = result.current.openParquetFile('/data/c.parquet');
      await Promise.resolve();
    });
    license.tabLimit = null;
    rerender();
    await act(() => result.current.openParquetFile('/data/d.parquet'));
    await act(async () => {
      finishC();
      await cOpened;
    });
    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'd.parquet', 'c.parquet']);
    expect(license.showUpgrade).not.toHaveBeenCalled();
    expect(evictCacheQuietly).not.toHaveBeenCalled();
  });

  // The other direction — the limit comes back (a refund) with a fourth
  // file half open — is the one case the reducer's backstop still decides.
  // The file then has no tab, so its cache goes and the prompt says why.
  it('drops what the backend holds for a file the limit came back for while it was opening', async () => {
    license.tabLimit = null;
    const { result, rerender } = renderWorkspace();
    for (const n of ['a', 'b', 'c']) await act(() => result.current.openParquetFile(`/data/${n}.parquet`));
    let finishD!: () => void;
    vi.mocked(openParquetFile).mockImplementationOnce(() => new Promise(resolve => {
      finishD = () => resolve({ num_rows: 1, num_columns: 1, columns: [] } as never);
    }));
    let dOpened!: Promise<void>;
    await act(async () => {
      dOpened = result.current.openParquetFile('/data/d.parquet');
      await Promise.resolve();
    });
    license.tabLimit = 3;
    rerender();
    await act(async () => {
      finishD();
      await dOpened;
    });
    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'c.parquet']);
    expect(evictCacheQuietly).toHaveBeenCalledTimes(1);
    expect(evictCacheQuietly).toHaveBeenCalledWith('/data/d.parquet');
    expect(license.showUpgrade).toHaveBeenCalledTimes(1);
  });

  it('restores the first tabs up to the limit and names the rest, without opening them', async () => {
    vi.useFakeTimers();
    vi.mocked(listSessionTabs).mockResolvedValue({
      tabs: ['a', 'b', 'c', 'd', 'e'].map(n => sessionTab(`/data/${n}.parquet`)),
      active: '/data/e.parquet',
    });
    const { result } = renderWorkspace();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'c.parquet']);
    expect(result.current.activeTab?.path).toBe('/data/a.parquet');
    expect(openParquetFile).toHaveBeenCalledTimes(3);
    expect(result.current.restoreNotice).toEqual({ skipped: [], capped: ['/data/d.parquet', '/data/e.parquet'] });
    expect(license.showUpgrade).not.toHaveBeenCalled();
    // The next save keeps only what is open: the capped tabs leave the store.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(vi.mocked(saveSession).mock.lastCall?.[0].map(t => t.path)).toEqual(['/data/a.parquet', '/data/b.parquet', '/data/c.parquet']);
    vi.useRealTimers();
  });

  it('has no limit once unlocked', async () => {
    license.tabLimit = null;
    const result = await openTabs('/data/a.parquet', '/data/b.parquet', '/data/c.parquet', '/data/d.parquet');
    expect(result.current.tabs).toHaveLength(4);
    expect(license.showUpgrade).not.toHaveBeenCalled();
  });

  // The limit lifts after the restore: the full version was bought or
  // restored, or the launch-time read of the store landed after `iap_status`
  // gave up waiting for it and answered the free tier (CT-03).
  it('brings the capped tabs back, with their state, when the limit lifts', async () => {
    vi.useFakeTimers();
    vi.mocked(listSessionTabs).mockResolvedValue({
      tabs: [
        sessionTab('/data/a.parquet'),
        sessionTab('/data/b.parquet'),
        sessionTab('/data/c.parquet'),
        sessionTab('/data/d.parquet', { view_mode: 'query' }),
        sessionTab('/data/e.parquet', { current_page: 3, active_filter: 'x > 1', sort: null }),
      ],
      active: '/data/b.parquet',
    });
    const { result, rerender } = renderWorkspace();
    await settle();
    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'c.parquet']);
    expect(result.current.restoreNotice).toEqual({ skipped: [], capped: ['/data/d.parquet', '/data/e.parquet'] });
    vi.mocked(openParquetFile).mockClear();

    license.tabLimit = null;
    rerender();
    await settle();
    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'c.parquet', 'd.parquet', 'e.parquet']);
    expect(result.current.activeTab?.path).toBe('/data/b.parquet');
    const [d, e] = result.current.tabs.slice(3);
    expect(result.current.tabStates[d.id]).toEqual({ viewMode: 'query' });
    expect(result.current.tabStates[e.id]).toEqual({ currentPage: 3, activeFilter: 'x > 1' });
    // Opened as the restore opens tabs: through the backend, not into Recent Files.
    expect(vi.mocked(openParquetFile).mock.calls.map(c => c[0])).toEqual(['/data/d.parquet', '/data/e.parquet']);
    expect(rememberFile).not.toHaveBeenCalled();
    expect(result.current.restoreNotice).toBeNull();
    expect(license.showUpgrade).not.toHaveBeenCalled();
    // The next save has all five again.
    await settle();
    expect(vi.mocked(saveSession).mock.lastCall?.[0].map(t => t.path)).toEqual(['/data/a.parquet', '/data/b.parquet', '/data/c.parquet', '/data/d.parquet', '/data/e.parquet']);
    vi.useRealTimers();
  });

  // The drop listener is live from the first render, so a file can arrive
  // while the session is still being read. Its tab is a tab like any other:
  // the restore has that much less room, and what it cannot seat is capped
  // rather than opened in the backend and left without a tab.
  it('counts a file opened during the restore against the limit and caps the rest', async () => {
    vi.useFakeTimers();
    let finishRestore!: (value: { tabs: SessionTab[]; active: string | null }) => void;
    vi.mocked(listSessionTabs).mockReturnValue(new Promise(resolve => { finishRestore = resolve; }));
    const { result } = renderWorkspace();
    await settle();

    await act(() => result.current.openParquetFile('/data/x.parquet'));
    await act(async () => {
      finishRestore({ tabs: ['a', 'b', 'c'].map(n => sessionTab(`/data/${n}.parquet`)), active: '/data/c.parquet' });
    });
    await settle();

    expect(result.current.tabs.map(t => t.name)).toEqual(['x.parquet', 'a.parquet', 'b.parquet']);
    // The file the user just dropped keeps the window; the session's own
    // active tab does not take it back.
    expect(result.current.activeTab?.path).toBe('/data/x.parquet');
    expect(result.current.restoreNotice).toEqual({ skipped: [], capped: ['/data/c.parquet'] });
    expect(openParquetFile).not.toHaveBeenCalledWith('/data/c.parquet');
    expect(evictCacheQuietly).not.toHaveBeenCalled();
    expect(license.showUpgrade).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // The same drop, one step later: the room was there when the last session
  // tab started opening and gone by the time it landed. It has a cache and
  // an access grant and no tab, so it is evicted and capped like the rest.
  it('evicts and caps a restored file the drop left no room for', async () => {
    vi.useFakeTimers();
    const ok = { num_rows: 1, num_columns: 1, columns: [] } as never;
    vi.mocked(listSessionTabs).mockResolvedValue({
      tabs: ['a', 'b', 'c'].map(n => sessionTab(`/data/${n}.parquet`)),
      active: '/data/c.parquet',
    });
    let finishC!: () => void;
    vi.mocked(openParquetFile)
      .mockImplementationOnce(async () => ok)
      .mockImplementationOnce(async () => ok)
      .mockImplementationOnce(() => new Promise(resolve => { finishC = () => resolve(ok); }));
    const { result, rerender } = renderWorkspace();
    await settle();

    await act(() => result.current.openParquetFile('/data/x.parquet'));
    await act(async () => { finishC(); });
    await settle();

    expect(result.current.tabs.map(t => t.name)).toEqual(['x.parquet', 'a.parquet', 'b.parquet']);
    expect(result.current.activeTab?.path).toBe('/data/x.parquet');
    expect(result.current.restoreNotice).toEqual({ skipped: [], capped: ['/data/c.parquet'] });
    expect(evictCacheQuietly).toHaveBeenCalledTimes(1);
    expect(evictCacheQuietly).toHaveBeenCalledWith('/data/c.parquet');
    expect(license.showUpgrade).not.toHaveBeenCalled();

    // And it comes back with the other capped tabs when the limit lifts.
    vi.mocked(openParquetFile).mockClear();
    license.tabLimit = null;
    rerender();
    await settle();
    expect(result.current.tabs.map(t => t.name)).toEqual(['x.parquet', 'a.parquet', 'b.parquet', 'c.parquet']);
    expect(vi.mocked(openParquetFile).mock.calls.map(c => c[0])).toEqual(['/data/c.parquet']);
    expect(result.current.restoreNotice).toBeNull();
    vi.useRealTimers();
  });

  it('names a capped tab that fails to open when it comes back, and leaves it out', async () => {
    vi.useFakeTimers();
    vi.mocked(listSessionTabs).mockResolvedValue({
      tabs: ['a', 'b', 'c', 'd', 'e'].map(n => sessionTab(`/data/${n}.parquet`)),
      active: null,
    });
    const { result, rerender } = renderWorkspace();
    await settle();
    expect(result.current.tabs).toHaveLength(3);
    // d opens, e (the second to come back) fails.
    vi.mocked(openParquetFile).mockResolvedValueOnce({ num_rows: 1, num_columns: 1, columns: [] } as never).mockRejectedValueOnce(new Error('gone'));

    license.tabLimit = null;
    rerender();
    await settle();
    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'c.parquet', 'd.parquet']);
    expect(result.current.restoreNotice).toEqual({ skipped: ['/data/e.parquet'], capped: [] });
    vi.useRealTimers();
  });
});

// Files dropped on the window, and the ones Finder hands over while the app
// runs: both arrive as one `file-drop` event carrying every path.
describe('WorkspaceProvider files dropped on the window', () => {
  const ok = { num_rows: 1, num_columns: 1, columns: [] };

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(listen).mockClear();
    vi.mocked(listSessionTabs).mockReset().mockResolvedValue({ tabs: [], active: null });
    vi.mocked(openParquetFile).mockClear();
    vi.mocked(evictCacheQuietly).mockClear();
  });

  /** Hand the provider's `file-drop` listener a drop, as the backend does. */
  async function drop(paths: string[]) {
    const listener = vi.mocked(listen).mock.calls.find(([name]) => name === 'file-drop');
    await act(async () => {
      (listener![1] as (event: unknown) => void)({ event: 'file-drop', id: 1, payload: paths });
    });
  }

  it('opens the rest when the first file fails', async () => {
    const alerted = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderWorkspace();
    vi.mocked(openParquetFile).mockRejectedValueOnce(new Error('corrupt'));

    await drop(['/data/bad.parquet', '/data/good.parquet']);

    await waitFor(() => expect(result.current.tabs.map(t => t.path)).toEqual(['/data/good.parquet']));
    expect(alerted).toHaveBeenCalledTimes(1);
    expect(alerted).toHaveBeenCalledWith('Failed to open file: Error: corrupt');
    alerted.mockRestore();
    logged.mockRestore();
  });

  it('keeps the tab of the first file when a later one fails', async () => {
    const alerted = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderWorkspace();
    vi.mocked(openParquetFile)
      .mockImplementationOnce(async () => ok as never)
      .mockRejectedValueOnce(new Error('corrupt'));

    await drop(['/data/good.parquet', '/data/bad.parquet']);

    await waitFor(() => expect(result.current.tabs.map(t => t.path)).toEqual(['/data/good.parquet']));
    expect(alerted).toHaveBeenCalledTimes(1);
    alerted.mockRestore();
    logged.mockRestore();
  });

  // The same file dropped again while the first drop is still opening it,
  // and failing: the waiting request must not carry the failure into the
  // loop, or the files dropped behind it never open.
  it('opens the files behind one the previous drop is still opening', async () => {
    const alerted = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderWorkspace();
    let fail!: (error: unknown) => void;
    vi.mocked(openParquetFile).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));

    await drop(['/data/a.parquet']);
    await drop(['/data/a.parquet', '/data/b.parquet']);
    await act(async () => { fail(new Error('corrupt')); });

    await waitFor(() => expect(result.current.tabs.map(t => t.path)).toEqual(['/data/b.parquet']));
    // One open, one failure: the second request only waited for the first.
    expect(vi.mocked(openParquetFile).mock.calls.filter(c => c[0] === '/data/a.parquet')).toHaveLength(1);
    expect(alerted).toHaveBeenCalledTimes(1);
    alerted.mockRestore();
    logged.mockRestore();
  });
});

describe('WorkspaceProvider files handed over at launch', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.mocked(listSessionTabs).mockReset().mockResolvedValue({ tabs: [], active: null });
    vi.mocked(takePendingFiles).mockReset().mockResolvedValue([]);
    vi.mocked(openParquetFile).mockClear();
    vi.mocked(rememberFile).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens what was handed over, and records it like any other open', async () => {
    vi.mocked(takePendingFiles).mockResolvedValue(['/data/from finder.parquet']);
    const { result } = renderWorkspace();
    await settle();

    expect(result.current.tabs.map(t => t.path)).toEqual(['/data/from finder.parquet']);
    expect(result.current.activeTab?.path).toBe('/data/from finder.parquet');
    // The same path a manual open takes, so the bookmark is created too.
    expect(openParquetFile).toHaveBeenCalledWith('/data/from finder.parquet');
    expect(rememberFile).toHaveBeenCalledWith('/data/from finder.parquet');
  });

  it('opens it after the restored tabs and leaves it active', async () => {
    vi.mocked(listSessionTabs).mockResolvedValue({
      tabs: [sessionTab('/data/a.parquet'), sessionTab('/data/b.parquet')],
      active: '/data/b.parquet',
    });
    vi.mocked(takePendingFiles).mockResolvedValue(['/data/c.parquet']);
    const { result } = renderWorkspace();
    await settle();

    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'c.parquet']);
    expect(result.current.activeTab?.path).toBe('/data/c.parquet');
  });

  it('does not ask before the restore has finished', async () => {
    let finishRestore!: (value: { tabs: SessionTab[]; active: string | null }) => void;
    vi.mocked(listSessionTabs).mockReturnValue(new Promise(resolve => { finishRestore = resolve; }));
    vi.mocked(takePendingFiles).mockResolvedValue(['/data/c.parquet']);
    const { result } = renderWorkspace();
    await settle();

    // The backend keeps buffering until we ask; asking early would race the
    // restore for the active tab.
    expect(takePendingFiles).not.toHaveBeenCalled();

    await act(async () => { finishRestore({ tabs: [sessionTab('/data/a.parquet')], active: '/data/a.parquet' }); });
    await settle();

    expect(takePendingFiles).toHaveBeenCalledTimes(1);
    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'c.parquet']);
    expect(result.current.activeTab?.path).toBe('/data/c.parquet');
  });

  it('opens no tab for a file that is not a parquet', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(takePendingFiles).mockResolvedValue(['/data/notes.csv']);
    const { result } = renderWorkspace();
    await settle();

    expect(result.current.tabs).toEqual([]);
    expect(openParquetFile).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith('Parqsee can only open .parquet files');
  });

  it('does nothing, and never asks twice, when nothing was handed over', async () => {
    const { result } = renderWorkspace();
    await settle();
    await settle();

    expect(takePendingFiles).toHaveBeenCalledTimes(1);
    expect(result.current.tabs).toEqual([]);
  });
});

describe('WorkspaceProvider sample file', () => {
  const SAMPLE = '/Applications/Parqsee.app/Contents/Resources/sample.parquet';

  beforeEach(() => {
    localStorage.clear();
    license.showUpgrade.mockClear();
    vi.mocked(sampleFilePath).mockClear();
    vi.mocked(openParquetFile).mockClear();
    vi.mocked(rememberFile).mockClear();
    vi.mocked(checkFileExists).mockClear();
    vi.mocked(saveSession).mockClear();
  });

  afterEach(() => {
    license.tabLimit = null;
  });

  it('opens the bundled sample in a tab without recording it in Recent Files', async () => {
    const { result } = renderWorkspace();
    await act(() => result.current.openSampleFile());

    expect(sampleFilePath).toHaveBeenCalledTimes(1);
    expect(checkFileExists).toHaveBeenCalledWith(SAMPLE);
    expect(openParquetFile).toHaveBeenCalledWith(SAMPLE);
    expect(result.current.tabs.map(t => t.name)).toEqual(['sample.parquet']);
    expect(result.current.activeTab?.path).toBe(SAMPLE);
    expect(rememberFile).not.toHaveBeenCalled();
  });

  it('keeps the sample in the session like any other tab', async () => {
    vi.useFakeTimers();
    const { result } = renderWorkspace();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(() => result.current.openSampleFile());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(vi.mocked(saveSession).mock.lastCall?.[0].map(t => t.path)).toEqual([SAMPLE]);
    expect(vi.mocked(saveSession).mock.lastCall?.[1]).toBe(SAMPLE);
    vi.useRealTimers();
  });

  it('counts against the free tier\'s limit, and activates its tab when it is already open', async () => {
    license.tabLimit = 3;
    const result = await openTabs('/data/a.parquet', '/data/b.parquet', '/data/c.parquet');
    await act(() => result.current.openSampleFile());

    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'c.parquet']);
    expect(license.showUpgrade).toHaveBeenCalledTimes(1);
    expect(openParquetFile).not.toHaveBeenCalledWith(SAMPLE);

    act(() => result.current.closeTab(result.current.tabs[2].id));
    await act(() => result.current.openSampleFile());
    expect(result.current.tabs.map(t => t.name)).toEqual(['a.parquet', 'b.parquet', 'sample.parquet']);

    await act(() => result.current.openParquetFile('/data/a.parquet'));
    await act(() => result.current.openSampleFile());
    expect(result.current.activeTab?.path).toBe(SAMPLE);
    expect(result.current.tabs).toHaveLength(3);
    expect(license.showUpgrade).toHaveBeenCalledTimes(1);
  });

  it('says so, and opens nothing, when this build has no sample', async () => {
    const alerted = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(sampleFilePath).mockRejectedValueOnce('This build has no sample file (…/sample.parquet is missing)');
    const { result } = renderWorkspace();
    await act(() => result.current.openSampleFile());

    expect(result.current.tabs).toHaveLength(0);
    expect(openParquetFile).not.toHaveBeenCalled();
    expect(alerted).toHaveBeenCalledWith(expect.stringContaining('This build has no sample file'));
    alerted.mockRestore();
    logged.mockRestore();
  });
});

describe('WorkspaceProvider shortcuts', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(listen).mockClear();
  });

  const press = (init: KeyboardEventInit) =>
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init })); });
  // The provider registers its `menu` listener once and keeps it (it
  // reads the current handler through a ref), so there is only ever one.
  const menuListener = () => {
    const calls = vi.mocked(listen).mock.calls.filter(([name]) => name === 'menu');
    expect(calls.length).toBe(1);
    return calls[0][1] as (e: { payload: string }) => void;
  };
  // Tab selection is deferred to the next frame (see handleTabSelect).
  const frame = () => act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));

  it('opens and closes the shortcut sheet on ⌘/', async () => {
    const { result } = renderWorkspace();
    expect(result.current.isShortcutsOpen).toBe(false);
    press({ metaKey: true, key: '/' });
    expect(result.current.isShortcutsOpen).toBe(true);
    press({ metaKey: true, key: '/' });
    expect(result.current.isShortcutsOpen).toBe(false);
  });

  it('hands a view command to the app-command bus', async () => {
    const heard = vi.fn();
    renderHook(() => { useAppCommand(heard); return useWorkspace(); }, { wrapper });
    press({ metaKey: true, key: 'f' });
    press({ ctrlKey: true, key: 'Enter' });
    press({ metaKey: true, key: 'e' });
    expect(heard.mock.calls.map(c => c[0])).toEqual(['find', 'run-query', 'switch-view']);
  });

  it('walks the tabs on ⇧⌘] and ⌘1…9, and answers the native menu by the same ids', async () => {
    const result = await openTabs('/data/a.parquet', '/data/b.parquet', '/data/c.parquet');
    press({ metaKey: true, key: '1' });
    await frame();
    expect(result.current.activeTab?.path).toBe('/data/a.parquet');
    press({ metaKey: true, shiftKey: true, key: '}', code: 'BracketRight' });
    await frame();
    expect(result.current.activeTab?.path).toBe('/data/b.parquet');

    const onMenu = menuListener();
    expect(onMenu).toBeDefined();
    act(() => onMenu({ payload: 'previous-tab' }));
    await frame();
    expect(result.current.activeTab?.path).toBe('/data/a.parquet');
    expect(result.current.isSidebarOpen).toBe(true);
    act(() => onMenu({ payload: 'toggle-sidebar' }));
    expect(result.current.isSidebarOpen).toBe(false);
    act(() => onMenu({ payload: 'shortcuts' }));
    expect(result.current.isShortcutsOpen).toBe(true);
  });

  it('opens the support page in the UI language on Help', async () => {
    vi.mocked(openUrl).mockResolvedValueOnce(undefined);
    renderWorkspace();
    const onMenu = menuListener();
    act(() => onMenu({ payload: 'help' }));
    expect(openUrl).toHaveBeenCalledWith('https://parqsee.fuji.llc/support.html');
  });
});
