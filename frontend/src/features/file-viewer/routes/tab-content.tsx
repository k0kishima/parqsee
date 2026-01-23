import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Database } from 'lucide-react';
import { useSettings } from '../../../contexts/SettingsContext';
import { DataViewer } from '../components/data-viewer';
import { QueryView } from '../../query/routes/query-view';

interface TabContentProps {
  tab: {
    id: string;
    path: string;
    name: string;
  };
  isActive: boolean;
  onClose: () => void;
  savedState?: TabState;
  onStateChange?: (state: TabState) => void;
}

export interface TabState {
  scrollPosition?: number;
  currentPage?: number;
  searchTerm?: string;
  viewMode?: 'browse' | 'query';
  // Add more state as needed
}

export const TabContent: React.FC<TabContentProps> = React.memo(({
  tab,
  isActive,
  onClose,
  savedState,
  onStateChange
}) => {
  const { t } = useTranslation();
  const { effectiveTheme } = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasBeenActive, setHasBeenActive] = useState(false);

  // Local state if onStateChange is not provided (though it should be)
  const [localViewMode, setLocalViewMode] = useState<'browse' | 'query'>('browse');

  const viewMode = savedState?.viewMode || localViewMode;

  const handleViewModeChange = (mode: 'browse' | 'query') => {
    setLocalViewMode(mode);
    if (onStateChange) {
      onStateChange({
        ...savedState,
        viewMode: mode
      });
    }
  };

  useEffect(() => {
    if (isActive && !hasBeenActive) {
      setHasBeenActive(true);
    }
  }, [isActive, hasBeenActive]);

  // Only render DataViewer if tab is active or has been active before
  // This lazy loads tabs when they're first accessed
  if (!isActive && !hasBeenActive) {
    return <div className="flex-1" />;
  }

  // Determine styles based on theme
  const containerBg = effectiveTheme === 'dark' ? 'bg-gray-900' : 'bg-white';
  const toolbarBg = effectiveTheme === 'dark' ? 'bg-gray-900 border-gray-800' : 'bg-gray-50 border-gray-200';

  const getButtonStyle = (mode: 'browse' | 'query') => {
    const isSelected = viewMode === mode;
    if (effectiveTheme === 'dark') {
      return isSelected
        ? 'bg-gray-800 text-gray-200 ring-1 ring-white/10'
        : 'text-gray-400 hover:bg-gray-800';
    } else {
      return isSelected
        ? 'bg-white text-slate-800 shadow-sm ring-1 ring-black/5'
        : 'text-slate-500 hover:bg-gray-100';
    }
  };

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
        // Enable hardware acceleration
        transform: 'translateZ(0)',
        willChange: isActive ? 'auto' : 'contents'
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
      </div>

      <div className="flex-1 overflow-hidden relative">
        <div
          className="h-full w-full"
          style={{ display: viewMode === 'browse' ? 'block' : 'none' }}
        >
          <DataViewer
            filePath={tab.path}
            onClose={onClose}
          />
        </div>
        <div
          className={`absolute inset-0 z-10 ${effectiveTheme === 'dark' ? 'bg-gray-900' : 'bg-slate-50'}`}
          style={{ display: viewMode === 'query' ? 'block' : 'none' }}
        >
          <QueryView filePath={tab.path} />
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison to prevent unnecessary re-renders
  if (prevProps.isActive !== nextProps.isActive) return false;
  if (prevProps.tab.id !== nextProps.tab.id) return false;
  if (prevProps.tab.path !== nextProps.tab.path) return false;

  // Check if viewMode changed in savedState
  const prevViewMode = prevProps.savedState?.viewMode;
  const nextViewMode = nextProps.savedState?.viewMode;
  if (prevViewMode !== nextViewMode) return false;

  return true; // Props are equal, skip re-render
});

TabContent.displayName = 'TabContent';