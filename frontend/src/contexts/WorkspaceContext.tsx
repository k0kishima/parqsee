import { createContext, useContext, useState, useCallback, useEffect, useRef, useReducer, useTransition, ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { useRecentFiles } from './RecentFilesContext';
import { isTauri } from '../lib/tauri';
import { isParquetPath, PARQUET_EXTENSION } from '../lib/path';
import { useGlobalKeydown, isModifierPressed } from '../hooks/useGlobalKeydown';

import { openParquetFile as apiOpenParquetFile, checkFileExists, getFileInfo, evictCacheQuietly } from '../features/file-viewer/api';
import { TabState } from '../features/file-viewer';
import {
    WorkspaceRoot,
    listWorkspaceRoots,
    addWorkspaceRoot as apiAddWorkspaceRoot,
    removeWorkspaceRoot as apiRemoveWorkspaceRoot,
} from '../features/workspace/api';
import {
    Tab,
    WorkspaceTabs,
    EMPTY_WORKSPACE_TABS,
    reduceWorkspaceTabs,
    closeTab as closeTabTransition,
    activeTab as activeTabOf,
    adjacentTabId,
    nthTabId,
} from './workspace-tabs';

export type { Tab, WorkspaceRoot };

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
    const { addRecentFile, removeRecentFile } = useRecentFiles();
    const [roots, setRoots] = useState<readonly WorkspaceRoot[]>([]);

    // The roots the backend restored from its store (and re-acquired access
    // to, under the sandbox).
    useEffect(() => {
        if (!isTauri()) return;
        listWorkspaceRoots()
            .then(setRoots)
            .catch(error => console.error('Failed to list workspace roots:', error));
    }, []);


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
                const fileInfo = await getFileInfo(path);

                addRecentFile({
                    path: fileInfo.path,
                    name: fileInfo.name,
                    lastAccessed: new Date().toLocaleString(),
                    size: fileInfo.size
                });

                dispatch({ type: 'open', tab: { id: newTabId(), path: fileInfo.path, name: fileInfo.name } });
            }
            // Browser fallback: there is no backend to open the file with.
        } catch (error) {
            console.error("Failed to open parquet file:", error);
            alert(`Failed to open file: ${error}`);
        }
    }, [addRecentFile, removeRecentFile]);

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
        activeTab
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
