import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Database } from 'lucide-react';
import type { Tab } from '../../../contexts/WorkspaceContext';
import { DataViewer } from '../components/data-viewer';
import { QueryView } from '../../query/routes/query-view';
import { useAppCommand, type AppCommand } from '../../../lib/app-commands';

interface TabContentProps {
  tab: Tab;
  isActive: boolean;
  onClose: () => void;
  savedState?: TabState;
  onStateChange?: (state: TabState) => void;
}

/** What a tab shows: the browse grid or the SQL view. */
export type ViewMode = 'browse' | 'query';

export interface TabState {
  scrollPosition?: number;
  currentPage?: number;
  searchTerm?: string;
  viewMode?: ViewMode;
  activeFilter?: string;
  selectedRow?: number | null;
  isSearchOpen?: boolean;
}

export const TabContent: React.FC<TabContentProps> = React.memo(({
  tab,
  isActive,
  onClose,
  savedState,
  onStateChange
}) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasBeenActive, setHasBeenActive] = useState(false);

  // DataViewer is memoized, so hand it props that do not change identity when
  // this component re-renders (tab activation, state echoes from the
  // workspace). Otherwise every tab switch re-rendered the grid of the
  // outgoing and the incoming tab.
  const onCloseRef = useRef(onClose);
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onCloseRef.current = onClose;
    onStateChangeRef.current = onStateChange;
  });
  // The viewer only reads its initial state on mount.
  const [viewerInitialState] = useState(() => savedState);
  const handleClose = useCallback(() => onCloseRef.current(), []);
  // The workspace merges patches, so the viewer's fields go up as they are
  // and never carry a stale copy of the view mode with them.
  const handleViewerStateChange = useCallback((state: TabState) => {
    onStateChangeRef.current?.(state);
  }, []);

  // Local state if onStateChange is not provided (though it should be)
  const [localViewMode, setLocalViewMode] = useState<ViewMode>('browse');
  // The toolbar element DataViewer portals its actions into (see its
  // `toolbarSlot`); state, not a ref, so the viewer renders once it exists.
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);

  const viewMode = savedState?.viewMode || localViewMode;

  // Whether the browse grid is what the user is looking at. A ref rather
  // than a prop so the memoized viewer is not re-rendered on every tab
  // switch; it only consults this from event handlers.
  const browseIsActiveRef = useRef(false);
  browseIsActiveRef.current = isActive && viewMode === 'browse';

  // The SQL editor's counterpart, for ⌘↩ (see query-editor.tsx).
  const queryIsActiveRef = useRef(false);
  queryIsActiveRef.current = isActive && viewMode === 'query';

  const handleViewModeChange = (mode: ViewMode) => {
    setLocalViewMode(mode);
    onStateChange?.({ viewMode: mode });
  };

  // ⌘E, from the native menu or the workspace's keydown fallback: the
  // active tab flips between the grid and the SQL view.
  useAppCommand(useCallback((command: AppCommand) => {
    if (command === 'switch-view' && isActive) {
      const mode = viewMode === 'browse' ? 'query' : 'browse';
      setLocalViewMode(mode);
      onStateChange?.({ viewMode: mode });
    }
  }, [isActive, viewMode, onStateChange]));

  useEffect(() => {
    if (isActive && !hasBeenActive) {
      setHasBeenActive(true);
    }
  }, [isActive, hasBeenActive]);

  // Only render DataViewer if tab is active or has been active before
  // This lazy loads tabs when they're first accessed
  // Determine styles based on theme
  const containerBg = 'bg-white dark:bg-gray-900';
  const toolbarBg = 'bg-gray-50 border-gray-200 dark:bg-gray-900 dark:border-gray-800';

  const getButtonStyle = (mode: ViewMode) => {
    const isSelected = viewMode === mode;
    // dark:shadow-none because only the light selected state carries a shadow
    return isSelected
      ? 'bg-white text-slate-800 shadow-sm ring-1 ring-black/5 dark:bg-gray-800 dark:text-gray-200 dark:ring-white/10 dark:shadow-none'
      : 'text-slate-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800';
  };

  // Lazy load: only mount content once the tab has been activated
  if (!hasBeenActive) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={`flex flex-col ${containerBg}`}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: isActive ? 'flex' : 'none',
      }}
    >
      {/* View Switcher Toolbar */}
      <div className={`flex items-center gap-1 p-1 border-b ${toolbarBg}`}>
        <button
          onClick={() => handleViewModeChange('browse')}
          className={`
                    flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium transition-colors
                    ${getButtonStyle('browse')}
                `}
        >
          <Table size={14} />
          <span>{t('viewer.tabs.content')}</span>
        </button>
        <button
          onClick={() => handleViewModeChange('query')}
          className={`
                    flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium transition-colors
                    ${getButtonStyle('query')}
                `}
        >
          <Database size={14} />
          <span>{t('viewer.tabs.query')}</span>
        </button>
        {/* The browse view's row count, search, refresh and export land
            here, on the same row as the switch. Hidden with the browse view
            so the query view's toolbar is just the switch. */}
        <div
          ref={setToolbarSlot}
          className="ml-auto flex items-center gap-2 min-w-0 pr-1"
          style={{ display: viewMode === 'browse' ? 'flex' : 'none' }}
        />
      </div>


      <div className="flex-1 overflow-hidden relative">
        <div
          className="h-full w-full"
          style={{ display: viewMode === 'browse' ? 'block' : 'none' }}
        >
          <DataViewer
            filePath={tab.path}
            onClose={handleClose}
            initialState={viewerInitialState}
            onStateChange={handleViewerStateChange}
            isActiveRef={browseIsActiveRef}
            toolbarSlot={toolbarSlot}
          />
        </div>
        <div
          className="absolute inset-0 z-10 bg-slate-50 dark:bg-gray-900"
          style={{ display: viewMode === 'query' ? 'block' : 'none' }}
        >
          <QueryView filePath={tab.path} isActiveRef={queryIsActiveRef} />
        </div>
      </div>
    </div >
  );
}, (prevProps, nextProps) => {
  // Custom comparison to prevent unnecessary re-renders
  if (prevProps.isActive !== nextProps.isActive) return false;
  if (prevProps.tab.id !== nextProps.tab.id) return false;

  // Re-render if savedState changes (shallow comparison of objects is usually enough if immutable)
  if (prevProps.savedState !== nextProps.savedState) return false;

  return true; // Props are equal, skip re-render
});

TabContent.displayName = 'TabContent';