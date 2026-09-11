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
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
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
  state: { view_mode: null, current_page: null, active_filter: null, ...state },
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

  it('refuses to reopen past the free tier\'s limit, with the upgrade prompt', async () => {
    license.tabLimit = 2;
    const result = await openTabs('/data/a.parquet', '/data/b.parquet');
    const [, b] = result.current.tabs;
    act(() => result.current.closeTab(b.id));
    await act(() => result.current.openParquetFile('/data/c.parquet'));
    license.showUpgrade.mockClear();

    await act(() => result.current.reopenClosedTab());

    expect(result.current.tabs.map(t => t.path)).toEqual(['/data/a.parquet', '/data/c.parquet']);
    expect(license.showUpgrade).toHaveBeenCalled();
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
    expect(result.current.restoreNotice).toEqual({ skipped: ['/data/gone.parquet', '/data/broken.parquet'], capped: [] });
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
