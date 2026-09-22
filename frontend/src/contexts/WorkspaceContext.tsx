import { useState, useCallback, useEffect, useRef, useReducer, useTransition, ReactNode } from 'react';
import { createRequiredContext } from '../lib/required-context';
import { open } from '@tauri-apps/plugin-dialog';
import { useRecentFiles } from './RecentFilesContext';
import { useSettings } from './SettingsContext';
import { useLicense } from './LicenseContext';
import { isTauri } from '../lib/tauri';
import { useTauriEvent } from '../hooks/useTauriEvent';
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
    SessionTab,
} from '../features/workspace/api';
import { createSessionSaver, type SessionSaver } from './session-saver';
import {
    Tab,
    ClosedTab,
    WorkspaceTabs,
    RestoredTab,
    EMPTY_WORKSPACE_TABS,
    reduceWorkspaceTabs,
    closeTab as closeTabTransition,
    closeTabs as closeTabsTransition,
    restoreTabsTransition,
    activeTab as activeTabOf,
    adjacentTabId,
    nthTabId,
    sessionSnapshot,
    restoredTabState,
    hasRoomForTab,
    TabLimit,
    WorkspaceTabsAction,
} from './workspace-tabs';

export type { Tab, WorkspaceRoot };

/** What of the last session did not come back at launch. */
export interface RestoreNotice {
    /** The files that could not be reopened (gone, or failed to open). */
    skipped: string[];
    /**
     * The tabs left out because the free tier's limit was reached. They
     * come back on their own when the limit lifts (see `cappedTabs`).
     */
    capped: string[];
}

/**
 * What became of a request to open a file. `activated` is a file that
 * already had a tab, `refused` the free tier's limit turning it away, and
 * `missing` a file that is not there any more — the two the caller has to
 * tell apart when it holds something on the file's behalf, since a refusal
 * is worth waiting out and a missing file is not.
 */
type OpenOutcome = 'opened' | 'activated' | 'refused' | 'missing' | 'failed';

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
    /**
     * Evict what the backend holds for `path` unless a tab shows it. For a
     * viewer whose read landed after its tab was closed: the read could not
     * be taken back, and it re-created the file's session and re-took its
     * access grant on the way out. This is the close those missed, after
     * the fact. A file that has a tab again is left alone — that tab's own
     * close will evict it.
     */
    evictIfClosed: (path: string) => void;
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
    /** Latest session remains unsaved; retry explicitly or on pagehide. */
    sessionSaveFailed: boolean;
    retrySessionSave: () => void;
}

const [WorkspaceContext, useWorkspace] = createRequiredContext<WorkspaceContextType>('Workspace');

/** How many closed tabs ⇧⌘T can walk back through. */
const CLOSED_TAB_HISTORY = 10;

/** Help › Parqsee Help: the support page of the product site, in the UI's language. */
const SUPPORT_URL = 'https://parqsee.fuji.llc/support.html';
const SUPPORT_URL_JA = 'https://parqsee.fuji.llc/ja/support.html';

let nextTabSerial = 0;
/**
 * Unique for the session, which is all a tab id is used for: the reducer
 * finds tabs by it and nothing persists it (the saved session records
 * paths). A serial, not the clock: `Date.now()` gave two files opened in
 * one tick the same id.
 */
const newTabId = () => `tab-${nextTabSerial++}`;

/**
 * Open one tab of the saved session and turn it into the entry the restore
 * dispatches, or null when the file will not open any more.
 *
 * The open goes through the same command a manual open uses, so the cache
 * and the access grants behave as usual, and `rememberFile` is deliberately
 * not called — Recent Files keeps the order it had. A file that fails here
 * is named in the restore notice like one that was already gone, and the
 * next save drops it from the store.
 */
async function openRestoredTab(tab: SessionTab): Promise<RestoredTab | null> {
    try {
        await apiOpenParquetFile(tab.path);
    } catch (error) {
        console.error(`Failed to reopen ${tab.path} from the last session:`, error);
        return null;
    }
    return {
        tab: { id: newTabId(), path: tab.path, name: tab.name },
        state: restoredTabState(tab.state),
    };
}

