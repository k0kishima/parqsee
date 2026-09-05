import React from 'react';
import { useTranslation } from 'react-i18next';
import { X, FileText } from 'lucide-react';
import type { Tab } from '../../../contexts/WorkspaceContext';
import { SidebarToggle, HeaderActions, TOP_ROW_HEIGHT } from './header-controls';

interface TabBarProps {
  tabs: readonly Tab[];
  activeTabId: string | null;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  /**
   * The tab bar is the window's top row: the sidebar toggle sits at its
   * left end and Open File / Open Folder / Settings at its right, where the
   * header (shown while no tab is open) has them. Only the tabs scroll.
   */
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenSettings: () => void;
}

const TabBarComponent: React.FC<TabBarProps> = ({ tabs, activeTabId, onTabSelect, onTabClose, isSidebarOpen, onToggleSidebar, onOpenFile, onOpenFolder, onOpenSettings }) => {
  const { t } = useTranslation();

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation(); // Prevent tab selection when closing
    onTabClose(tabId);
  };

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className={`flex items-stretch border-b bg-gray-50 border-gray-200 dark:bg-gray-900 dark:border-gray-700 ${TOP_ROW_HEIGHT}`}>
      <div className="flex items-center px-2">
        <SidebarToggle isOpen={isSidebarOpen} onToggle={onToggleSidebar} />
      </div>
      <div className="flex items-end overflow-x-auto scrollbar-thin flex-1 min-w-0">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => onTabSelect(tab.id)}
              className={`
                group flex items-center gap-2 px-3 py-2 border-t border-l border-r cursor-pointer
                min-w-[120px] max-w-[200px] transition-all
                ${isActive
                  ? 'bg-white border-gray-200 border-b-white dark:bg-gray-800 dark:border-gray-600 dark:border-b-gray-800'
                  : 'bg-gray-100 border-gray-200 hover:bg-gray-50 dark:bg-gray-800/50 dark:border-gray-700 dark:hover:bg-gray-800/70'
                }
                ${isActive ? 'relative top-[1px]' : ''}
              `}
            >
              <FileText className={`w-4 h-4 flex-shrink-0 ${isActive
                ? 'text-green-500'
                : 'text-gray-500 dark:text-gray-400'
                }`} />

              <span className={`
                flex-1 text-sm truncate
                ${isActive
                  ? 'text-gray-900 font-medium dark:text-gray-100'
                  : 'text-gray-600 dark:text-gray-300'
                }
              `} title={tab.path}>
                {tab.name}
              </span>

              <button
                onClick={(e) => handleCloseTab(e, tab.id)}
                className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                title={t('common.closeTab')}
              >
                <X className="w-3 h-3 text-gray-500 dark:text-gray-400" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center px-2">
        <HeaderActions onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} onOpenSettings={onOpenSettings} />
      </div>
    </div>
  );
};

// Memoize TabBar to prevent unnecessary re-renders
export const TabBar = React.memo(TabBarComponent, (prevProps, nextProps) => {
  // Equal when the tab list reads the same and the handlers are the same —
  // skipping the handlers kept a stale onTabClose alive across renders.
  return (
    prevProps.activeTabId === nextProps.activeTabId &&
    prevProps.onTabSelect === nextProps.onTabSelect &&
    prevProps.onTabClose === nextProps.onTabClose &&
    prevProps.isSidebarOpen === nextProps.isSidebarOpen &&
    prevProps.onToggleSidebar === nextProps.onToggleSidebar &&
    prevProps.onOpenFile === nextProps.onOpenFile &&
    prevProps.onOpenFolder === nextProps.onOpenFolder &&
    prevProps.onOpenSettings === nextProps.onOpenSettings &&
    prevProps.tabs.length === nextProps.tabs.length &&
    prevProps.tabs.every((tab, i) => tab.id === nextProps.tabs[i].id && tab.name === nextProps.tabs[i].name)
  );
});