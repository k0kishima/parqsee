import type { TabState } from '../features/file-viewer';
import type { SessionTab } from '../bindings/ipc/SessionTab';
import type { SessionTabInput } from '../bindings/ipc/SessionTabInput';
import type { SessionTabState } from '../bindings/ipc/SessionTabState';
import { assertNever } from '../lib/exhaustive';

export interface Tab {
  id: string;
  path: string;
  name: string;
}

/**
 * The open tabs, which one is active and the per-tab view state. Kept in one
 * value and only ever replaced as a whole: the tab list and the active tab
 * change together, and a tab's state lives exactly as long as the tab.
 */
export interface WorkspaceTabs {
  readonly tabs: readonly Tab[];
  readonly activeTabId: string | null;
  readonly tabStates: Readonly<Record<string, TabState>>;
}

export const EMPTY_WORKSPACE_TABS: WorkspaceTabs = { tabs: [], activeTabId: null, tabStates: {} };

/** A tab reopened from the last session, with the state it was saved with. */
export interface RestoredTab {
  tab: Tab;
  state: TabState;
}

export type WorkspaceTabsAction =
  | { type: 'open'; tab: Tab }
  | { type: 'close'; tabId: string }
  | { type: 'select'; tabId: string }
  | { type: 'patchState'; tabId: string; patch: Partial<TabState> }
  | { type: 'restore'; tabs: RestoredTab[]; activePath: string | null };

export function reduceWorkspaceTabs(state: WorkspaceTabs, action: WorkspaceTabsAction): WorkspaceTabs {
  switch (action.type) {
    case 'open': return openTab(state, action.tab);
    case 'close': return closeTab(state, action.tabId).state;
    case 'select': return selectTab(state, action.tabId);
    case 'patchState': return patchTabState(state, action.tabId, action.patch);
    case 'restore': return restoreTabs(state, action.tabs, action.activePath);
    default: return assertNever(action, 'workspace tabs action');
  }
}

/** Activate the tab showing `tab.path`, adding `tab` if no tab shows it yet. */
export function openTab(state: WorkspaceTabs, tab: Tab): WorkspaceTabs {
  const existing = state.tabs.find(t => t.path === tab.path);
  if (existing) return { ...state, activeTabId: existing.id };
  return { ...state, tabs: [...state.tabs, tab], activeTabId: tab.id };
}

/**
 * Remove the tab. When it was the active one, the tab that took its place
 * (or the new last tab) becomes active. `evictPath` is the closed file when
 * no other tab shows it any more, so the caller can drop its backend cache.
 */
export function closeTab(state: WorkspaceTabs, tabId: string): { state: WorkspaceTabs; evictPath: string | null } {
  const index = state.tabs.findIndex(t => t.id === tabId);
  if (index === -1) return { state, evictPath: null };
  const closed = state.tabs[index];
  const tabs = state.tabs.filter(t => t.id !== tabId);
  const { [tabId]: _closedState, ...tabStates } = state.tabStates;

  const activeTabId = state.activeTabId !== tabId
    ? state.activeTabId
    : tabs.length > 0 ? tabs[Math.min(index, tabs.length - 1)].id : null;
  const evictPath = tabs.some(t => t.path === closed.path) ? null : closed.path;

  return { state: { tabs, activeTabId, tabStates }, evictPath };
}

/** Make `tabId` active; an id that is not open leaves the state as it is. */
export function selectTab(state: WorkspaceTabs, tabId: string): WorkspaceTabs {
  if (state.activeTabId === tabId || !state.tabs.some(t => t.id === tabId)) return state;
  return { ...state, activeTabId: tabId };
}

/**
 * Merge `patch` into the tab's state. Writers only send the fields they own
 * (the tab its view mode, the grid its page and filter), so a patch never
 * clobbers what another writer stored.
 */
export function patchTabState(state: WorkspaceTabs, tabId: string, patch: Partial<TabState>): WorkspaceTabs {
  return { ...state, tabStates: { ...state.tabStates, [tabId]: { ...state.tabStates[tabId], ...patch } } };
}

export function activeTab(state: WorkspaceTabs): Tab | undefined {
  return state.tabs.find(t => t.id === state.activeTabId);
}

/** The tab `direction` steps from the active one, wrapping around the ends. */
export function adjacentTabId(state: WorkspaceTabs, direction: 1 | -1): string | null {
  const count = state.tabs.length;
  if (count === 0) return null;
  const current = state.tabs.findIndex(t => t.id === state.activeTabId);
  // No active tab: step from just outside the list, so the first or last tab.
  const from = current === -1 ? (direction === 1 ? -1 : count) : current;
  return state.tabs[(from + direction + count) % count].id;
}

/** The tab at 1-based position `n`, as for the ⌘1 … ⌘9 shortcuts. */
export function nthTabId(state: WorkspaceTabs, n: number): string | null {
  return state.tabs[n - 1]?.id ?? null;
}

/**
 * Append the tabs of the last session, each with its saved state, and
 * activate the one at `activePath`. A file the user opened meanwhile (a
 * drop during the restore) keeps its tab and its state; with no active
 * path among the tabs, the current active tab stays, or the first restored
 * one when there is none.
 */
export function restoreTabs(state: WorkspaceTabs, restored: readonly RestoredTab[], activePath: string | null): WorkspaceTabs {
  const tabs = [...state.tabs];
  const tabStates = { ...state.tabStates };
  for (const { tab, state: tabState } of restored) {
    if (tabs.some(t => t.path === tab.path)) continue;
    tabs.push(tab);
    tabStates[tab.id] = tabState;
  }
  const active = tabs.find(t => t.path === activePath)?.id ?? state.activeTabId ?? tabs[0]?.id ?? null;
  return { tabs, activeTabId: active, tabStates };
}

/** What of the workspace is written to the backend's session store. */
export interface SessionSnapshot {
  tabs: SessionTabInput[];
  active: string | null;
}

/**
 * The tabs in order, the active one's path and, per tab, the state worth
 * keeping across a relaunch: view mode, page and filter. Search, selection
 * and scroll are left out — they are transient, and leaving them out also
 * keeps them from triggering a save.
 */
export function sessionSnapshot(state: WorkspaceTabs): SessionSnapshot {
  return {
    tabs: state.tabs.map(tab => ({ path: tab.path, state: persistedTabState(state.tabStates[tab.id]) })),
    active: activeTab(state)?.path ?? null,
  };
}

function persistedTabState(state: TabState | undefined): SessionTabState {
  return {
    view_mode: state?.viewMode ?? null,
    current_page: state?.currentPage ?? null,
    // The grid's "no filter" is the empty string.
    active_filter: state?.activeFilter || null,
  };
}

/**
 * The state to reopen a session tab with. Anything the saved store could
 * not have meant (a page below 1, an unknown view mode) is left to the
 * tab's own default rather than passed through.
 */
export function restoredTabState(saved: SessionTab['state']): TabState {
  const state: TabState = {};
  if (saved.view_mode === 'browse' || saved.view_mode === 'query') state.viewMode = saved.view_mode;
  if (typeof saved.current_page === 'number' && Number.isInteger(saved.current_page) && saved.current_page >= 1) {
    state.currentPage = saved.current_page;
  }
  if (typeof saved.active_filter === 'string' && saved.active_filter !== '') state.activeFilter = saved.active_filter;
  return state;
}
