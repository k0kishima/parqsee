import { describe, it, expect } from 'vitest';
import {
  EMPTY_WORKSPACE_TABS,
  WorkspaceTabs,
  openTab,
  closeTab,
  closeTabs,
  otherTabIds,
  tabIdsAfter,
  selectTab,
  patchTabState,
  adjacentTabId,
  nthTabId,
  reduceWorkspaceTabs,
  restoreTabs,
  sessionSnapshot,
  restoredTabState,
} from '../workspace-tabs';

const tab = (id: string, path = `/data/${id}.parquet`) => ({ id, path, name: `${id}.parquet` });

const three: WorkspaceTabs = {
  tabs: [tab('a'), tab('b'), tab('c')],
  activeTabId: 'b',
  tabStates: { a: { currentPage: 2 }, b: { viewMode: 'query' } },
};

describe('openTab', () => {
  it('appends and activates a tab for a new file', () => {
    const next = openTab(three, tab('d'));
    expect(next.tabs.map(t => t.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(next.activeTabId).toBe('d');
  });

  it('adds nothing past the limit, and still activates a tab already showing the file', () => {
    expect(openTab(three, tab('d'), 3)).toBe(three);
    expect(openTab(three, tab('d'), 4).tabs).toHaveLength(4);
    expect(openTab(three, tab('d'), null).tabs).toHaveLength(4);
    expect(openTab(three, tab('x', '/data/a.parquet'), 3).activeTabId).toBe('a');
  });

  it('activates the tab already showing the file instead of adding one', () => {
    const next = openTab(three, tab('x', '/data/a.parquet'));
    expect(next.tabs).toBe(three.tabs);
    expect(next.activeTabId).toBe('a');
  });
});

describe('closeTab', () => {
  it('activates the tab that moved into the closed slot', () => {
    const { state } = closeTab(three, 'b');
    expect(state.tabs.map(t => t.id)).toEqual(['a', 'c']);
    expect(state.activeTabId).toBe('c');
  });

  it('activates the new last tab when the last one was active', () => {
    const { state } = closeTab({ ...three, activeTabId: 'c' }, 'c');
    expect(state.activeTabId).toBe('b');
  });

  it('keeps the active tab when another one is closed', () => {
    const { state } = closeTab(three, 'a');
    expect(state.activeTabId).toBe('b');
  });

  it('drops the closed tab\'s state and nothing else', () => {
    const { state } = closeTab(three, 'b');
    expect(state.tabStates).toEqual({ a: { currentPage: 2 } });
  });

  it('reports the file for eviction only when no other tab shows it', () => {
    const shared: WorkspaceTabs = { ...three, tabs: [...three.tabs, tab('a2', '/data/a.parquet')] };
    expect(closeTab(shared, 'a').evictPath).toBeNull();
    expect(closeTab(three, 'a').evictPath).toBe('/data/a.parquet');
  });

  it('leaves everything alone for an unknown id', () => {
    expect(closeTab(three, 'zzz')).toEqual({ state: three, evictPath: null });
  });

  it('ends with no active tab when the last tab goes', () => {
    const { state } = closeTab({ ...EMPTY_WORKSPACE_TABS, tabs: [tab('a')], activeTabId: 'a' }, 'a');
    expect(state).toEqual(EMPTY_WORKSPACE_TABS);
  });
});

describe('closeTabs', () => {
  const five: WorkspaceTabs = {
    tabs: [tab('a'), tab('b'), tab('c'), tab('d'), tab('e')],
    activeTabId: 'b',
    tabStates: { a: { currentPage: 2 }, d: { viewMode: 'query' } },
  };

  it('closes the others and leaves the tab the menu was opened on active', () => {
    const { state } = closeTabs(five, otherTabIds(five, 'd'));
    expect(state.tabs.map(t => t.id)).toEqual(['d']);
    expect(state.activeTabId).toBe('d');
    expect(state.tabStates).toEqual({ d: { viewMode: 'query' } });
  });

  it('closes the tabs to the right and keeps the active one when it survives', () => {
    const { state } = closeTabs(five, tabIdsAfter(five, 'c'));
    expect(state.tabs.map(t => t.id)).toEqual(['a', 'b', 'c']);
    expect(state.activeTabId).toBe('b');
  });

  it('falls back to the last surviving tab when the active one had no tab left to its right', () => {
    const { state } = closeTabs({ ...five, activeTabId: 'e' }, tabIdsAfter(five, 'c'));
    expect(state.activeTabId).toBe('c');
  });

  it('activates the nearest surviving tab to the right of the closed active one', () => {
    const { state } = closeTabs(five, ['b', 'c']);
    expect(state.activeTabId).toBe('d');
  });

  it('reports each closed file once, and only when no remaining tab shows it', () => {
    const shared: WorkspaceTabs = { ...five, tabs: [...five.tabs, tab('a2', '/data/a.parquet')] };
    const { evictPaths } = closeTabs(shared, ['a', 'a2', 'b']);
    expect(evictPaths).toEqual(['/data/a.parquet', '/data/b.parquet']);
    expect(closeTabs(shared, ['a']).evictPaths).toEqual([]);
  });

  it('ignores ids that are not open and returns the same state when none are', () => {
    expect(closeTabs(five, ['zzz'])).toEqual({ state: five, evictPaths: [] });
    expect(closeTabs(five, ['zzz']).state).toBe(five);
    expect(closeTabs(five, ['a', 'zzz']).state.tabs.map(t => t.id)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('ends with no active tab when every tab goes', () => {
    expect(closeTabs(five, five.tabs.map(t => t.id)).state).toEqual(EMPTY_WORKSPACE_TABS);
  });
});

describe('otherTabIds / tabIdsAfter', () => {
  it('lists the other tabs and the ones to the right, in order', () => {
    expect(otherTabIds(three, 'b')).toEqual(['a', 'c']);
    expect(tabIdsAfter(three, 'a')).toEqual(['b', 'c']);
    expect(tabIdsAfter(three, 'c')).toEqual([]);
  });

  it('has nothing to the right of a tab that is not open', () => {
    expect(tabIdsAfter(three, 'zzz')).toEqual([]);
  });
});

describe('selectTab', () => {
  it('returns the same state for an unknown or already active id', () => {
    expect(selectTab(three, 'zzz')).toBe(three);
    expect(selectTab(three, 'b')).toBe(three);
  });
});

describe('patchTabState', () => {
  it('merges over what other writers stored', () => {
    const next = patchTabState(three, 'b', { currentPage: 5 });
    expect(next.tabStates.b).toEqual({ viewMode: 'query', currentPage: 5 });
  });

  it('creates the entry for a tab without state', () => {
    expect(patchTabState(three, 'c', { isSearchOpen: true }).tabStates.c).toEqual({ isSearchOpen: true });
  });
});

describe('adjacentTabId', () => {
  it('steps and wraps around both ends', () => {
    expect(adjacentTabId(three, 1)).toBe('c');
    expect(adjacentTabId(three, -1)).toBe('a');
    expect(adjacentTabId({ ...three, activeTabId: 'c' }, 1)).toBe('a');
    expect(adjacentTabId({ ...three, activeTabId: 'a' }, -1)).toBe('c');
  });

  it('starts from the ends when nothing is active, and is null without tabs', () => {
    expect(adjacentTabId({ ...three, activeTabId: null }, 1)).toBe('a');
    expect(adjacentTabId({ ...three, activeTabId: null }, -1)).toBe('c');
    expect(adjacentTabId(EMPTY_WORKSPACE_TABS, 1)).toBeNull();
  });
});

describe('nthTabId', () => {
  it('is 1-based and null past the end', () => {
    expect(nthTabId(three, 1)).toBe('a');
    expect(nthTabId(three, 3)).toBe('c');
    expect(nthTabId(three, 4)).toBeNull();
  });
});

describe('restoreTabs', () => {
  const restored = [
    { tab: tab('r1'), state: { viewMode: 'query' as const } },
    { tab: tab('r2'), state: { currentPage: 3 } },
  ];

  it('appends the tabs with their state and activates the named one', () => {
    const next = restoreTabs(EMPTY_WORKSPACE_TABS, restored, '/data/r2.parquet');
    expect(next.tabs.map(t => t.id)).toEqual(['r1', 'r2']);
    expect(next.activeTabId).toBe('r2');
    expect(next.tabStates).toEqual({ r1: { viewMode: 'query' }, r2: { currentPage: 3 } });
  });

  it('falls back to the first restored tab when the active path is not among them', () => {
    expect(restoreTabs(EMPTY_WORKSPACE_TABS, restored, '/data/gone.parquet').activeTabId).toBe('r1');
    expect(restoreTabs(EMPTY_WORKSPACE_TABS, restored, null).activeTabId).toBe('r1');
    expect(restoreTabs(EMPTY_WORKSPACE_TABS, [], null)).toEqual(EMPTY_WORKSPACE_TABS);
  });

  it('keeps a tab the user opened meanwhile, with its state, and the active tab when none is named', () => {
    // The same file was dropped during the restore: its tab and state win.
    const next = restoreTabs(three, [...restored, { tab: tab('x', '/data/a.parquet'), state: { currentPage: 9 } }], null);
    expect(next.tabs.map(t => t.id)).toEqual(['a', 'b', 'c', 'r1', 'r2']);
    expect(next.activeTabId).toBe('b');
    expect(next.tabStates.a).toEqual({ currentPage: 2 });
    expect(next.tabStates.x).toBeUndefined();
  });
});

describe('restoreTabs under a limit', () => {
  const restored = ['r1', 'r2', 'r3', 'r4'].map(id => ({ tab: tab(id), state: {} }));

  it('takes the first tabs up to the limit, in order', () => {
    const next = restoreTabs(EMPTY_WORKSPACE_TABS, restored, '/data/r4.parquet', 3);
    expect(next.tabs.map(t => t.id)).toEqual(['r1', 'r2', 'r3']);
    // The named active tab was left out: the first restored one stands in.
    expect(next.activeTabId).toBe('r1');
  });

  it('counts the tabs already open, and a file open in both only once', () => {
    const next = restoreTabs(three, [{ tab: tab('x', '/data/a.parquet'), state: {} }, ...restored], null, 4);
    expect(next.tabs.map(t => t.id)).toEqual(['a', 'b', 'c', 'r1']);
  });
});

describe('sessionSnapshot', () => {
  it('lists the tabs in order with the persisted part of their state and the active path', () => {
    const state: WorkspaceTabs = {
      ...three,
      tabStates: {
        a: { currentPage: 2, activeFilter: 'x > 1', searchTerm: 'needle', selectedRow: 4, isSearchOpen: true, scrollPosition: 100 },
        b: { viewMode: 'query', activeFilter: '' },
      },
    };
    expect(sessionSnapshot(state)).toEqual({
      tabs: [
        { path: '/data/a.parquet', state: { view_mode: null, current_page: 2, active_filter: 'x > 1' } },
        { path: '/data/b.parquet', state: { view_mode: 'query', current_page: null, active_filter: null } },
        { path: '/data/c.parquet', state: { view_mode: null, current_page: null, active_filter: null } },
      ],
      active: '/data/b.parquet',
    });
  });

  it('is the same for changes that are not persisted', () => {
    const before = JSON.stringify(sessionSnapshot(three));
    const after = JSON.stringify(sessionSnapshot(patchTabState(three, 'a', { searchTerm: 'x', selectedRow: 1, scrollPosition: 50 })));
    expect(after).toBe(before);
    expect(sessionSnapshot(EMPTY_WORKSPACE_TABS)).toEqual({ tabs: [], active: null });
  });
});

describe('restoredTabState', () => {
  it('maps the saved fields back and leaves the rest to the tab', () => {
    expect(restoredTabState({ view_mode: 'query', current_page: 3, active_filter: 'x > 1' }))
      .toEqual({ viewMode: 'query', currentPage: 3, activeFilter: 'x > 1' });
    expect(restoredTabState({ view_mode: null, current_page: null, active_filter: null })).toEqual({});
  });

  it('drops values the store could not have meant', () => {
    expect(restoredTabState({ view_mode: 'chart', current_page: 0, active_filter: '' })).toEqual({});
    expect(restoredTabState({ view_mode: 'browse', current_page: 1.5, active_filter: null })).toEqual({ viewMode: 'browse' });
  });
});

describe('reduceWorkspaceTabs', () => {
  it('routes every action to its transition', () => {
    let state = reduceWorkspaceTabs(EMPTY_WORKSPACE_TABS, { type: 'open', tab: tab('a') });
    state = reduceWorkspaceTabs(state, { type: 'open', tab: tab('b') });
    state = reduceWorkspaceTabs(state, { type: 'patchState', tabId: 'a', patch: { currentPage: 4 } });
    state = reduceWorkspaceTabs(state, { type: 'select', tabId: 'a' });
    state = reduceWorkspaceTabs(state, { type: 'open', tab: tab('c') });
    state = reduceWorkspaceTabs(state, { type: 'close', tabId: 'b' });
    state = reduceWorkspaceTabs(state, { type: 'closeMany', tabIds: ['c'] });
    state = reduceWorkspaceTabs(state, { type: 'restore', tabs: [{ tab: tab('r'), state: { viewMode: 'query' } }], activePath: '/data/r.parquet' });
    expect(state).toEqual({ tabs: [tab('a'), tab('r')], activeTabId: 'r', tabStates: { a: { currentPage: 4 }, r: { viewMode: 'query' } } });
  });
});
