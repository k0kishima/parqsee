import React from 'react';
import { useTranslation } from 'react-i18next';
import { X, FileText } from 'lucide-react';
import type { Tab } from '../../../contexts/WorkspaceContext';

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
}

const TabBarComponent: React.FC<TabBarProps> = ({ tabs, activeTabId, onTabSelect, onTabClose }) => {
  const { t } = useTranslation();

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation(); // Prevent tab selection when closing
    onTabClose(tabId);
  };

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="flex items-end border-b bg-gray-50 border-gray-200 dark:bg-gray-900 dark:border-gray-700">
      <div className="flex overflow-x-auto scrollbar-thin">
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
    </div>
  );
};

// Memoize TabBar to prevent unnecessary re-renders
export const TabBar = React.memo(TabBarComponent, (prevProps, nextProps) => {
  // Deep comparison for tabs array
  if (prevProps.tabs.length !== nextProps.tabs.length) return false;
  if (prevProps.activeTabId !== nextProps.activeTabId) return false;

  // Check if tabs content changed
  for (let i = 0; i < prevProps.tabs.length; i++) {
    if (prevProps.tabs[i].id !== nextProps.tabs[i].id ||
      prevProps.tabs[i].name !== nextProps.tabs[i].name) {
      return false;
    }
  }

  return true;
});