/**
 * Replay a list of saved tabs: open each one that is still there and there
 * is room for, and say what became of the rest.
 *
 * Both restores go through this — the one at launch and the one that
 * follows the free tier's limit lifting — and the free tier is why the
 * room is checked between the opens rather than before them: a file that
 * will not open any more must not spend a slot the next tab could have
 * had, and a file the user opens meanwhile takes one. `openCount` is read
 * again before every open for that second reason: the drop listener is
 * live from the first render, so tabs can appear while this runs, and
 * counting only the tabs restored so far would open more files than the
 * workspace can seat. The second restore passes no limit because by then
 * there is none, and its tabs were already found available by the first.
 */
async function replayTabs(
    tabs: readonly SessionTab[],
    limit: TabLimit,
    openCount: () => number,
): Promise<{ restored: RestoredTab[]; skipped: string[]; capped: SessionTab[] }> {
    const restored: RestoredTab[] = [];
    const skipped: string[] = [];
    const capped: SessionTab[] = [];
    for (const tab of tabs) {
        if (!tab.available) {
            skipped.push(tab.path);
            continue;
        }
        if (!hasRoomForTab(openCount() + restored.length, limit)) {
            capped.push(tab);
            continue;
        }
        const opened = await openRestoredTab(tab);
        if (opened) restored.push(opened);
        else skipped.push(tab.path);
    }
    return { restored, skipped, capped };
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    // Every transition goes through the reducer, so files opened back to back
    // in one tick (a multi-file drop) and a closeTab captured by a memoized
    // child both act on the latest tabs rather than on a stale snapshot.
    const [workspaceTabs, dispatchTabs] = useReducer(reduceWorkspaceTabs, EMPTY_WORKSPACE_TABS);
    const { tabs, activeTabId, tabStates } = workspaceTabs;
    // The tabs closed in this session, newest last, capped: what ⇧⌘T and
    // the tab menu's Reopen give back. Not persisted — a relaunch restores
    // the tabs that were open, and undoing a close from before it would be
    // undoing something the user cannot see any more.
    const [closedTabs, setClosedTabs] = useState<readonly ClosedTab[]>([]);
    // The tabs as of the last dispatch, for decisions made in stable
    // callbacks between renders. The reducer is pure, so applying each
    // action here as it is dispatched gives exactly the state React will
    // render for it — and gives it at once, where a copy of the rendered
    // state would lag until the next render: two files opening in the same
    // tick (a multi-file drop) would both count the tabs before either
    // was added. Written from callbacks, never during render.
    const workspaceTabsRef = useRef(workspaceTabs);
    const dispatch = useCallback((action: WorkspaceTabsAction) => {
        workspaceTabsRef.current = reduceWorkspaceTabs(workspaceTabsRef.current, action);
        dispatchTabs(action);
    }, []);
    // The files being opened right now, by path: reserved against the free
    // tier's limit until the open lands in the tabs or fails, so that two
    // files opened into one remaining slot cannot both pass the check and
    // both be opened in the backend (CT-04). A second request for a path in
    // flight waits for the first and activates the tab it made.
    const openingFiles = useRef(new Map<string, Promise<OpenOutcome>>());
    const [isPending, startTransition] = useTransition();
    const { upsertRecentFile, refreshRecentFiles } = useRecentFiles();
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
    // The session tabs the free tier left out at launch, with their saved
    // state, kept until the limit lifts — a purchase, Restore Purchases,
    // or the launch-time read of the store landing after `iap_status`
    // gave up waiting for it and answered the free tier (`LicenseProvider`
    // takes the late read from the `iap-status` event). They are then
    // opened as the rest of the session was. Only in memory: the next save
    // keeps what is open, so a quit before the limit lifts drops them.
    const cappedTabs = useRef<SessionTab[]>([]);
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

    // The tabs of the last session, each opened by `openRestoredTab`. A file
    // that is gone is skipped and named in the notice without being opened
    // at all. On the free tier the tabs that fit beside whatever is already
    // open come back and the rest are named too (and never opened in the
    // backend, so no grant or cache for them) — restoring them all would
    // make "never close a tab" a way around the limit.
    useEffect(() => {
        if (!isTauri()) return;
        // StrictMode runs this effect twice in development; only the run
        // that survives may touch the workspace.
        let cancelled = false;
        (async () => {
            let skipped: string[] = [];
            let capped: SessionTab[] = [];
            if (restoreOnLaunch.current) {
                try {
                    const session = await listSessionTabs();
                    const limit = tabLimitRef.current;
                    const openCount = () => workspaceTabsRef.current.tabs.length;
                    const replayed = await replayTabs(session.tabs, limit, openCount);
                    ({ skipped, capped } = replayed);
                    if (cancelled) return;
                    // A file opened between the last room check and here —
                    // a drop lands in one tick, the open before it took
                    // several — leaves a restored file with no seat. The
                    // reducer cannot say which from inside a dispatch, so
                    // the same transition is run over the state it will
                    // act on: what it could not seat was opened in the
                    // backend and is given back here, cache and grant and
                    // all, and named with the rest of the capped tabs.
                    const { dropped } = restoreTabsTransition(workspaceTabsRef.current, replayed.restored, session.active, limit);
                    dispatch({ type: 'restore', tabs: replayed.restored, activePath: session.active, limit });
                    for (const { tab } of dropped) evictCacheQuietly(tab.path);
                    if (dropped.length > 0) {
                        // In the order the session had them, whichever end
                        // of the restore left them out.
                        const cappedPaths = new Set([...capped.map(t => t.path), ...dropped.map(d => d.tab.path)]);
                        capped = session.tabs.filter(t => cappedPaths.has(t.path));
                    }
                } catch (error) {
                    console.error('Failed to restore the last session:', error);
                }
            }
            if (cancelled) return;
            cappedTabs.current = capped;
            if (skipped.length > 0 || capped.length > 0) setRestoreNotice({ skipped, capped: capped.map(t => t.path) });
            setSessionReady(true);
        })();
        return () => {
            cancelled = true;
        };
    }, [dispatch]);

    // The limit lifted: the tabs it left out at launch come back, opened as
    // the restore opened the others. The active tab stays; the capped part
    // of the notice goes.
    useEffect(() => {
        if (tabLimit !== null || !sessionReady || cappedTabs.current.length === 0) return;
        const leftOut = cappedTabs.current;
        cappedTabs.current = [];
        let cancelled = false;
        (async () => {
            // No limit left to check: this effect only runs once it lifted.
            const { restored, skipped } = await replayTabs(leftOut, null, () => workspaceTabsRef.current.tabs.length);
            if (cancelled) return;
            dispatch({ type: 'restore', tabs: restored, activePath: null });
            setRestoreNotice(notice => {
                const stillSkipped = [...(notice?.skipped ?? []), ...skipped];
                const stillCapped = (notice?.capped ?? []).filter(path => !leftOut.some(t => t.path === path));
                return stillSkipped.length > 0 || stillCapped.length > 0 ? { skipped: stillSkipped, capped: stillCapped } : null;
            });
        })();
        return () => {
            cancelled = true;
        };
    }, [tabLimit, sessionReady, dispatch]);

    // The debounce, the serializing of writes and the flush on the way out
    // live in `createSessionSaver`; what is left here is when to hand it a
    // snapshot. It is made once: the saver holds the pending write, and a
    // second one would write the same tabs twice.
    const [sessionSaveFailed, setSessionSaveFailed] = useState(false);
    const saverRef = useRef<SessionSaver | null>(null);
    if (saverRef.current === null) {
        saverRef.current = createSessionSaver({
            save: snapshot => saveSession(snapshot.tabs, snapshot.active),
            delayMs: SESSION_SAVE_DELAY_MS,
            onFailed: setSessionSaveFailed,
        });
    }
    const saver = saverRef.current;
    const flushSession = useCallback(() => saver.flush(), [saver]);
    useEffect(() => {
        if (!isTauri() || !sessionReady) return;
        saver.schedule(sessionSnapshot(workspaceTabs));
    }, [workspaceTabs, sessionReady, saver]);
    // The window going away is the one change that cannot wait.
    useEffect(() => {
        window.addEventListener('pagehide', flushSession);
        return () => window.removeEventListener('pagehide', flushSession);
    }, [flushSession]);
    // Nor can the provider going away: a save still pending on unmount is
    // written now instead of firing later from a provider that no longer
    // exists (in the app `pagehide` has already flushed it; in tests the
    // stray write would land in the next test).
    useEffect(() => () => flushSession(), [flushSession]);


    const handleTabSelect = useCallback((tabId: string) => {
        requestAnimationFrame(() => {
            startTransition(() => {
                dispatch({ type: 'select', tabId });
            });
        });
    }, [dispatch]);

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
        const { evictPath, closed } = closeTabTransition(workspaceTabsRef.current, tabId);
        dispatch({ type: 'close', tabId });
        rememberClosedTabs(closed);
        if (evictPath) {
            evictCacheQuietly(evictPath);
        }
    }, [dispatch, rememberClosedTabs]);

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
    }, [dispatch, rememberClosedTabs]);

    const evictIfClosed = useCallback((path: string) => {
        if (!workspaceTabsRef.current.tabs.some(t => t.path === path)) evictCacheQuietly(path);
    }, []);

    /**
     * Open `path` in a tab: the free tier's limit first, then the backend.
     * `remember` records the file in Recent Files — every user-initiated
     * open does; the bundled sample is the one file that is not recorded
     * (the Welcome screen links to it, and its bundle path is not one of
     * the user's files).
     *
     * The limit is checked against the tabs as of the last dispatch plus
     * the opens still in flight, and the file's slot is held for as long
     * as its open runs: files handed over together (a multi-file drop)
     * start before any of them has a tab, and without the reservation the
     * ones past the limit would be opened in the backend — cache, access
     * grant, Recent Files entry — and then refused a tab by the reducer,
     * leaving them where nothing could close them. A request for a file
     * whose open is in flight is the same request twice: it waits for the
     * first and activates the tab that made.
     *
     * It never rejects: a failure is reported to the user with an alert
     * and the promise resolves with what became of the request, so a
     * caller only has to wait for it. Most of them ignore the answer —
     * they are event handlers and a loop over the files of a drop, and an
     * uncaught error would become an unhandled rejection or leave the
     * files behind it unopened. ⇧⌘T is the one that reads it, to tell a
     * refusal it should hold the tab for from a file that is gone.
     */
    const openFile = useCallback(async (path: string, { remember, state }: { remember: boolean; state?: TabState }): Promise<OpenOutcome> => {
        if (!isTauri()) return 'failed'; // Browser fallback: there is no backend to open the file with.

        const inFlight = openingFiles.current.get(path);
        if (inFlight) {
            // Only waiting: the request that started the open reports its
            // own failure, and handing it on here would break this promise
            // too — no caller of an open catches one.
            try { await inFlight; } catch { /* reported by the first request */ }
            const existing = workspaceTabsRef.current.tabs.find(t => t.path === path);
            // No tab: the first request failed and said so; nothing to add.
            if (!existing) return 'failed';
            dispatch({ type: 'select', tabId: existing.id });
            return 'activated';
        }

        // The free tier's limit, before anything is asked of the backend:
        // the tab is not opened, the prompt says why. A file already in a
        // tab is only activated and needs no room, nor does an open in
        // flight for one.
        const { tabs: openTabs } = workspaceTabsRef.current;
        const isOpen = (candidate: string) => openTabs.some(t => t.path === candidate);
        if (!isOpen(path)) {
            const reserved = [...openingFiles.current.keys()].filter(p => !isOpen(p)).length;
            if (!hasRoomForTab(openTabs.length + reserved, tabLimitRef.current)) {
                showUpgrade();
                return 'refused';
            }
        }

        const opening = (async (): Promise<OpenOutcome> => {
            const fileExists = await checkFileExists(path);
            if (!fileExists) {
                // The file stays in Recent Files. `check_file_exists` cannot
                // tell a file that is gone from one that is out of reach for
                // now — an external drive not plugged in, a share not
                // mounted — and under the sandbox a dropped entry takes the
                // bookmark with it, so the file could only come back through
                // the open dialog. The list is asked for again so the entry
                // shows as unavailable; each row has its own ✕ for the user
                // who knows the file is gone for good.
                refreshRecentFiles();
                alert(i18n.t('common.fileUnreachable', { path }));
                return 'missing';
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
            // The reducer's backstop refused the tab — the limit came back
            // (a refund) while the file was opening. What the backend holds
            // for a file no tab shows goes now, since no close will ever
            // ask for it, and the prompt says why there is no tab.
            if (!workspaceTabsRef.current.tabs.some(t => t.path === path)) {
                evictCacheQuietly(path);
                showUpgrade();
                return 'refused';
            }
            return isOpen(path) ? 'activated' : 'opened';
        })();
        openingFiles.current.set(path, opening);
        try {
            return await opening;
        } catch (error) {
            console.error("Failed to open parquet file:", error);
            alert(`Failed to open file: ${error}`);
            return 'failed';
        } finally {
            openingFiles.current.delete(path);
        }
    }, [dispatch, upsertRecentFile, refreshRecentFiles, showUpgrade]);

    const openParquetFile = useCallback(async (path: string) => {
        await openFile(path, { remember: true });
    }, [openFile]);

    /**
     * Reopen the most recently closed tab, on the page and filter it was
     * closed on — ⇧⌘T. Entries for files that are open again are dropped on
     * the way: the user closed one, opened it another way, and asking for
     * the last closed tab then means the one before it. Reopening is an
     * ordinary open, so a missing file and the free tier's limit are handled
     * as they are anywhere else, and Recent Files keeps its order (the file
     * was recorded when it was first opened).
     *
     * An entry is taken off the history before the open and put back when
     * the free tier turned the file away: the prompt was the answer to this
     * ⇧⌘T, and the tab is still the last one closed — it comes back on the
     * next ⇧⌘T once a tab closes or the limit lifts. A file that is gone
     * stays off: `openFile` dropped it from Recent Files and said so, and
     * the next ⇧⌘T means the tab before it, not the same alert again.
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
        const reopening = entry;
        const outcome = await openFile(reopening.path, { remember: false, state: reopening.state });
        if (outcome === 'refused') setClosedTabs(prev => [...prev, reopening]);
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

    // Native menu items (see build_menu in lib.rs).
    useTauriEvent<string>('menu', runCommand);

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
        // `openParquetFile` reports its own failures and resolves; the
        // catch is the belt to that contract's braces, so that one file
        // can never keep the ones after it from opening.
        for (const file of parquetFiles) {
            await openParquetFile(file).catch(error => console.error('Failed to open', file, error));
        }
    }, [openParquetFile]);
    // Drops and files opened from Finder while the app runs.
    const dropListenerReady = useTauriEvent<string[] | null>('file-drop', paths => {
        openExternalFiles(paths ?? []);
    });

    // The launch handover below fires once and then awaits the backend, so
    // it reads the callback through a ref: the tabs it opens against are the
    // ones the finished restore left, not the ones of the render that armed
    // the effect.
    const openExternalFilesRef = useRef(openExternalFiles);
    useEffect(() => {
        openExternalFilesRef.current = openExternalFiles;
    }, [openExternalFiles]);

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
        evictIfClosed,
        reopenClosedTab,
        canReopenClosedTab,
        selectTab: handleTabSelect,
        toggleSidebar: () => setIsSidebarOpen(prev => !prev),
        toggleSettings: setIsSettingsOpen,
        toggleShortcuts: setIsShortcutsOpen,
        setTabState: (tabId: string, patch: Partial<TabState>) => dispatch({ type: 'patchState', tabId, patch }),
        activeTab,
        isReady: rootsReady && sessionReady,
        sessionSaveFailed,
        retrySessionSave: flushSession,
        restoreNotice,
        dismissRestoreNotice: () => setRestoreNotice(null),
    };

    return (
        <WorkspaceContext.Provider value={value}>
            {children}
        </WorkspaceContext.Provider>
    );
}

export { useWorkspace };
