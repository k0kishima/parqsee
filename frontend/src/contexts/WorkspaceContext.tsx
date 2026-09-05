import { createContext, useContext, useState, useCallback, useEffect, useRef, useReducer, useTransition, ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { useRecentFiles } from './RecentFilesContext';
import { useSettings } from './SettingsContext';
import { useLicense } from './LicenseContext';
import { isTauri } from '../lib/tauri';
import { getFileName, isParquetPath, PARQUET_EXTENSION } from '../lib/path';
import { useGlobalKeydown, isModifierPressed } from '../hooks/useGlobalKeydown';

import { openParquetFile as apiOpenParquetFile, checkFileExists, evictCacheQuietly } from '../features/file-viewer/api';
import { rememberFile } from '../features/welcome/api';
import { TabState } from '../features/file-viewer';
import {
    WorkspaceRoot,
    listWorkspaceRoots,
    addWorkspaceRoot as apiAddWorkspaceRoot,
    removeWorkspaceRoot as apiRemoveWorkspaceRoot,
    listSessionTabs,
    saveSession,
} from '../features/workspace/api';
import {
    Tab,
    WorkspaceTabs,
    RestoredTab,
    SessionSnapshot,
    EMPTY_WORKSPACE_TABS,
    reduceWorkspaceTabs,
    closeTab as closeTabTransition,
    activeTab as activeTabOf,
    adjacentTabId,
    nthTabId,
    sessionSnapshot,
    restoredTabState,
} from './workspace-tabs';

export type { Tab, WorkspaceRoot };

/** The files of the last session that could not be reopened at launch. */
export interface RestoreNotice {
    skipped: string[];
}

/**
 * How long a change to the session waits before it is written. Page
 * changes and filter edits come in bursts; tab opens and closes are rare
 * enough that the delay is not felt, and `pagehide` flushes what is pending.
 */
const SESSION_SAVE_DELAY_MS = 250;

interface WorkspaceContextType {
    currentFile: string | null;
    tabs: WorkspaceTabs['tabs'];
    activeTabId: string | null;
    isSidebarOpen: boolean;
    isSettingsOpen: boolean;
    isPending: boolean;
    tabStates: WorkspaceTabs['tabStates'];
    /** The folders open in the explorer, restored from the last session. */
    roots: readonly WorkspaceRoot[];
    openParquetFile: (path: string) => Promise<void>;
    /** Show the native file picker and open what was chosen. */
    openFileDialog: () => Promise<void>;
    /** Show the native folder picker and add what was chosen as a workspace root. */
    openFolderDialog: () => Promise<void>;
    removeWorkspaceRoot: (path: string) => void;
    closeTab: (tabId: string) => void;
    selectTab: (tabId: string) => void;
    toggleSidebar: () => void;
    toggleSettings: (isOpen: boolean) => void;
    /** Merge `patch` into the tab's state; send only the fields you own. */
    setTabState: (tabId: string, patch: Partial<TabState>) => void;
    activeTab: Tab | undefined;
    /** Set once the launch-time restore skipped a file; cleared by `dismissRestoreNotice`. */
    restoreNotice: RestoreNotice | null;
    dismissRestoreNotice: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

let nextTabSerial = 0;
/** Unique per tab; Date.now() alone collided when two files opened in one tick. */
const newTabId = () => `${Date.now()}-${nextTabSerial++}`;

export function WorkspaceProvider({ children }: { children: ReactNode }) {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    // Every transition goes through the reducer, so files opened back to back
    // in one tick (a multi-file drop) and a closeTab captured by a memoized
    // child both act on the latest tabs rather than on a stale snapshot.
    const [workspaceTabs, dispatch] = useReducer(reduceWorkspaceTabs, EMPTY_WORKSPACE_TABS);
    const { tabs, activeTabId, tabStates } = workspaceTabs;
    // The last rendered tabs, for decisions made in stable callbacks.
    const workspaceTabsRef = useRef(workspaceTabs);
    workspaceTabsRef.current = workspaceTabs;
    const [isPending, startTransition] = useTransition();
    const { upsertRecentFile, removeRecentFile } = useRecentFiles();
    const [roots, setRoots] = useState<readonly WorkspaceRoot[]>([]);
    const { settings } = useSettings();
    const { usable } = useLicense();
    // Read once: the setting decides what happens at launch, not later.
    // A locked app (no trial yet, or an expired one) restores nothing:
    // the backend would refuse every page read, and the paywall covers
    // the Welcome screen anyway.
    const restoreOnLaunch = useRef(settings.restoreTabs && usable);
    const [restoreNotice, setRestoreNotice] = useState<RestoreNotice | null>(null);
    // Saving starts once the restore has finished (or was skipped): the
    // empty workspace of the first render must not overwrite the store.
    const [sessionReady, setSessionReady] = useState(!isTauri());

    // The roots the backend restored from its store (and re-acquired access
    // to, under the sandbox).
    useEffect(() => {
        if (!isTauri()) return;
        listWorkspaceRoots()
            .then(setRoots)
            .catch(error => console.error('Failed to list workspace roots:', error));
    }, []);

    // The tabs of the last session. Each available one is opened through the
    // same command a manual open uses, so the cache and the access grants
    // behave as usual; `rememberFile` is not called, so Recent Files keeps
    // its order. A file that is gone, or fails to open, is skipped and named
    // in the notice; the next save drops it from the store.
    useEffect(() => {
        if (!isTauri()) return;
        // StrictMode runs this effect twice in development; only the run
        // that survives may touch the workspace.
        let cancelled = false;
        (async () => {
            const skipped: string[] = [];
            if (restoreOnLaunch.current) {
                try {
                    const session = await listSessionTabs();
                    const restored: RestoredTab[] = [];
                    for (const tab of session.tabs) {
                        if (!tab.available) {
                            skipped.push(tab.path);
                            continue;
                        }
                        try {
                            await apiOpenParquetFile(tab.path);
                        } catch (error) {
                            console.error(`Failed to reopen ${tab.path} from the last session:`, error);
                            skipped.push(tab.path);
                            continue;
                        }
                        restored.push({
                            tab: { id: newTabId(), path: tab.path, name: tab.name },
                            state: restoredTabState(tab.state),
                        });
                    }
                    if (cancelled) return;
                    dispatch({ type: 'restore', tabs: restored, activePath: session.active });
                } catch (error) {
                    console.error('Failed to restore the last session:', error);
                }
            }
            if (cancelled) return;
            if (skipped.length > 0) setRestoreNotice({ skipped });
            setSessionReady(true);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Persist the session on every change worth keeping, after a short
    // delay; a snapshot equal to the last one written is not written again.
    const lastSavedSession = useRef<string | null>(null);
    const pendingSession = useRef<{ snapshot: SessionSnapshot; timer: ReturnType<typeof setTimeout> } | null>(null);
    const flushSession = useCallback(() => {
        const pending = pendingSession.current;
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingSession.current = null;
        saveSession(pending.snapshot.tabs, pending.snapshot.active)
            .catch(error => console.error('Failed to save the session:', error));
    }, []);
    useEffect(() => {
        if (!isTauri() || !sessionReady) return;
        const snapshot = sessionSnapshot(workspaceTabs);
        const key = JSON.stringify(snapshot);
        if (key === lastSavedSession.current) return;
        lastSavedSession.current = key;
        if (pendingSession.current) clearTimeout(pendingSession.current.timer);
        pendingSession.current = { snapshot, timer: setTimeout(flushSession, SESSION_SAVE_DELAY_MS) };
    }, [workspaceTabs, sessionReady, flushSession]);
    // The window going away is the one change that cannot wait.
    useEffect(() => {
        window.addEventListener('pagehide', flushSession);
        return () => window.removeEventListener('pagehide', flushSession);
    }, [flushSession]);


    const handleTabSelect = useCallback((tabId: string) => {
        requestAnimationFrame(() => {
            startTransition(() => {
                dispatch({ type: 'select', tabId });
            });
        });
    }, []);

    const handleTabClose = useCallback((tabId: string) => {
        // Whether the file is still shown elsewhere is read from the last
        // render: closes come from user events, never in the same tick as
        // the open that could make this one render stale.
        const { evictPath } = closeTabTransition(workspaceTabsRef.current, tabId);
        dispatch({ type: 'close', tabId });
        if (evictPath) {
            evictCacheQuietly(evictPath);
        }
    }, []);

    const openParquetFile = useCallback(async (path: string) => {
        try {
            if (isTauri()) {
                const fileExists = await checkFileExists(path);
                if (!fileExists) {
                    removeRecentFile(path);
                    alert(`File not found: ${path}`);
                    return;
                }

                await apiOpenParquetFile(path);

                // Recorded now, while the app can read the file, so Recent
                // Files can reopen it after a relaunch. A failure to record
                // it is not a failure to open it.
                const recent = await rememberFile(path).catch(error => {
                    console.error('Failed to record the file in Recent Files:', error);
                    return null;
                });
                if (recent) upsertRecentFile(recent);

                dispatch({ type: 'open', tab: { id: newTabId(), path, name: recent?.name ?? getFileName(path) } });
            }
            // Browser fallback: there is no backend to open the file with.
        } catch (error) {
            console.error("Failed to open parquet file:", error);
            alert(`Failed to open file: ${error}`);
        }
    }, [upsertRecentFile, removeRecentFile]);

    const openFileDialog = useCallback(async () => {
        try {
            if (!isTauri()) {
                alert("File browser is only available in the desktop app. Please drag and drop a file instead.");
                return;
            }
            const selected = await open({
                filters: [{
                    name: 'Parquet Files',
                    extensions: [PARQUET_EXTENSION]
                }]
            });
            if (selected && typeof selected === 'string') {
                openParquetFile(selected);
            }
        } catch (error) {
            console.error("Failed to select file:", error);
        }
    }, [openParquetFile]);

    const openFolderDialog = useCallback(async () => {
        try {
            if (!isTauri()) {
                alert("The folder browser is only available in the desktop app. Please drag and drop a file instead.");
                return;
            }
            const selected = await open({ directory: true, multiple: false });
            if (selected && typeof selected === 'string') {
                const root = await apiAddWorkspaceRoot(selected);
                setRoots(prev => [...prev.filter(r => r.path !== root.path), root]);
            }
        } catch (error) {
            console.error("Failed to open folder:", error);
            alert(`Failed to open folder: ${error}`);
        }
    }, []);

    const removeWorkspaceRoot = useCallback((path: string) => {
        setRoots(prev => prev.filter(r => r.path !== path));
        if (isTauri()) {
            apiRemoveWorkspaceRoot(path).catch(error => console.error('Failed to remove workspace root:', error));
        }
    }, []);

    // Keyboard shortcuts. On macOS the native menu owns ⌘W / ⌘O / ⌘⇧O / ⌘,
    // and forwards them as `menu` events (below); these handlers cover the
    // browser and any platform without that menu.
    useGlobalKeydown(useCallback((e: KeyboardEvent) => {
        if (isModifierPressed(e) && e.key === 'w') {
            e.preventDefault();
            if (activeTabId) {
                handleTabClose(activeTabId);
            }
        } else if (isModifierPressed(e) && e.shiftKey && e.key.toLowerCase() === 'o') {
            e.preventDefault();
            openFolderDialog();
        } else if (isModifierPressed(e) && e.key === 'o') {
            e.preventDefault();
            openFileDialog();
        } else if (isModifierPressed(e) && e.key === ',') {
            e.preventDefault();
            setIsSettingsOpen(true);
        } else if ((e.metaKey && e.shiftKey && e.key === '[') || (e.metaKey && e.altKey && e.key === 'ArrowLeft')) {
            e.preventDefault();
            const target = adjacentTabId(workspaceTabs, -1);
            if (target) handleTabSelect(target);
        } else if ((e.metaKey && e.shiftKey && e.key === ']') || (e.metaKey && e.altKey && e.key === 'ArrowRight')) {
            e.preventDefault();
            const target = adjacentTabId(workspaceTabs, 1);
            if (target) handleTabSelect(target);
        } else if (e.metaKey && e.key >= '1' && e.key <= '9') {
            e.preventDefault();
            const target = nthTabId(workspaceTabs, parseInt(e.key));
            if (target) handleTabSelect(target);
        }
    }, [activeTabId, workspaceTabs, handleTabClose, handleTabSelect, openFileDialog, openFolderDialog]));

    // Native menu items (see build_menu in lib.rs)
    useEffect(() => {
        if (!isTauri()) return;
        const unlisten = listen<string>('menu', (event) => {
            switch (event.payload) {
                case 'open-file': openFileDialog(); break;
                case 'open-folder': openFolderDialog(); break;
                case 'close-tab': if (activeTabId) handleTabClose(activeTabId); break;
                case 'settings': setIsSettingsOpen(true); break;
            }
        });
        return () => {
            unlisten.then(fn => fn());
        };
    }, [activeTabId, handleTabClose, openFileDialog, openFolderDialog]);

    // File drop listener
    useEffect(() => {
        if (isTauri()) {
            const unlisten = listen('file-drop', async (event: any) => {
                const files: string[] = event.payload || [];
                if (files.length > 0) {
                    const parquetFiles = files.filter((f) => isParquetPath(f));
                    if (parquetFiles.length === 0) {
                        alert('Please drop a .parquet file');
                        return;
                    }
                    // Every dropped file gets a tab; the last one opened is the
                    // active one.
                    for (const file of parquetFiles) {
                        await openParquetFile(file);
                    }
                }
            });

            return () => {
                unlisten.then(fn => fn());
            };
        }
    }, [openParquetFile]);

    const activeTab = activeTabOf(workspaceTabs);

    const value = {
        currentFile: activeTab?.path ?? null,
        tabs,
        activeTabId,
        isSidebarOpen,
        isSettingsOpen,
        isPending,
        tabStates,
        roots,
        openParquetFile,
        openFileDialog,
        openFolderDialog,
        removeWorkspaceRoot,
        closeTab: handleTabClose,
        selectTab: handleTabSelect,
        toggleSidebar: () => setIsSidebarOpen(prev => !prev),
        toggleSettings: setIsSettingsOpen,
        setTabState: (tabId: string, patch: Partial<TabState>) => dispatch({ type: 'patchState', tabId, patch }),
        activeTab,
        restoreNotice,
        dismissRestoreNotice: () => setRestoreNotice(null),
    };

    return (
        <WorkspaceContext.Provider value={value}>
            {children}
        </WorkspaceContext.Provider>
    );
}

export function useWorkspace() {
    const context = useContext(WorkspaceContext);
    if (context === undefined) {
        throw new Error('useWorkspace must be used within a WorkspaceProvider');
    }
    return context;
}
