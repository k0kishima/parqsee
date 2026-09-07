import { createContext, useContext, useState, useCallback, useEffect, useRef, useReducer, useTransition, ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { useRecentFiles } from './RecentFilesContext';
import { useSettings } from './SettingsContext';
import { useLicense } from './LicenseContext';
import { isTauri } from '../lib/tauri';
import { getFileName, isParquetPath, PARQUET_EXTENSION } from '../lib/path';
import { openUrl } from '@tauri-apps/plugin-opener';
import i18n from '../lib/i18n';
import { useGlobalKeydown } from '../hooks/useGlobalKeydown';
import { matchShortcut, matchGoToTab } from '../lib/shortcuts';
import { isAppCommand, dispatchAppCommand } from '../lib/app-commands';

import { openParquetFile as apiOpenParquetFile, checkFileExists, evictCacheQuietly } from '../features/file-viewer/api';
import { rememberFile, sampleFilePath } from '../features/welcome/api';
import { TabState } from '../features/file-viewer';
import {
    WorkspaceRoot,
    listWorkspaceRoots,
    addWorkspaceRoot as apiAddWorkspaceRoot,
    removeWorkspaceRoot as apiRemoveWorkspaceRoot,
    listSessionTabs,
    saveSession,
    takePendingFiles,
} from '../features/workspace/api';
import {
    Tab,
    ClosedTab,
    WorkspaceTabs,
    RestoredTab,
    SessionSnapshot,
    EMPTY_WORKSPACE_TABS,
    reduceWorkspaceTabs,
    closeTab as closeTabTransition,
    closeTabs as closeTabsTransition,
    activeTab as activeTabOf,
    adjacentTabId,
    nthTabId,
    sessionSnapshot,
    restoredTabState,
    hasRoomForTab,
} from './workspace-tabs';

export type { Tab, WorkspaceRoot };

/** What of the last session did not come back at launch. */
export interface RestoreNotice {
    /** The files that could not be reopened (gone, or failed to open). */
    skipped: string[];
    /** The tabs left out because the free tier's limit was reached. */
    capped: string[];
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
    /** The keyboard shortcut sheet (⌘/, Help › Keyboard Shortcuts). */
    isShortcutsOpen: boolean;
    isPending: boolean;
    tabStates: WorkspaceTabs['tabStates'];
    /** The folders open in the explorer, restored from the last session. */
    roots: readonly WorkspaceRoot[];
    openParquetFile: (path: string) => Promise<void>;
    /**
     * Open the sample file the app ships, as a tab like any other — it
     * counts against the free tier's limit and comes back with the
     * session — except that Recent Files never lists it.
     */
    openSampleFile: () => Promise<void>;
    /** Show the native file picker and open what was chosen. */
    openFileDialog: () => Promise<void>;
    /** Show the native folder picker and add what was chosen as a workspace root. */
    openFolderDialog: () => Promise<void>;
    removeWorkspaceRoot: (path: string) => void;
    closeTab: (tabId: string) => void;
    /** Close every tab in `tabIds` at once; ids that are not open are ignored. */
    closeTabs: (tabIds: readonly string[]) => void;
    /** Reopen the last closed tab with the state it was closed on (⇧⌘T). */
    reopenClosedTab: () => Promise<void>;
    /** False when the reopen history holds nothing that is not open again. */
    canReopenClosedTab: boolean;
    selectTab: (tabId: string) => void;
    toggleSidebar: () => void;
    toggleSettings: (isOpen: boolean) => void;
    toggleShortcuts: (isOpen: boolean) => void;
    /** Merge `patch` into the tab's state; send only the fields you own. */
    setTabState: (tabId: string, patch: Partial<TabState>) => void;
    activeTab: Tab | undefined;
    /**
     * False until the roots and the last session are both back. The router
     * paints nothing before it: the first render has neither, so the app
     * would show the Welcome screen, then the workspace, then the tabs —
     * three layouts, none of them asked for.
     */
    isReady: boolean;
    /** Set once the launch-time restore skipped a file; cleared by `dismissRestoreNotice`. */
    restoreNotice: RestoreNotice | null;
    dismissRestoreNotice: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

/** How many closed tabs ⇧⌘T can walk back through. */
const CLOSED_TAB_HISTORY = 10;

/** Help › Parqsee Help: the support page of the product site, in the UI's language. */
const SUPPORT_URL = 'https://parqsee.fuji.llc/support.html';
const SUPPORT_URL_JA = 'https://parqsee.fuji.llc/ja/support.html';

let nextTabSerial = 0;
/** Unique per tab; Date.now() alone collided when two files opened in one tick. */
const newTabId = () => `${Date.now()}-${nextTabSerial++}`;

export function WorkspaceProvider({ children }: { children: ReactNode }) {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    // Every transition goes through the reducer, so files opened back to back
    // in one tick (a multi-file drop) and a closeTab captured by a memoized
    // child both act on the latest tabs rather than on a stale snapshot.
    const [workspaceTabs, dispatch] = useReducer(reduceWorkspaceTabs, EMPTY_WORKSPACE_TABS);
    const { tabs, activeTabId, tabStates } = workspaceTabs;
    // The tabs closed in this session, newest last, capped: what ⇧⌘T and
    // the tab menu's Reopen give back. Not persisted — a relaunch restores
    // the tabs that were open, and undoing a close from before it would be
    // undoing something the user cannot see any more.
    const [closedTabs, setClosedTabs] = useState<readonly ClosedTab[]>([]);
    // The last rendered tabs, for decisions made in stable callbacks.
    // Written in an effect, not during render (react.dev/reference/react/useRef).
    const workspaceTabsRef = useRef(workspaceTabs);
    useEffect(() => {
        workspaceTabsRef.current = workspaceTabs;
    }, [workspaceTabs]);
    const [isPending, startTransition] = useTransition();
    const { upsertRecentFile, removeRecentFile } = useRecentFiles();
    const [roots, setRoots] = useState<readonly WorkspaceRoot[]>([]);
    const { settings } = useSettings();
    // The free tier's tab limit (none once unlocked), read through a ref so
    // the stable callbacks below and the launch-time restore see the latest.
    const { tabLimit, showUpgrade } = useLicense();
    const tabLimitRef = useRef(tabLimit);
    useEffect(() => {
        tabLimitRef.current = tabLimit;
    }, [tabLimit]);
    // Read once: the setting decides what happens at launch, not later.
    const restoreOnLaunch = useRef(settings.restoreTabs);
    const [restoreNotice, setRestoreNotice] = useState<RestoreNotice | null>(null);
    // Saving starts once the restore has finished (or was skipped): the
    // empty workspace of the first render must not overwrite the store.
    const [sessionReady, setSessionReady] = useState(!isTauri());
    // The other half of what the first paint waits for; see `isReady`.
    const [rootsReady, setRootsReady] = useState(!isTauri());

    // The roots the backend restored from its store (and re-acquired access
    // to, under the sandbox).
    useEffect(() => {
        if (!isTauri()) return;
        listWorkspaceRoots()
            .then(setRoots)
            .catch(error => console.error('Failed to list workspace roots:', error))
            .finally(() => setRootsReady(true));
    }, []);

    // The tabs of the last session. Each available one is opened through the
    // same command a manual open uses, so the cache and the access grants
    // behave as usual; `rememberFile` is not called, so Recent Files keeps
    // its order. A file that is gone, or fails to open, is skipped and named
    // in the notice; the next save drops it from the store. On the free tier
    // the first tabs up to the limit come back and the rest are named too
    // (and never opened in the backend, so no grant or cache for them) —
    // restoring them all would make "never close a tab" a way around the
    // limit.
    useEffect(() => {
        if (!isTauri()) return;
        // StrictMode runs this effect twice in development; only the run
        // that survives may touch the workspace.
        let cancelled = false;
        (async () => {
            const skipped: string[] = [];
            const capped: string[] = [];
            if (restoreOnLaunch.current) {
                try {
                    const session = await listSessionTabs();
                    const limit = tabLimitRef.current;
                    const restored: RestoredTab[] = [];
                    for (const tab of session.tabs) {
                        if (!tab.available) {
                            skipped.push(tab.path);
                            continue;
                        }
                        if (!hasRoomForTab(restored.length, limit)) {
                            capped.push(tab.path);
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
                    dispatch({ type: 'restore', tabs: restored, activePath: session.active, limit });
                } catch (error) {
                    console.error('Failed to restore the last session:', error);
                }
            }
            if (cancelled) return;
            if (skipped.length > 0 || capped.length > 0) setRestoreNotice({ skipped, capped });
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

    /**
     * Push what a close removed onto the reopen history. A group closed at
     * once (Close Others, Close to the Right) goes on back to front, so
     * repeated reopens bring the tabs back left to right, in the order they
     * sat in the bar.
     */
    const rememberClosedTabs = useCallback((closed: readonly ClosedTab[]) => {
        if (closed.length === 0) return;
        setClosedTabs(prev => [...prev, ...[...closed].reverse()].slice(-CLOSED_TAB_HISTORY));
    }, []);

    const handleTabClose = useCallback((tabId: string) => {
        // Whether the file is still shown elsewhere is read from the last
        // render: closes come from user events, never in the same tick as
        // the open that could make this one render stale.
        const { evictPath, closed } = closeTabTransition(workspaceTabsRef.current, tabId);
        dispatch({ type: 'close', tabId });
        rememberClosedTabs(closed);
        if (evictPath) {
            evictCacheQuietly(evictPath);
        }
    }, [rememberClosedTabs]);

    /**
     * Close several tabs in one step — the tab bar's Close Others and Close
     * to the Right. One dispatch, so the active tab is chosen once over the
     * whole set rather than hopping through the tabs on the way out.
     */
    const handleTabsClose = useCallback((tabIds: readonly string[]) => {
        const { evictPaths, closed } = closeTabsTransition(workspaceTabsRef.current, tabIds);
        dispatch({ type: 'closeMany', tabIds });
        rememberClosedTabs(closed);
        for (const path of evictPaths) {
            evictCacheQuietly(path);
        }
    }, [rememberClosedTabs]);

    /**
     * Open `path` in a tab: the free tier's limit first, then the backend.
     * `remember` records the file in Recent Files — every user-initiated
     * open does; the bundled sample is the one file that is not recorded
     * (the Welcome screen links to it, and its bundle path is not one of
     * the user's files).
     */
    const openFile = useCallback(async (path: string, { remember, state }: { remember: boolean; state?: TabState }) => {
        try {
            if (isTauri()) {
                // The free tier's limit, before anything is asked of the
                // backend: the tab is not opened, the prompt says why. A
                // file already in a tab is only activated and needs no room.
                const { tabs: openTabs } = workspaceTabsRef.current;
                if (!openTabs.some(t => t.path === path) && !hasRoomForTab(openTabs.length, tabLimitRef.current)) {
                    showUpgrade();
                    return;
                }

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
                const recent = remember
                    ? await rememberFile(path).catch(error => {
                        console.error('Failed to record the file in Recent Files:', error);
                        return null;
                    })
                    : null;
                if (recent) upsertRecentFile(recent);

                dispatch({
                    type: 'open',
                    tab: { id: newTabId(), path, name: recent?.name ?? getFileName(path) },
                    limit: tabLimitRef.current,
                    state,
                });
            }
            // Browser fallback: there is no backend to open the file with.
        } catch (error) {
            console.error("Failed to open parquet file:", error);
            alert(`Failed to open file: ${error}`);
        }
    }, [upsertRecentFile, removeRecentFile, showUpgrade]);

    const openParquetFile = useCallback((path: string) => openFile(path, { remember: true }), [openFile]);

    /**
     * Reopen the most recently closed tab, on the page and filter it was
     * closed on — ⇧⌘T. Entries for files that are open again are dropped on
     * the way: the user closed one, opened it another way, and asking for
     * the last closed tab then means the one before it. Reopening is an
     * ordinary open, so a missing file and the free tier's limit are handled
     * as they are anywhere else, and Recent Files keeps its order (the file
     * was recorded when it was first opened).
     */
    const reopenClosedTab = useCallback(async () => {
        const openPaths = new Set(workspaceTabsRef.current.tabs.map(t => t.path));
        const history = [...closedTabs];
        let entry: ClosedTab | undefined;
        while ((entry = history.pop())) {
            if (!openPaths.has(entry.path)) break;
        }
        setClosedTabs(history);
        if (!entry) return;
        await openFile(entry.path, { remember: false, state: entry.state });
    }, [closedTabs, openFile]);

    const openSampleFile = useCallback(async () => {
        if (!isTauri()) {
            alert("The sample file is only available in the desktop app. Please drag and drop a file instead.");
            return;
        }
        // Locating the sample opens nothing; the limit is checked against
        // its path in openFile, so a sample already in a tab is activated
        // rather than refused.
        let path: string;
        try {
            path = await sampleFilePath();
        } catch (error) {
            console.error('Failed to locate the sample file:', error);
            alert(`Failed to open the sample file: ${error}`);
            return;
        }
        await openFile(path, { remember: false });
    }, [openFile]);

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

    /**
     * One entry for every shortcut and menu item, by its id in
     * `lib/shortcuts.ts`. What the workspace owns is done here; a view's
     * command (search, run the query, the Content / Query switch) goes out
     * on the app-command bus for the active view to answer. Unknown ids —
     * a menu item that is not a shortcut, like Help — are handled by name.
     */
    const runCommand = useCallback((id: string) => {
        switch (id) {
            case 'open-file': openFileDialog(); break;
            case 'open-folder': openFolderDialog(); break;
            case 'settings': setIsSettingsOpen(true); break;
            case 'close-tab': if (activeTabId) handleTabClose(activeTabId); break;
            case 'reopen-tab': reopenClosedTab(); break;
            case 'next-tab': {
                const target = adjacentTabId(workspaceTabs, 1);
                if (target) handleTabSelect(target);
                break;
            }
            case 'previous-tab': {
                const target = adjacentTabId(workspaceTabs, -1);
                if (target) handleTabSelect(target);
                break;
            }
            case 'toggle-sidebar': setIsSidebarOpen(prev => !prev); break;
            case 'shortcuts': setIsShortcutsOpen(prev => !prev); break;
            case 'help':
                openUrl(i18n.language === 'ja' ? SUPPORT_URL_JA : SUPPORT_URL)
                    .catch(error => console.error('Failed to open the support page:', error));
                break;
            default:
                if (isAppCommand(id)) dispatchAppCommand(id);
        }
    }, [activeTabId, workspaceTabs, handleTabClose, handleTabSelect, openFileDialog, openFolderDialog, reopenClosedTab]);

    // Keyboard shortcuts. On macOS the native menu owns every key it lists
    // and forwards them as `menu` events (below) — a native key equivalent
    // wins over the webview's keydown; this handler covers the rest (⌘1…9)
    // and, in the browser and on any platform without that menu, all of
    // them.
    useGlobalKeydown(useCallback((e: KeyboardEvent) => {
        const n = matchGoToTab(e);
        if (n !== null) {
            e.preventDefault();
            const target = nthTabId(workspaceTabs, n);
            if (target) handleTabSelect(target);
            return;
        }
        const id = matchShortcut(e);
        if (id) {
            e.preventDefault();
            runCommand(id);
        }
    }, [workspaceTabs, handleTabSelect, runCommand]));

    // Native menu items (see build_menu in lib.rs)
    useEffect(() => {
        if (!isTauri()) return;
        const unlisten = listen<string>('menu', (event) => runCommand(event.payload));
        return () => {
            unlisten.then(fn => fn());
        };
    }, [runCommand]);

    /**
     * Files the app is handed from outside the window: dropped on it, and
     * opened from Finder, the Dock or `open -a` — both arrive as `file-drop`
     * (see `deliver_opened` in lib.rs).
     *
     * Each goes through `openParquetFile`, so on the free tier the files
     * that fit open and the first one that does not brings up the upgrade
     * prompt (once: it is one dialog, however many were dropped).
     */
    const openExternalFiles = useCallback(async (paths: string[]) => {
        if (paths.length === 0) return;
        const parquetFiles = paths.filter(isParquetPath);
        if (parquetFiles.length === 0) {
            alert('Parqsee can only open .parquet files');
            return;
        }
        // Every file gets a tab; the last one opened is the active one.
        for (const file of parquetFiles) {
            await openParquetFile(file);
        }
    }, [openParquetFile]);
    // Read by the listener below, which is registered once: re-registering
    // it whenever the callback changes would reopen a window in which a file
    // handed over by Finder is lost.
    const openExternalFilesRef = useRef(openExternalFiles);
    useEffect(() => {
        openExternalFilesRef.current = openExternalFiles;
    }, [openExternalFiles]);

    // Drops and files opened from Finder while the app runs.
    const [dropListenerReady, setDropListenerReady] = useState(!isTauri());
    useEffect(() => {
        if (!isTauri()) return;
        const listening = listen<string[] | null>('file-drop', event => {
            openExternalFilesRef.current(event.payload ?? []);
        });
        listening.then(() => setDropListenerReady(true));
        return () => {
            listening.then(fn => fn());
        };
    }, []);

    // The files Finder handed the app at launch, before the listener above
    // existed. Asked for once, and only after two things: the listener is
    // registered (the backend emits instead of buffering from the moment of
    // this call, and an open arriving in between would be lost), and the
    // session restore has finished (so the file is opened last and stays the
    // active tab rather than being pushed behind the restored ones).
    const pendingAsked = useRef(false);
    useEffect(() => {
        if (!isTauri() || !dropListenerReady || !sessionReady || pendingAsked.current) return;
        pendingAsked.current = true;
        takePendingFiles()
            .then(paths => openExternalFilesRef.current(paths))
            .catch(error => console.error('Failed to read the files to open:', error));
    }, [dropListenerReady, sessionReady]);

    const activeTab = activeTabOf(workspaceTabs);
    const canReopenClosedTab = closedTabs.some(entry => !tabs.some(tab => tab.path === entry.path));

    const value = {
        currentFile: activeTab?.path ?? null,
        tabs,
        activeTabId,
        isSidebarOpen,
        isSettingsOpen,
        isShortcutsOpen,
        isPending,
        tabStates,
        roots,
        openParquetFile,
        openSampleFile,
        openFileDialog,
        openFolderDialog,
        removeWorkspaceRoot,
        closeTab: handleTabClose,
        closeTabs: handleTabsClose,
        reopenClosedTab,
        canReopenClosedTab,
        selectTab: handleTabSelect,
        toggleSidebar: () => setIsSidebarOpen(prev => !prev),
        toggleSettings: setIsSettingsOpen,
        toggleShortcuts: setIsShortcutsOpen,
        setTabState: (tabId: string, patch: Partial<TabState>) => dispatch({ type: 'patchState', tabId, patch }),
        activeTab,
        isReady: rootsReady && sessionReady,
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
